import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount, usePublicClient, useSignMessage, useWriteContract } from "wagmi";
import { parseUnits, parseEventLogs, type Address } from "viem";
import { CONTRACTS, STANDARD, CHAIN } from "../config";
import { factoryAbi, factoryV2Abi } from "../abis";
import { STOCK_ROUTES, basketPath } from "../lib/stockRoutes";
import { STOCK_CATEGORIES, type Stock } from "../lib/mock";
import { grindC0de } from "../lib/c0de";
import { ANCHORS, anchorByKey, curveLaunchParams } from "../lib/anchors";
import { putMetadata } from "../lib/metadata";
import { prepareImage, uploadImage, isHostedUrl } from "../lib/upload";
import { useWalletConnect } from "../census";
import { AssetLogo, StockLogo } from "../components/StockLogo";

// Designer's 5-step launch wizard (Company → Anchors → Economics → Identity → Review), with an
// explicit Prima/Maxima choice up front. Full-page shell (census-wizard), on-chain launch preserved.
type Tier = "v1" | "v2";
const STEPS = ["Company", "Anchors", "Economics", "Identity", "Review"];
const SLUGS = ["company", "anchors", "economics", "identity", "review"];
const MAX_BASKET = 4;
const ZERO_SALT = ("0x" + "00".repeat(32)) as `0x${string}`;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const DRAFT_KEY = "census:launch-draft";
const FEE_PCT = 2; // CensusRouter takes a flat 2% trade fee on every trade
const PROTOCOL_PCT = 25; // platform share of the fee; the other 75% is the creator side (PROTOCOL_BPS = 2500)
const GRADS = [
  { eth: 2, label: "Fast graduation", mcap: "$30k" },
  { eth: 4, label: "Standard", mcap: "$60k" },
  { eth: 8, label: "High conviction", mcap: "$120k" },
];

// Routable tokenised-stock universe (for the Maxima basket), with a stable per-ticker identity colour.
const UNIVERSE = STOCK_CATEGORIES.flatMap((c) => c.stocks.map((s) => ({ ...s, sector: c.label })))
  .filter((s) => !!STOCK_ROUTES[s.ticker]);
const SECTORS = ["All", ...Array.from(new Set(UNIVERSE.map((u) => u.sector)))];
const deriveTicker = (name: string) => name.replace(/[^a-zA-Z]/g, "").slice(0, 5).toUpperCase();
const usd = (v: number) => `$${v.toFixed(2)}`;

type Draft = {
  tier: Tier; name: string; thesis: string; description: string;
  quoteKey: string; picks: string[]; weights: Record<string, number>;
  graduationEth: number; holdersBps: number; image: string; ticker: string; ipfsConsent: boolean;
};
// holdersBps: share of the 2% fee's 75% creator side that goes to holders (0 = you only, 10000 = holders
// only, in-between = both). Maxima defaults to all-holders; Prima is always creator-only on-chain.
const EMPTY: Draft = { tier: "v1", name: "", thesis: "", description: "", quoteKey: "ETH", picks: [], weights: {}, graduationEth: 4, holdersBps: 10000, image: "", ticker: "", ipfsConsent: false };

function loadDraft(): Draft {
  try { const raw = localStorage.getItem(DRAFT_KEY); if (raw) return { ...EMPTY, ...JSON.parse(raw) }; } catch { /* ignore */ }
  return EMPTY;
}

export function Launch() {
  const nav = useNavigate();
  const { isConnected, address } = useAccount();
  const { connect, connecting, error: connectError, ensureChain } = useWalletConnect();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();
  const { signMessageAsync } = useSignMessage();

  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [status, setStatus] = useState("");
  const [launchPct, setLaunchPct] = useState<number | null>(null); // 0..100 while launching; null when idle
  const [reserved, setReserved] = useState<{ salt: `0x${string}`; address: Address } | null>(null);
  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  // Persist the draft (this is what "Save & exit" resumes from).
  useEffect(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore */ } }, [draft]);

  const tier = draft.tier;
  const isV2 = tier === "v2";
  const anchor = anchorByKey(draft.quoteKey);
  // Maxima always pays holders a stock basket; the anchor (ETH or HOOD) is just the quote the fee arrives
  // in — the vault swaps it into the basket either way (HOOD routes via USDG). See lib/stockRoutes.basketPath.
  const usesBasket = isV2;
  const ticker = (draft.ticker || deriveTicker(draft.name)) || "—";

  // Basket weights: raw stored, displayed as percentages that always sum to EXACTLY 100 (largest
  // remainder), so the basket never reads 101%. Adjusted with discrete +/- steppers (no fiddly slider).
  const picks = draft.picks;
  const weightOf = (t: string) => draft.weights[t] ?? 25;
  const pctMap: Record<string, number> = (() => {
    if (!picks.length) return {};
    const raw = picks.map(weightOf);
    const total = raw.reduce((a, b) => a + b, 0) || 1;
    const exact = raw.map((w) => (w / total) * 100);
    const pct = exact.map(Math.floor);
    const rem = 100 - pct.reduce((a, b) => a + b, 0);
    const order = exact.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
    for (let k = 0; k < rem && order.length; k++) pct[order[k % order.length].i]++;
    return Object.fromEntries(picks.map((t, i) => [t, pct[i]]));
  })();
  const pctOf = (t: string) => pctMap[t] ?? 0;
  // Set one pick to EXACTLY `p`% and rebalance the others proportionally so the basket always reads 100%
  // (largest-remainder keeps it integer-exact). Used by both the steppers and the typable field — one
  // model, so what you type is what shows.
  const setPct = (t: string, p: number) => {
    const target = Math.max(0, Math.min(100, Math.round(p || 0)));
    const others = picks.filter((x: string) => x !== t);
    if (!others.length) { set({ weights: { ...draft.weights, [t]: 100 } }); return; }
    const rem = 100 - target;
    const cur = others.map((x: string) => pctMap[x] ?? 0);
    const curSum = cur.reduce((a: number, b: number) => a + b, 0);
    const exact = cur.map((v: number) => (curSum > 0 ? (v / curSum) * rem : rem / others.length));
    const floors = exact.map(Math.floor);
    const leftover = rem - floors.reduce((a: number, b: number) => a + b, 0);
    const order = exact.map((v: number, idx: number) => ({ idx, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
    for (let k = 0; k < leftover && order.length; k++) floors[order[k % order.length].idx]++;
    const next: Record<string, number> = { ...draft.weights, [t]: target };
    others.forEach((x: string, idx: number) => { next[x] = floors[idx]; });
    set({ weights: next });
  };

  // Grind the reserved …c0de address once we reach Identity and have a name + ticker.
  const grindKey = `${draft.name}|${ticker}|${isV2}`;
  const lastGrind = useRef("");
  useEffect(() => {
    if (step < 3 || !draft.name.trim() || ticker === "—") return;
    if (lastGrind.current === grindKey) return;
    lastGrind.current = grindKey;
    const factoryAddr = isV2 ? CONTRACTS.factoryV2 : CONTRACTS.factory;
    if (factoryAddr === ZERO_ADDR) return;
    let cancelled = false;
    (async () => {
      try {
        const g = await grindC0de({ name: draft.name.trim(), symbol: ticker, totalSupply: parseUnits(String(STANDARD.totalSupply), STANDARD.decimals), decimals: STANDARD.decimals, factory: factoryAddr });
        if (!cancelled) setReserved({ salt: g.salt, address: g.address });
      } catch { if (!cancelled) setReserved(null); }
    })();
    return () => { cancelled = true; };
  }, [step, grindKey, isV2]);

  // ---- per-step validation + dock hint ----
  const nameOk = draft.name.trim().length >= 2;
  const thesisOk = draft.thesis.trim().length >= 3;
  const valid = [
    nameOk && thesisOk,                                                       // Company
    usesBasket ? picks.length >= 1 : true,                                    // Anchors
    true,                                                                     // Economics
    draft.ipfsConsent,                                                        // Identity
    true,                                                                     // Review
  ];
  const hint = [
    valid[0] ? "Anchors next." : !nameOk ? "Add a company name to continue." : "Add a one-line thesis to continue.",
    usesBasket ? (picks.length ? `${picks.join(" · ")} — economics next.` : "Anchor at least one stock to continue.") : `Anchored to ${draft.quoteKey} — economics next.`,
    `Fee ${FEE_PCT.toFixed(2)}% · graduates at ~${draft.graduationEth} ETH`,
    draft.ipfsConsent ? "Review next." : "Accept the moderation terms to continue.",
    "Everything looks right? Launch it.",
  ][step];
  const ctaLabel = ["Continue to Anchors", "Continue to Economics", "Continue to Identity", "Review launch", isConnected ? `Launch $${ticker}` : connecting ? "Connecting…" : "Connect wallet"][step];

  const toggleStock = (t: string) => {
    if (picks.includes(t)) set({ picks: picks.filter((x) => x !== t) });
    else if (picks.length < MAX_BASKET) set({ picks: [...picks, t], weights: { ...draft.weights, [t]: draft.weights[t] ?? 25 } });
  };

  async function onContinue() {
    if (!valid[step]) return;
    if (step < 4) { setStep(step + 1); return; }
    if (!isConnected) { await connectWallet(); return; }
    await launch();
  }

  // Shared connect flow (opens the wallet first, then switches chain) — see useWalletConnect. Any
  // failure is surfaced loudly in the status banner rather than failing silently.
  async function connectWallet() {
    setStatus("");
    const { ok, error } = await connect();
    if (!ok) setStatus(error || "Couldn't connect — make sure your wallet is unlocked.");
  }

  async function launch() {
    setStatus("");
    if (!publicClient) { setStatus("no wallet client"); return; }
    const factoryAddr = isV2 ? CONTRACTS.factoryV2 : CONTRACTS.factory;
    if (factoryAddr === ZERO_ADDR) { setStatus(`${isV2 ? "Maxima" : "Prima"} factory not deployed yet (preview)`); return; }

    const nm = draft.name.trim();
    const sym = ticker;
    const totalSupply = parseUnits(String(STANDARD.totalSupply), STANDARD.decimals);

    // Maxima basket: holders receive the chosen stocks regardless of the anchor. The vault swaps the fee
    // (which arrives in the coin's quote asset) into each stock via `basketPath` — WETH routes for an
    // ETH-quoted coin, HOOD->USDG->stock routes for a HOOD-quoted one. A stock that IS the quote is a
    // passthrough ("0x"). See lib/stockRoutes.basketPath.
    let basket: Address[] = [], paths: `0x${string}`[] = [], weights: number[] = [];
    if (usesBasket) {
      basket = picks.map((t) => STOCK_ROUTES[t].address);
      paths = picks.map((t) => basketPath(anchor.quote, t));
      const raw = picks.map((t) => weightOf(t));
      const sum = raw.reduce((a, b) => a + b, 0) || 1;
      weights = raw.map((w) => Math.round((w / sum) * 10000));
      weights[0] += 10000 - weights.reduce((a, b) => a + b, 0); // fix rounding to exactly 10000
    }

    try {
      // A single green progress bar carries the whole launch (grind → confirm → mine → publish), instead
      // of the raw attempt counter. The c0de grind is probabilistic (~65k tries), so we map attempts onto
      // the first ~65% and let the on-chain phases fill the rest.
      setStatus("reserving your …c0de address…");
      setLaunchPct(4);
      let salt: `0x${string}` = reserved?.salt ?? ZERO_SALT;
      if (reserved) {
        setLaunchPct(68);
      } else {
        try {
          const g = await grindC0de({ name: nm, symbol: sym, totalSupply, decimals: STANDARD.decimals, factory: factoryAddr },
            { onProgress: (n) => setLaunchPct(Math.min(66, 6 + Math.round((n / 65536) * 60))) });
          salt = g.salt;
          setLaunchPct(68);
        } catch { /* grind unavailable — fall back to a plain (non-c0de) deploy with the zero salt */ }
      }

      // CensusCurve launch params: the coin's whole supply seeds a bonding curve priced in `quote`.
      // virtualQuote = starting FDV, graduationQuote = the reserve to raise before graduating to a pool.
      setStatus("pricing the curve…");
      setLaunchPct(72);
      let cp;
      try { cp = await curveLaunchParams(publicClient, anchor, draft.graduationEth); }
      catch { setStatus(`couldn't price against ${anchor.key} — try ETH or retry`); setLaunchPct(null); return; }
      const quote = cp.quote;
      const params = { name: nm, symbol: sym, totalSupply, decimals: 18, poolFee: 10000, virtualQuote: cp.virtualQuote, graduationQuote: cp.graduationQuote };

      // Make sure the wallet is on Robinhood Chain first — otherwise the launch tx goes to whatever
      // network the wallet is on (e.g. Ethereum mainnet, asking for real gas) and fails.
      if (!(await ensureChain())) { setStatus(`Switch your wallet to ${CHAIN.name}, then launch.`); setLaunchPct(null); return; }
      setStatus("confirm in wallet…");
      setLaunchPct(80);

      let token: Address | undefined;
      if (isV2) {
        const hash = await writeContractAsync({ chainId: CHAIN.id, address: CONTRACTS.factoryV2, abi: factoryV2Abi, functionName: "createLaunch", args: [params, basket, weights, paths, salt, quote, draft.holdersBps, [] as Address[]] });
        setStatus("launching…"); setLaunchPct(90);
        const rc = await publicClient.waitForTransactionReceipt({ hash });
        token = (parseEventLogs({ abi: factoryV2Abi, eventName: "LaunchedV2", logs: rc.logs })[0] as any)?.args?.token;
      } else {
        const hash = await writeContractAsync({ chainId: CHAIN.id, address: CONTRACTS.factory, abi: factoryAbi, functionName: "createLaunch", args: [params, salt, quote, [] as Address[]] });
        setStatus("launching…"); setLaunchPct(90);
        const rc = await publicClient.waitForTransactionReceipt({ hash });
        token = (parseEventLogs({ abi: factoryAbi, eventName: "Launched", logs: rc.logs })[0] as any)?.args?.token;
      }
      if (token) {
        setStatus("publishing details…");
        setLaunchPct(97);
        // Persist a hosted logo URL only; a local-only data-URL preview would overflow the store's URL
        // field, so we skip it (the logo simply isn't saved until blob hosting is provisioned).
        const savedImage = isHostedUrl(draft.image.trim()) ? draft.image.trim() : "";
        // The store only accepts creator-signed writes; skipping the signature just means the
        // description isn't persisted — the launch itself already succeeded.
        await putMetadata(token, CHAIN.id, { name: nm, thesis: draft.thesis.trim(), description: draft.description.trim(), image: savedImage }, signMessageAsync);
        setLaunchPct(100);
        try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
        nav(`/coin/${token}`);
      } else {
        setLaunchPct(null);
      }
    } catch (e: any) { setStatus(e?.shortMessage ?? e?.message ?? String(e)); setLaunchPct(null); }
  }

  return (
    <div className="census-body census-body--wizard census-wizard">
      <header className="census-wizard__header">
        {/* No `background` here — the class paints the chrome gradient onto the text (background-clip),
            so overriding background makes the wordmark invisible. Only reset the button chrome. */}
        <button className="census-wordmark-serif" onClick={() => nav("/")} style={{ appearance: "none", border: 0, cursor: "pointer", padding: 0 }} aria-label="Census home">Census</button>
        <nav className="census-steprail" aria-label="Launch steps">
          {STEPS.map((label, i, all) => (
            <span key={label} style={{ display: "inline-flex", alignItems: "center" }}>
              <button
                onClick={() => i < step && setStep(i)}
                className={"census-steprail__step" + (i === step ? " census-steprail__step--active" : i < step ? " census-steprail__step--done" : "")}
                style={{ background: "none", border: 0, cursor: i < step ? "pointer" : "default", font: "inherit" }}
              >{label}</button>
              {i < all.length - 1 && <span style={{ color: "var(--census-text-muted)" }}>·</span>}
            </span>
          ))}
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {isConnected && address ? (
            <span className="census-mono" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--census-text-secondary)" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--census-lime)" }} />
              {address.slice(0, 6)}…{address.slice(-4)}
            </span>
          ) : (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              {connectError && <span className="census-mono" style={{ fontSize: 11.5, color: "#e06c60", maxWidth: 230, textAlign: "right", lineHeight: 1.25 }}>{connectError}</span>}
              <button className="census-chip" onClick={connectWallet} style={{ cursor: "pointer", whiteSpace: "nowrap" }}>{connecting ? "Connecting…" : "Connect wallet"}</button>
            </span>
          )}
          <button onClick={() => nav("/home")} style={{ color: "var(--census-text-secondary)", fontSize: 14, background: "none", border: 0, cursor: "pointer" }}>Save &amp; exit</button>
        </div>
      </header>

      <div className="census-wizard__body">
        <main>
          {step === 0 && <CompanyStep draft={draft} set={set} ticker={ticker} />}
          {step === 1 && <AnchorsStep draft={draft} set={set} usesBasket={usesBasket} picks={picks} pctOf={pctOf} setPct={setPct} toggleStock={toggleStock} />}
          {step === 2 && <EconomicsStep draft={draft} set={set} isV2={isV2} usesBasket={usesBasket} />}
          {step === 3 && <IdentityStep draft={draft} set={set} ticker={ticker} reserved={reserved} />}
          {step === 4 && <ReviewStep draft={draft} ticker={ticker} isV2={isV2} usesBasket={usesBasket} picks={picks} pctOf={pctOf} onEdit={setStep} status={status} />}
        </main>
        <aside className="census-wizard__aside">
          <Preview draft={draft} ticker={ticker} isV2={isV2} usesBasket={usesBasket} picks={picks} pctOf={pctOf} reserved={reserved} />
        </aside>
      </div>

      <div className="census-dock">
        <div className="census-dock__inner">
          <div style={{ flex: "none" }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Step {step + 1} of 5</div>
            <span className="census-mono" style={{ fontSize: 12, color: "var(--census-text-secondary)" }}>{SLUGS[step]}</span>
          </div>
          {launchPct != null ? (
            <div className="census-dock__hint" style={{ display: "flex", flexDirection: "column", gap: 6, justifyContent: "center" }}>
              <span style={{ fontSize: 12, color: "var(--census-text-secondary)" }}>{status || "launching…"} · {launchPct}%</span>
              <span style={{ display: "block", height: 6, borderRadius: 4, background: "var(--census-track)", overflow: "hidden" }}>
                <i style={{ display: "block", height: "100%", width: `${launchPct}%`, background: "linear-gradient(90deg,var(--census-lime-shade),var(--census-lime))", transition: "width .35s ease" }} />
              </span>
            </div>
          ) : (
            <div className={"census-dock__hint" + (!valid[step] ? " census-dock__hint--blocking" : "")}>{status || hint}</div>
          )}
          <button className="census-btn" disabled={!valid[step] || isPending} onClick={onContinue}>
            {isPending ? "launching…" : ctaLabel} <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- steps ---------------- */

function CompanyStep({ draft, set, ticker }: any) {
  return (
    <>
      <h1 className="census-wizard__title">Start a company.</h1>
      <p className="census-wizard__subtitle">Name it, say what it is, and pick how it launches.</p>

      <div className="census-field-label">Launch type</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 26 }}>
        {([["v1", "Prima", "Anchor to ETH or HOOD. A clean coin, live from block one."], ["v2", "Maxima", "Holders earn a real tokenised-stock dividend basket from fees."]] as const).map(([t, name, desc]) => (
          <button key={t} onClick={() => set({ tier: t })}
            className={"census-card" + (draft.tier === t ? " census-card--selected" : "")}
            style={{ textAlign: "left", cursor: "pointer", color: "var(--census-text)" }}>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{name} {draft.tier === t && <span className="census-dot">.</span>}</div>
            <div style={{ fontSize: 13, color: "var(--census-text-secondary)", marginTop: 6 }}>{desc}</div>
          </button>
        ))}
      </div>

      <div className="census-field-label">Company name</div>
      <input className="census-input" value={draft.name} maxLength={42} onChange={(e) => set({ name: e.target.value })} placeholder="Iron Man Industries" />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7 }}>
        <span style={{ fontSize: 12, color: "var(--census-text-muted)" }}>Ticker auto-derives to <span className="census-mono" style={{ color: "var(--census-lime)" }}>${ticker}</span> — editable at Identity.</span>
        <span className="census-counter">{draft.name.length}/42</span>
      </div>

      <div className="census-field-label" style={{ marginTop: 24 }}>One-line thesis</div>
      <input className="census-input" value={draft.thesis} maxLength={80} onChange={(e) => set({ thesis: e.target.value })} placeholder="The arc reactor of on-chain energy." />
      <div style={{ textAlign: "right", marginTop: 7 }}><span className="census-counter">{draft.thesis.length}/80</span></div>

      <div className="census-field-label" style={{ marginTop: 24 }}>Description <span style={{ color: "var(--census-text-muted)", fontWeight: 400 }}>(optional)</span></div>
      <textarea className="census-input" value={draft.description} rows={4} maxLength={2000} onChange={(e) => set({ description: e.target.value })} placeholder="What is it, who's it for, why now." style={{ resize: "vertical" }} />
    </>
  );
}

function QuotePicker({ draft, set }: any) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {ANCHORS.map((a) => (
        <button key={a.key} className="census-chip" aria-pressed={draft.quoteKey === a.key} onClick={() => set({ quoteKey: a.key })}
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <AssetLogo src={a.logo} label={a.key} size={18} radius={5} />
          {a.label} ({a.key})
        </button>
      ))}
    </div>
  );
}

// Typable weight: reads as plain lime text (no visible box), but click it and type a number. Commits on
// blur / Enter; the parent rebalances the rest so the basket stays exactly 100%.
function WeightInput({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [buf, setBuf] = useState<string | null>(null);
  const shown = buf ?? String(value);
  return (
    <span className="census-mono" style={{ display: "inline-flex", alignItems: "center", justifyContent: "flex-end", color: "var(--census-lime)", fontSize: 14, minWidth: 38 }}>
      <input
        value={shown}
        inputMode="numeric"
        aria-label="weight percent"
        onFocus={(e) => { setBuf(String(value)); e.currentTarget.select(); }}
        onChange={(e) => setBuf(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
        onBlur={() => { if (buf !== null) { onCommit(Number(buf || 0)); setBuf(null); } }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Return") (e.target as HTMLInputElement).blur(); }}
        style={{ width: `${Math.max(1, shown.length)}ch`, background: "transparent", border: 0, outline: "none", padding: 0, margin: 0, color: "inherit", font: "inherit", textAlign: "right", appearance: "textfield" as any }}
      />
      <span style={{ opacity: 0.85 }}>%</span>
    </span>
  );
}

function AnchorsStep({ draft, set, usesBasket, picks, pctOf, setPct, toggleStock }: any) {
  const [query, setQuery] = useState("");
  const [sector, setSector] = useState("All");
  const full = picks.length >= MAX_BASKET;
  const results = UNIVERSE
    .filter((u) => sector === "All" || u.sector === sector)
    .filter((u) => { const q = query.trim().toLowerCase(); return !q || u.ticker.toLowerCase().includes(q) || u.name.toLowerCase().includes(q); })
    .slice(0, 12);

  return (
    <>
      <h1 className="census-wizard__title">What is it anchored to?</h1>
      <p className="census-wizard__subtitle">{usesBasket ? "Pick the pairing asset, then up to four stocks holders receive as dividends." : "Choose the asset your coin is paired against."}</p>

      <div className="census-field-label">Anchored to</div>
      <QuotePicker draft={draft} set={set} />
      {usesBasket && draft.quoteKey !== "ETH" && (
        <div style={{ marginTop: 12, fontSize: 13, color: "var(--census-text-muted)" }}>
          Priced against {draft.quoteKey}. Holders still earn the stock basket below — the {draft.quoteKey} fee is swapped into it automatically.
        </div>
      )}

      {usesBasket && (<>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "30px 0 12px" }}>
          <div className="census-field-label" style={{ margin: 0 }}>Dividend basket</div>
          <span className="census-mono" style={{ fontSize: 12, color: full ? "var(--census-lime)" : "var(--census-text-muted)" }}>{picks.length}/4 selected</span>
        </div>

        {picks.length === 0 ? (
          <div style={{ border: "1px dashed rgba(242,245,241,0.18)", borderRadius: "var(--census-radius-input)", padding: "34px 20px", textAlign: "center" }}>
            <div style={{ fontSize: 15, color: "var(--census-text-secondary)" }}>Nothing anchored yet</div>
            <div style={{ fontSize: 13, color: "var(--census-text-muted)", marginTop: 6 }}>Choose a stock below to start the basket.</div>
          </div>
        ) : (
          <div className="census-card" style={{ padding: 0, overflow: "hidden" }}>
            {picks.map((t: string, i: number) => {
              const meta = UNIVERSE.find((u) => u.ticker === t);
              return (
                <div key={t} style={{ display: "grid", gridTemplateColumns: "34px minmax(0,1.4fr) minmax(0,1fr) 120px 30px", alignItems: "center", gap: 14, padding: "14px 18px", borderTop: i === 0 ? 0 : "1px solid var(--census-hairline)" }}>
                  <StockLogo ticker={t} size={34} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontWeight: 600, fontSize: 14 }}>{t}</span>
                    <span style={{ display: "block", fontSize: 12, color: "var(--census-text-secondary)" }}>{meta?.name}</span>
                  </span>
                  <span className="census-bar" style={{ display: "block" }}><i className="census-bar__fill" style={{ width: `${pctOf(t)}%` }} /></span>
                  <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
                    <button className="census-btn-ghost" aria-label={`decrease ${t}`} onClick={() => setPct(t, pctOf(t) - 5)} style={{ width: 26, height: 26, padding: 0, borderRadius: 7, fontSize: 16, lineHeight: 1 }}>−</button>
                    <WeightInput value={pctOf(t)} onCommit={(n: number) => setPct(t, n)} />
                    <button className="census-btn-ghost" aria-label={`increase ${t}`} onClick={() => setPct(t, pctOf(t) + 5)} style={{ width: 26, height: 26, padding: 0, borderRadius: 7, fontSize: 16, lineHeight: 1 }}>+</button>
                  </span>
                  <button className="census-btn-ghost" aria-label={`remove ${t}`} onClick={() => toggleStock(t)} style={{ width: 30, height: 30, padding: 0, borderRadius: 8, fontSize: 15 }}>×</button>
                </div>
              );
            })}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "13px 18px", borderTop: "1px solid var(--census-hairline)", background: "rgba(180,240,61,0.03)" }}>
              <span style={{ fontSize: 13, color: "var(--census-text-secondary)" }}>Weights normalise to 100% at launch</span>
              <span style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <button className="census-btn-ghost" onClick={() => set({ weights: Object.fromEntries(picks.map((t: string) => [t, 25])) })}>Split evenly</button>
                <span className="census-mono" style={{ fontSize: 13 }}>Total 100%</span>
              </span>
            </div>
          </div>
        )}

        <div className="census-field-label" style={{ marginTop: 30 }}>Available on-chain</div>
        <input className="census-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search ticker or company — NVDA, Tesla, gold…" />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
          {SECTORS.map((s) => <button key={s} className="census-chip" aria-pressed={s === sector} onClick={() => setSector(s)}>{s}</button>)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 10, marginTop: 16 }}>
          {results.map((u) => {
            const on = picks.includes(u.ticker); const blocked = !on && full;
            return (
              <button key={u.ticker} className={"census-card" + (on ? " census-card--selected" : "")} onClick={() => toggleStock(u.ticker)} disabled={blocked}
                style={{ display: "flex", alignItems: "center", gap: 11, textAlign: "left", padding: "12px 13px", color: "var(--census-text)", cursor: blocked ? "not-allowed" : "pointer", opacity: blocked ? 0.45 : 1 }}>
                <StockLogo ticker={u.ticker} size={30} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontWeight: 600, fontSize: 13.5 }}>{u.ticker}</span>
                  <span style={{ display: "block", fontSize: 11.5, color: "var(--census-text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{u.name}</span>
                </span>
                <span className="census-mono" style={{ fontSize: 12, color: on ? "var(--census-lime)" : "var(--census-text-muted)" }}>{on ? "✓" : "+"}</span>
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: 12, fontSize: 13, color: "var(--census-text-muted)" }}>Stocks with stablecoin-only liquidity are reached automatically by routing the swap.</div>
      </>)}
    </>
  );
}

function EconomicsStep({ draft, set, isV2, usesBasket }: any) {
  const fee = 1000 * (FEE_PCT / 100);          // $20 on $1,000
  const protocol = fee * (PROTOCOL_PCT / 100); // $5 platform
  const creatorSide = fee - protocol;          // $15
  const holdersBps = isV2 ? draft.holdersBps : 0;
  const holdersPct = Math.round(holdersBps / 100);
  const toHolders = (creatorSide * holdersBps) / 10000;
  const toCreator = creatorSide - toHolders;
  const PRESETS: [string, number][] = [["Holders", 10000], ["Split", 5000], ["You", 0]];
  return (
    <>
      <h1 className="census-wizard__title">Who gets the fees?</h1>
      <p className="census-wizard__subtitle">Every trade pays a {FEE_PCT.toFixed(2)}% fee. You decide how your share is split.</p>

      <div className="census-field-label">Trade fee</div>
      <div className="census-card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 16 }}>Fixed at <span className="census-mono" style={{ color: "var(--census-lime)" }}>{FEE_PCT.toFixed(2)}%</span> per trade</div>
          <div style={{ fontSize: 13, color: "var(--census-text-secondary)", marginTop: 4 }}>Taken on every trade through Census. Same for every company.</div>
        </div>
      </div>

      {/* Explicit control — the creator side (75%) goes to holders, you, or both (Maxima only). */}
      {isV2 ? (<>
        <div className="census-field-label" style={{ marginTop: 30 }}>Your share goes to</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          {PRESETS.map(([label, bps]) => {
            const active = label === "Split" ? draft.holdersBps > 0 && draft.holdersBps < 10000 : draft.holdersBps === bps;
            return <button key={label} className="census-chip" aria-pressed={active} onClick={() => set({ holdersBps: bps })}>{label}</button>;
          })}
        </div>
        <div className="census-card" style={{ padding: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
            <div style={{ fontSize: 15, display: "inline-flex", alignItems: "baseline", gap: 6 }}>Holders <WeightInput value={holdersPct} onCommit={(n: number) => set({ holdersBps: Math.max(0, Math.min(100, n)) * 100 })} /></div>
            <div style={{ fontSize: 15, color: "var(--census-text-secondary)", display: "inline-flex", alignItems: "baseline", gap: 6 }}>You <WeightInput value={100 - holdersPct} onCommit={(n: number) => set({ holdersBps: (100 - Math.max(0, Math.min(100, n))) * 100 })} /></div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button className="census-btn-ghost" aria-label="less to holders" onClick={() => set({ holdersBps: Math.max(0, draft.holdersBps - 500) })} style={{ width: 30, height: 30, padding: 0, borderRadius: 8, fontSize: 16, lineHeight: 1 }}>−</button>
            <div style={{ flex: 1, height: 10, borderRadius: 6, background: "var(--census-track)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${holdersPct}%`, background: "linear-gradient(90deg,var(--census-lime-shade),var(--census-lime))" }} />
            </div>
            <button className="census-btn-ghost" aria-label="more to holders" onClick={() => set({ holdersBps: Math.min(10000, draft.holdersBps + 500) })} style={{ width: 30, height: 30, padding: 0, borderRadius: 8, fontSize: 16, lineHeight: 1 }}>+</button>
          </div>
          <div style={{ fontSize: 13, color: "var(--census-text-muted)", marginTop: 10 }}>Holders earn {usesBasket ? "the stock basket" : draft.quoteKey}; you keep the rest.</div>
        </div>
      </>) : (
        <div className="census-panel" style={{ marginTop: 30 }}>
          As the creator, you earn from the 2% fee. Switch to Maxima to reward your holders instead, or split it.
        </div>
      )}

      <div className="census-field-label" style={{ marginTop: 30 }}>On every $1,000 traded</div>
      <div className="census-card" style={{ display: "grid", gap: 10 }}>
        <FeeRow label="Fee collected" value={usd(fee)} />
        {isV2 && toHolders > 0 && <FeeRow label="To holders (dividends)" value={usd(toHolders)} accent />}
        <FeeRow label="To you (creator)" value={usd(toCreator)} accent={!isV2} />
        <FeeRow label="To platform" value={usd(protocol)} />
      </div>

      <div className="census-field-label" style={{ marginTop: 30 }}>Graduation target</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
        {GRADS.map((t) => {
          const on = t.eth === draft.graduationEth;
          return (
            <button key={t.eth} className={"census-card" + (on ? " census-card--selected" : "")} onClick={() => set({ graduationEth: t.eth })} style={{ textAlign: "left", color: "var(--census-text)", cursor: "pointer" }}>
              <span className="census-mono" style={{ fontSize: 17, fontWeight: 500, color: on ? "var(--census-lime)" : "var(--census-text)" }}>{t.eth} ETH</span>
              <div style={{ fontSize: 13, color: "var(--census-text-secondary)", marginTop: 5 }}>{t.label}</div>
              <span className="census-mono" style={{ fontSize: 12, color: "var(--census-text-muted)", marginTop: 3, display: "block" }}>≈ {t.mcap} mcap</span>
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: 10, fontSize: 13, color: "var(--census-text-muted)" }}>At the target the bonding curve graduates{isV2 ? " and dividends switch on" : ""} — a milestone; liquidity stays locked.</div>
    </>
  );
}

// Drag-and-drop (or click / paste) logo field. Shows the image the instant it's dropped (downscaled
// data URL), then best-effort uploads it for a persistent hosted URL. If the image store isn't
// provisioned the upload no-ops and we keep the local preview — the coin still launches.
function LogoDrop({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const handleFile = async (file?: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setNote("That's not an image file."); return; }
    setNote(""); setBusy(true);
    try {
      const dataUrl = await prepareImage(file);
      onChange(dataUrl); // instant preview
      const hosted = await uploadImage(dataUrl);
      if (hosted) { onChange(hosted); setNote(""); }
      else setNote("Shown here now — logo hosting turns on when the store is connected.");
    } catch {
      setNote("Couldn't read that image — try a PNG or JPG.");
    } finally {
      setBusy(false);
    }
  };

  if (value) {
    return (
      <div className="census-card" style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <img src={value} alt="" style={{ width: 52, height: 52, borderRadius: 12, objectFit: "cover", flex: "0 0 auto" }} onError={(e) => ((e.target as HTMLImageElement).style.opacity = "0.2")} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, color: "var(--census-text)" }}>{busy ? "Uploading…" : isHostedUrl(value) ? "Logo set" : "Logo ready"}</div>
          <div style={{ fontSize: 12, color: "var(--census-text-muted)" }}>{note || (isHostedUrl(value) ? "Hosted and saved with your coin." : "Preview")}</div>
        </div>
        <div style={{ display: "flex", gap: 8, flex: "0 0 auto" }}>
          <button className="census-btn-ghost" onClick={() => inputRef.current?.click()}>Replace</button>
          <button className="census-btn-ghost" onClick={() => { onChange(""); setNote(""); }} aria-label="remove logo">Remove</button>
        </div>
        <input ref={inputRef} type="file" accept="image/*" hidden onChange={(e) => handleFile(e.target.files?.[0])} />
      </div>
    );
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputRef.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); handleFile(e.dataTransfer.files?.[0]); }}
        style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6,
          padding: "26px 20px", borderRadius: 14, cursor: "pointer", textAlign: "center",
          border: `1.5px dashed ${drag ? "var(--census-lime)" : "var(--census-hairline)"}`,
          background: drag ? "rgba(180,240,61,0.06)" : "transparent", transition: "border-color .12s, background .12s",
        }}
      >
        <span style={{ fontSize: 20, opacity: 0.5 }} aria-hidden="true">⤒</span>
        <span style={{ fontSize: 14, color: "var(--census-text)" }}>{busy ? "Reading image…" : <>Drag an image here, or <span style={{ color: "var(--census-lime)" }}>browse</span></>}</span>
        <span style={{ fontSize: 12, color: "var(--census-text-muted)" }}>PNG, JPG or WebP · square works best</span>
        <input ref={inputRef} type="file" accept="image/*" hidden onChange={(e) => handleFile(e.target.files?.[0])} />
      </div>
      {note && <div style={{ fontSize: 12, color: "var(--census-text-muted)", marginTop: 8 }}>{note}</div>}
    </>
  );
}

function IdentityStep({ draft, set, ticker, reserved }: any) {
  return (
    <>
      <h1 className="census-wizard__title">Identity.</h1>
      <p className="census-wizard__subtitle">Your logo, ticker, and the address we've reserved for it.</p>

      <div className="census-field-label">Logo <span style={{ color: "var(--census-text-muted)", fontWeight: 400 }}>(optional)</span></div>
      <LogoDrop value={draft.image} onChange={(v: string) => set({ image: v })} />

      <div className="census-field-label" style={{ marginTop: 24 }}>Ticker</div>
      <input className="census-input census-mono" value={draft.ticker || ticker} maxLength={11} onChange={(e) => set({ ticker: e.target.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase() })} placeholder="IRON" style={{ maxWidth: 220 }} />

      <div className="census-field-label" style={{ marginTop: 24 }}>Reserved address</div>
      <div className="census-card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className="census-mono" style={{ fontSize: 14, color: "var(--census-text)", wordBreak: "break-all" }}>
          {reserved ? <>{reserved.address.slice(0, -4)}<span className="census-dot" style={{ color: "var(--census-lime)" }}>c0de</span></> : "grinding a …c0de address…"}
        </span>
      </div>
      <div style={{ fontSize: 13, color: "var(--census-text-muted)", marginTop: 8 }}>Every Census token address ends in <span className="census-mono" style={{ color: "var(--census-lime)" }}>c0de</span>. Held for you until you launch.</div>

      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 26, cursor: "pointer" }}>
        <input type="checkbox" checked={draft.ipfsConsent} onChange={(e) => set({ ipfsConsent: e.target.checked })} style={{ marginTop: 3, accentColor: "var(--census-lime)" }} />
        <span style={{ fontSize: 13, color: "var(--census-text-secondary)" }}>I understand launch details and images are public and subject to moderation.</span>
      </label>
    </>
  );
}

function ReviewStep({ draft, ticker, isV2, usesBasket, picks, pctOf, onEdit, status }: any) {
  const Group = ({ title, editStep, children }: any) => (
    <div className="census-card" style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div className="census-field-label" style={{ margin: 0 }}>{title}</div>
        <button className="census-btn-ghost" onClick={() => onEdit(editStep)}>Edit</button>
      </div>
      {children}
    </div>
  );
  const Row = ({ k, v, accent }: any) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13 }}>
      <span style={{ color: "var(--census-text-secondary)" }}>{k}</span>
      <span className="census-mono" style={{ color: accent ? "var(--census-lime)" : "var(--census-text)" }}>{v}</span>
    </div>
  );
  return (
    <>
      <h1 className="census-wizard__title">Review &amp; launch.</h1>
      <p className="census-wizard__subtitle">Whole supply seeds a single-sided pool, locked forever. Trading from block one.</p>

      <Group title="Company" editStep={0}>
        <Row k="Name" v={draft.name || "—"} /><Row k="Ticker" v={`$${ticker}`} accent /><Row k="Type" v={isV2 ? "Maxima" : "Prima"} />
        <div style={{ fontSize: 13, color: "var(--census-text-secondary)", marginTop: 8 }}>{draft.thesis}</div>
      </Group>
      <Group title="Anchors" editStep={1}>
        <Row k="Anchored to" v={draft.quoteKey} accent />
        {isV2 && (usesBasket ? picks.map((t: string) => <Row key={t} k={t} v={`${pctOf(t)}%`} />) : <Row k="Holders earn" v={draft.quoteKey} />)}
      </Group>
      <Group title="Economics" editStep={2}>
        <Row k="Trade fee" v={`${FEE_PCT.toFixed(2)}%`} />
        <Row k="Fees" v={isV2 ? `holders ${Math.round(draft.holdersBps / 100)}% · you ${100 - Math.round(draft.holdersBps / 100)}%` : "all to you"} accent />
        <Row k="Graduation" v={`~${draft.graduationEth} ETH`} />
      </Group>
      {status && <div className="census-panel" style={{ color: "var(--census-text-secondary)", fontSize: 13 }}>{status}</div>}
    </>
  );
}

/* ---------------- sticky preview ---------------- */

function Preview({ draft, ticker, isV2, usesBasket, picks, pctOf, reserved }: any) {
  return (
    <div className="census-panel" style={{ position: "sticky", top: "var(--census-space-6)" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        {draft.image
          ? <img src={draft.image} alt="" style={{ width: 50, height: 50, borderRadius: 10, objectFit: "cover" }} onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
          : <div style={{ width: 50, height: 50, borderRadius: 10, background: "var(--census-chrome-tile)", display: "grid", placeItems: "center", fontFamily: "var(--census-font-serif)", fontWeight: 600, fontSize: 22, color: "#0c130f" }}>{(draft.name[0] || "C").toUpperCase()}</div>}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 17 }}>{draft.name || "Your company"}</div>
          <div className="census-mono" style={{ color: "var(--census-lime)", fontSize: 13 }}>${ticker}</div>
        </div>
      </div>
      {draft.thesis && <div style={{ fontSize: 14, color: "var(--census-text-secondary)", marginBottom: 16 }}>{draft.thesis}</div>}
      <div className="census-divider" style={{ marginBottom: 12 }} />
      <div style={{ display: "grid", gap: 9 }}>
        <PvRow k="Type" v={isV2 ? "Maxima" : "Prima"} accent />
        <PvRow k="Anchored to" v={<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><AssetLogo src={anchorByKey(draft.quoteKey).logo} label={draft.quoteKey} size={16} radius={4} />{draft.quoteKey}</span>} />
        {isV2 && <PvRow k="Holders earn" v={usesBasket ? (picks.length ? picks.map((t: string) => `${t} ${pctOf(t)}%`).join(", ") : "—") : draft.quoteKey} />}
        <PvRow k="Trade fee" v={`${FEE_PCT.toFixed(2)}%`} />
        <PvRow k="Graduation" v={`~${draft.graduationEth} ETH`} />
        <PvRow k="Liquidity" v="Locked forever" accent />
        {reserved && <PvRow k="Address" v={`…${reserved.address.slice(-8)}`} />}
      </div>
    </div>
  );
}

function PvRow({ k, v, accent }: any) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
      <span style={{ color: "var(--census-text-secondary)", flex: "none" }}>{k}</span>
      <span className="census-mono" style={{ color: accent ? "var(--census-lime)" : "var(--census-text)", textAlign: "right" }}>{v}</span>
    </div>
  );
}

function FeeRow({ label, value, accent }: any) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13, color: "var(--census-text-secondary)" }}>
      <span>{label}</span>
      <span className="census-mono" style={{ fontWeight: 500, color: accent ? "var(--census-lime)" : "var(--census-text)" }}>{value}</span>
    </div>
  );
}
