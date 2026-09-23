import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAccount, usePublicClient, useSignMessage, useWriteContract } from "wagmi";
import { isAddress, parseUnits, parseEventLogs, zeroAddress, type Address, type Hex } from "viem";
import { CONTRACTS, STANDARD, CHAIN, EXPLORER, TRADE_FEE_LABEL, TRADE_FEE_BPS, REFLECTION_OPTIONS, MAX_REWARD_BASKET, REHEARSAL, REHEARSAL_GRADUATION_ETH, pctLabel, feeBreakdown, feeSplit } from "../config";
import { factoryV4Abi } from "../abis";
import { STOCK_ROUTES } from "../lib/stockRoutes";
import { basketPathFor } from "../lib/basket";
import { useAllowedRewardAssets, isAllowedRewardAsset } from "../lib/rewards";
import { useLaunches } from "../lib/useLaunches";
import { stripConfusables, coinNameWarning, type NameWarning } from "../lib/names";
import { useCurveStats } from "../lib/useCurveStats";
import { STOCK_CATEGORIES } from "../lib/stocks";
import { grindC0de } from "../lib/c0de";
import { ANCHORS, anchorByKey, anchorAvailable, isCoinKey, curveLaunchParams, ethUsdPrice, graduationFdvEth, ETH_USD_FALLBACK, type Anchor } from "../lib/anchors";
import { putMetadata, type CoinMetadata } from "../lib/metadata";
import { prepareImage, uploadImage, isHostedUrl } from "../lib/upload";
import { useWalletConnect, CxAvatar, fmtUsd } from "../census";
import { AssetLogo, StockLogo } from "../components/StockLogo";

// Designer's 5-step launch wizard (Company → Anchors → Economics → Identity → Review), with an explicit
// Prima/Maxima choice up front. Both launch through LaunchFactoryV4 with the same economics (2% base fee,
// optional 1-4% holder reflection paid into a reward basket); the tier is the product framing (meme coin
// vs company coin) and sets the reflection default. Full-page shell (census-wizard); the step lives in
// the URL (/create, /create/anchors, …) so Back/Forward and refresh keep your place. The draft autosaves.
type Tier = "v1" | "v2";
const STEPS = ["Company", "Anchors", "Economics", "Identity", "Review"];
const SLUGS = ["company", "anchors", "economics", "identity", "review"];
const MAX_BASKET = MAX_REWARD_BASKET; // CensusRewardVault.MAX_BASKET = 3
// Reward-basket picks are keyed by stock ticker, or QUOTE_KEY for the pairing asset (the anchor's quote
// address). Rewards are only ever paid in quoted assets — the coin itself is never a basket entry.
const QUOTE_KEY = "__quote";
const isSpecialPick = (k: string) => k === QUOTE_KEY;
const ZERO_SALT = ("0x" + "00".repeat(32)) as Hex;
const DRAFT_KEY = "census:launch-draft";
// Graduation targets by launch type. Prima (meme) coins always graduate at 4 ETH; Maxima (company) coins
// choose 4 or 8. The 2 ETH "fast graduation" option was retired at mainnet launch (2026-09-23); older
// drafts that still carry it are snapped back to 4 in loadDraft / on tier change / at launch.
const GRADS: Record<Tier, { eth: number; label: string }[]> = {
  v1: [{ eth: 4, label: "Standard" }],
  v2: [{ eth: 4, label: "Standard" }, { eth: 8, label: "High conviction" }],
};
const DEFAULT_GRAD = 4;
const isTier = (t: unknown): t is Tier => t === "v1" || t === "v2";
// Rehearsal builds (VITE_REHEARSAL_GRADUATION_ETH, side deployment on a throwaway stack) add a tiny target
// to both tiers so the whole lifecycle can be exercised on mainnet for cents. Never set in production.
const gradsFor = (tier: Tier) => (REHEARSAL ? [...GRADS[tier], { eth: REHEARSAL_GRADUATION_ETH, label: "Rehearsal" }] : GRADS[tier]);
const gradAllowed = (tier: Tier, eth: number) => gradsFor(tier).some((g) => g.eth === eth);
const gradFor = (tier: Tier, eth: number) => (gradAllowed(tier, eth) ? eth : DEFAULT_GRAD);

// Routable tokenised-stock universe for the reward basket. The picker further narrows it to the stocks
// allow-listed on CensusCurveV4 (useAllowedRewardAssets) — the factory rejects anything else.
const UNIVERSE = STOCK_CATEGORIES.flatMap((c) => c.stocks.map((s) => ({ ...s, sector: c.label })))
  .filter((s) => !!STOCK_ROUTES[s.ticker]);
const stockAddress = (ticker: string) => STOCK_ROUTES[ticker]?.address ?? "";
const deriveTicker = (name: string) => name.replace(/[^a-zA-Z]/g, "").slice(0, 5).toUpperCase();
const usd = (v: number) => `$${v.toFixed(2)}`;
const usdK = (v: number) => `$${Math.round(v / 1000)}k`;
// Graduation targets are set in ETH terms; a non-ETH anchor's target is converted at launch.
const gradLabel = (eth: number, anchorKey: string) => (anchorKey === "ETH" ? `~${eth} ETH` : `~${eth} ETH in ${anchorKey}`);

type Draft = {
  tier: Tier; name: string; thesis: string; description: string;
  quoteKey: string; picks: string[]; weights: Record<string, number>;
  graduationEth: number; reflectionBps: number; image: string; ticker: string; publicConsent: boolean;
  quoteSymbol: string; // cached symbol when quoteKey is a company coin's address
};
type Setter = (p: Partial<Draft>) => void;
// reflectionBps: the holder reflection charged ON TOP of the 2% base fee on every buy and sell — 0 (off)
// or 100..400 — paid into the launch's reward basket. Frozen at launch. Maxima defaults to 2%, Prima to off.
const DEFAULT_REFLECTION: Record<Tier, number> = { v1: 0, v2: 200 };
const EMPTY: Draft = { tier: "v1", name: "", thesis: "", description: "", quoteKey: "ETH", picks: [], weights: {}, graduationEth: 4, reflectionBps: 0, image: "", ticker: "", publicConsent: false, quoteSymbol: "" };

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const { ipfsConsent, holdersBps, ...saved } = JSON.parse(raw); // older drafts: consent under another name, and the retired holdersBps model
      const d: Draft = { ...EMPTY, ...saved, publicConsent: !!(saved.publicConsent ?? ipfsConsent) };
      if (!isTier(d.tier)) d.tier = "v1";
      d.graduationEth = gradFor(d.tier, Number(d.graduationEth)); // retired targets (2 ETH) and Maxima-only ones on a Prima draft
      if (!anchorAvailable(anchorByKey(d.quoteKey))) { d.quoteKey = "ETH"; d.quoteSymbol = ""; }
      if (!(REFLECTION_OPTIONS as readonly number[]).includes(d.reflectionBps)) d.reflectionBps = holdersBps != null ? DEFAULT_REFLECTION[d.tier] ?? 0 : 0;
      // Older drafts may hold the retired "this coin" pick; it (and any unroutable ticker) is dropped here,
      // and stocks that are no longer allow-listed are pruned once the allow-list loads (see Launch).
      d.picks = (Array.isArray(d.picks) ? d.picks : []).filter((k: string) => isSpecialPick(k) || !!STOCK_ROUTES[k]).slice(0, MAX_BASKET);
      return d;
    }
  } catch { /* ignore a corrupt draft */ }
  return EMPTY;
}

export function Launch() {
  const nav = useNavigate();
  const loc = useLocation();
  const { isConnected, address } = useAccount();
  const { connect, signUp, connecting, pending, error: connectError, ensureChain } = useWalletConnect();
  const publicClient = usePublicClient({ chainId: CHAIN.id });
  const { writeContractAsync, isPending } = useWriteContract();
  const { signMessageAsync } = useSignMessage();

  const [draft, setDraft] = useState<Draft>(loadDraft);
  // A launch whose signed details write failed: the coin exists, the details don't yet. Offer a retry
  // (or go to the coin and save later) instead of dropping them.
  const [pendingMeta, setPendingMeta] = useState<{ token: Address; meta: CoinMetadata } | null>(null);
  const [status, setStatus] = useState("");
  const [launchPct, setLaunchPct] = useState<number | null>(null); // 0..100 while launching; null when idle
  // `creator` is stored so a salt grinded for one wallet is never reused when signing with another —
  // the on-chain address is bound to the creator (CX-F1), so a mismatch would deploy off-address.
  const [reserved, setReserved] = useState<{ salt: Hex; address: Address; creator: Address } | null>(null);
  const [ethUsd, setEthUsd] = useState(ETH_USD_FALLBACK);
  const set: Setter = (p) => setDraft((d) => ({ ...d, ...p }));

  // Persist the draft (this is what "Save & exit" resumes from).
  useEffect(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore */ } }, [draft]);
  // A company-coin page can open the wizard with its coin preselected as the anchor (?anchor=0x…&symbol=X).
  useEffect(() => {
    const p = new URLSearchParams(loc.search);
    const a = p.get("anchor");
    if (a && isAddress(a)) set({ quoteKey: a, quoteSymbol: p.get("symbol") ?? "" });
  }, [loc.search]); // eslint-disable-line react-hooks/exhaustive-deps
  // Live ETH price for the market-cap estimates (falls back to the calibration constant on testnet).
  useEffect(() => { if (publicClient) ethUsdPrice(publicClient).then(setEthUsd).catch(() => {}); }, [publicClient]);

  const tier = draft.tier;
  const isV2 = tier === "v2";
  const anchor = anchorByKey(draft.quoteKey, draft.quoteSymbol);
  // Reflection on => the launch gets a reward vault and a basket (the pairing asset and/or allow-listed
  // tokenised stocks — never this coin). The anchor is the asset the fee arrives in; the vault turns it
  // into the basket.
  const usesBasket = draft.reflectionBps > 0;
  // The curve's reward-asset allow-list (null while loading). A stock pick that isn't in it would make
  // the factory revert `AssetNotAllowed`, so such picks are pruned from the draft as soon as we know.
  const { allowed: allowedAssets, error: allowedError } = useAllowedRewardAssets();
  useEffect(() => {
    if (!allowedAssets) return;
    const keep = draft.picks.filter((k) => isSpecialPick(k) || isAllowedRewardAsset(allowedAssets, stockAddress(k)));
    if (keep.length !== draft.picks.length) set({ picks: keep });
  }, [allowedAssets, draft.picks]); // eslint-disable-line react-hooks/exhaustive-deps
  const ticker = (draft.ticker || deriveTicker(draft.name)) || "—";
  const factoryAddr = CONTRACTS.factoryV4; // one factory for both tiers; also the CREATE2 deployer for the …c0de grind
  // CX-P2: warn (non-blocking) if the name/ticker duplicates an existing Census coin or impersonates a
  // real company. useLaunches is module-cached, so this shares AnchorStep's scan.
  const { coins: existingCoins } = useLaunches();
  const nameWarning: NameWarning = coinNameWarning(draft.name, ticker === "—" ? "" : ticker, existingCoins);
  const hasFactory = factoryAddr !== zeroAddress;

  // Basket weights: raw stored, displayed as percentages that always sum to EXACTLY 100 (largest
  // remainder), so the basket never reads 101%.
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
    const others = picks.filter((x) => x !== t);
    if (!others.length) { set({ weights: { ...draft.weights, [t]: 100 } }); return; }
    const rem = 100 - target;
    const cur = others.map((x) => pctMap[x] ?? 0);
    const curSum = cur.reduce((a, b) => a + b, 0);
    const exact = cur.map((v) => (curSum > 0 ? (v / curSum) * rem : rem / others.length));
    const floors = exact.map(Math.floor);
    const leftover = rem - floors.reduce((a, b) => a + b, 0);
    const order = exact.map((v, idx) => ({ idx, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
    for (let k = 0; k < leftover && order.length; k++) floors[order[k % order.length].idx]++;
    const next: Record<string, number> = { ...draft.weights, [t]: target };
    others.forEach((x, idx) => { next[x] = floors[idx]; });
    set({ weights: next });
  };

  // ---- per-step validation, and the step itself (from the URL, clamped to what's valid so far) ----
  const nameOk = draft.name.trim().length >= 2;
  const thesisOk = draft.thesis.trim().length >= 3;
  const valid = [
    nameOk && thesisOk,                       // Company
    true,                                     // Anchors
    usesBasket ? picks.length >= 1 : true,    // Economics (a reflection needs at least one basket asset)
    draft.publicConsent,                      // Identity
    true,                                     // Review
  ];
  const firstBlocked = valid.findIndex((v) => !v);
  const maxStep = firstBlocked === -1 ? STEPS.length - 1 : firstBlocked;
  const urlStep = Math.max(0, SLUGS.indexOf(loc.pathname.split("/")[2] ?? ""));
  const step = Math.min(urlStep, maxStep);
  const pathFor = (i: number) => (i === 0 ? "/create" : `/create/${SLUGS[i]}`);
  const goTo = (i: number) => nav(pathFor(i));
  useEffect(() => { if (urlStep !== step) nav(pathFor(step), { replace: true }); }, [urlStep, step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Grind the reserved …c0de address once we reach Identity and have a name + ticker. A changed
  // name/ticker means a different address, so the old one is dropped immediately (never shown, never
  // launched with) while the new grind runs.
  // The address depends on the connected wallet, so the grind key includes it and a wallet change re-grinds.
  const grindKey = `${draft.name}|${ticker}|${address ?? ""}`;
  const lastGrind = useRef("");
  useEffect(() => {
    if (step < 3 || !draft.name.trim() || ticker === "—" || !address) return;
    if (lastGrind.current === grindKey) return;
    lastGrind.current = grindKey;
    setReserved(null);
    if (!hasFactory) return;
    let cancelled = false;
    const creator = address;
    (async () => {
      try {
        const g = await grindC0de({ name: draft.name.trim(), symbol: ticker, totalSupply: parseUnits(String(STANDARD.totalSupply), STANDARD.decimals), decimals: STANDARD.decimals, factory: factoryAddr, creator });
        if (!cancelled) setReserved({ salt: g.salt, address: g.address, creator });
      } catch { if (!cancelled) setReserved(null); }
    })();
    return () => { cancelled = true; };
  }, [step, grindKey, factoryAddr, hasFactory, address]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickLabel = (k: string) => (k === QUOTE_KEY ? anchor.key : k);
  const totalFeeBps = TRADE_FEE_BPS + draft.reflectionBps;
  const hint = [
    valid[0] ? "Anchors next." : !nameOk ? "Add a company name to continue." : "Add a one-line thesis to continue.",
    `Anchored to ${anchor.key} — economics next.`,
    usesBasket && !picks.length ? "Pick at least one reward asset, or turn the reflection off." : `Fee ${pctLabel(totalFeeBps)}${usesBasket ? ` · rewards ${picks.map(pickLabel).join(" · ")}` : ""} · graduates at ${gradLabel(draft.graduationEth, anchor.key)}`,
    draft.publicConsent ? "Review next." : "Accept the moderation terms to continue.",
    isConnected || !signUp ? "Everything looks right? Launch it." : "Everything looks right? Connect a wallet, or sign up above, to launch.",
  ][step];
  const ctaLabel = ["Continue to Anchors", "Continue to Economics", "Continue to Identity", "Review launch", isConnected ? `Launch ${ticker}` : pending === "wallet" ? "Connecting…" : "Connect wallet"][step];
  const launching = launchPct != null || isPending;

  const togglePick = (t: string) => {
    if (picks.includes(t)) set({ picks: picks.filter((x) => x !== t) });
    else if (picks.length < MAX_BASKET) set({ picks: [...picks, t], weights: { ...draft.weights, [t]: draft.weights[t] ?? 25 } });
  };

  async function onContinue() {
    if (!valid[step] || launching) return;
    if (step < STEPS.length - 1) { goTo(step + 1); return; }
    if (!isConnected) { await connectWallet(); return; }
    await launch();
  }

  // Shared connect flow (opens the wallet first, then switches chain) — see useWalletConnect. Any
  // failure is surfaced in the status banner rather than failing silently.
  async function connectWallet() {
    setStatus("");
    const { ok, error } = await connect();
    if (!ok && error) setStatus(error);
  }

  async function signUpHere() {
    if (!signUp) return;
    setStatus("");
    const { ok, error } = await signUp();
    if (!ok && error) setStatus(error);
  }

  async function launch() {
    setStatus("");
    if (!publicClient) { setStatus("Couldn't reach the network — reload and try again."); return; }
    if (!hasFactory) { setStatus("Launches aren't enabled on this network yet."); return; }

    const nm = draft.name.trim();
    const sym = ticker;
    const totalSupply = parseUnits(String(STANDARD.totalSupply), STANDARD.decimals);

    // Reward basket (reflection on): up to three QUOTED assets. The pairing asset is the anchor's quote,
    // credited directly (path 0x). A tokenised stock must be allow-listed on the curve (the factory
    // reverts `AssetNotAllowed` otherwise) and is reached by the vault via a V3 route from the anchor
    // (lib/basket.ts). The coin itself is never a reward. Weights are the displayed percentages (largest
    // remainder, exactly 100) in bps, so they sum to exactly 10000. Frozen at launch.
    let basket: Address[] = [], paths: Hex[] = [], weights: number[] = [];
    if (usesBasket) {
      if (!picks.length) { setStatus("Pick at least one reward asset, or turn the reflection off."); return; }
      if (!allowedAssets) { setStatus("Still checking which stocks are listed for rewards — try again in a moment."); return; }
      const unlisted = picks.find((k) => !isSpecialPick(k) && !isAllowedRewardAsset(allowedAssets, stockAddress(k)));
      if (unlisted) { setStatus(`${unlisted} isn't listed for rewards — remove it from the basket.`); return; }
      try {
        basket = picks.map((k) => (k === QUOTE_KEY ? anchor.quote : STOCK_ROUTES[k].address));
        paths = picks.map((k) => (isSpecialPick(k) ? ("0x" as Hex) : basketPathFor(anchor.quote, k)));
      } catch (e: any) { setStatus(e?.message ?? "This anchor can't be routed into a stock basket."); return; }
      weights = picks.map((k) => pctOf(k) * 100);
      if (weights.reduce((a, b) => a + b, 0) !== 10000 || weights.some((w) => w <= 0)) { setStatus("Basket weights must add up to 100% with every asset above 0%."); return; }
    }

    let hash: Hex | undefined;
    try {
      // A single green progress bar carries the whole launch (grind → price → confirm → mine → publish).
      // The c0de grind is probabilistic (~65k tries), so attempts map onto the first ~65% and the on-chain
      // phases fill the rest.
      setStatus("reserving your …c0de address…");
      setLaunchPct(4);
      // Reuse the previewed salt only if it was grinded for the wallet that's about to sign; otherwise
      // grind fresh bound to the current creator. A salt from another wallet would deploy off-address.
      let salt: Hex = ZERO_SALT;
      if (reserved && address && reserved.creator === address) {
        salt = reserved.salt;
        setLaunchPct(68);
      } else if (address) {
        try {
          const g = await grindC0de({ name: nm, symbol: sym, totalSupply, decimals: STANDARD.decimals, factory: factoryAddr, creator: address },
            { onProgress: (n) => setLaunchPct(Math.min(66, 6 + Math.round((n / 65536) * 60))) });
          salt = g.salt;
          setLaunchPct(68);
        } catch { /* grind unavailable — fall back to a plain (non-c0de) deploy with the zero salt */ }
      }

      // CensusCurve launch params: the coin's whole supply seeds a bonding curve priced in the anchor.
      // virtualQuote = starting FDV, graduationQuote = the reserve to raise before graduating to a pool.
      // On Robinhood Chain FIRST: the wallet may sit on another network, and the pricing reads below (and the
      // launch tx) must run against Robinhood Chain. Public clients are pinned to CHAIN.id everywhere for the
      // same reason (a wallet on the wrong chain used to make ETH pricing fail with "couldn't price against ETH").
      if (!(await ensureChain())) { setStatus(`Switch your wallet to ${CHAIN.name}, then launch.`); setLaunchPct(null); return; }
      setStatus("pricing the curve…");
      setLaunchPct(72);
      let cp;
      try { cp = await curveLaunchParams(publicClient, anchor, gradFor(draft.tier, draft.graduationEth)); }
      catch { setStatus(`Couldn't price against ${anchor.key} — try ETH, or retry.`); setLaunchPct(null); return; }
      const params = { name: nm, symbol: sym, totalSupply, decimals: STANDARD.decimals, virtualQuote: cp.virtualQuote, graduationQuote: cp.graduationQuote };

      setStatus("confirm in wallet…");
      setLaunchPct(80);

      // One factory for both tiers. No basket / reflection 0 => no vault (the factory requires the basket
      // to be empty in that case). Empty `exemptBuyers`: no launch-bundle anti-snipe exemptions.
      hash = await writeContractAsync({ chainId: CHAIN.id, address: factoryAddr, abi: factoryV4Abi, functionName: "createLaunch", args: [params, basket, weights, paths, salt, cp.quote, draft.reflectionBps, []] });
      setStatus("launching…"); setLaunchPct(90);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      const token: Address | undefined = parseEventLogs({ abi: factoryV4Abi, eventName: "LaunchedV4", logs: rc.logs })[0]?.args.token;
      if (!token) {
        setLaunchPct(null);
        setStatus(`The transaction went through but the launch event wasn't found in its receipt.${EXPLORER ? ` Check it on the explorer: ${EXPLORER}/tx/${hash}` : ""}`);
        return;
      }
      setStatus("sign to publish the details…");
      setLaunchPct(97);
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      // The store only accepts creator-signed writes. Persist a hosted logo URL only (a data-URL preview
      // would overflow the store's URL field). A failed or declined save is surfaced with a retry, and
      // the payload is kept locally so the coin page can save it later — the launch itself is done.
      const savedImage = isHostedUrl(draft.image.trim()) ? draft.image.trim() : "";
      const meta: CoinMetadata = { name: nm, thesis: draft.thesis.trim(), description: draft.description.trim(), image: savedImage };
      const saved = await putMetadata(token, CHAIN.id, meta, signMessageAsync);
      if (!saved.ok) {
        setStatus(`Launched! The details weren't saved (${saved.reason}).${saved.retryable ? " Retry, or open the coin and save them later." : ""}`);
        setPendingMeta({ token, meta });
        setLaunchPct(null);
        return;
      }
      setLaunchPct(100);
      nav(`/coin/${token}`, { state: { metaSaved: true } });
    } catch (e: any) {
      const raw = String(e?.shortMessage ?? e?.message ?? e);
      setStatus(/reject|denied|cancel/i.test(raw) ? "Cancelled in your wallet." : raw.slice(0, 160));
      setLaunchPct(null);
    }
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
                onClick={() => i < step && goTo(i)}
                disabled={i > step}
                aria-current={i === step ? "step" : undefined}
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
              {signUp && <button className="census-chip" onClick={signUpHere} disabled={connecting} style={{ cursor: "pointer", whiteSpace: "nowrap" }}>{pending === "signup" ? "Signing up…" : "Sign up"}</button>}
              <button className="census-chip" onClick={connectWallet} disabled={connecting} style={{ cursor: "pointer", whiteSpace: "nowrap" }}>{pending === "wallet" ? "Connecting…" : "Connect wallet"}</button>
            </span>
          )}
          <button onClick={() => nav("/home")} style={{ color: "var(--census-text-secondary)", fontSize: 14, background: "none", border: 0, cursor: "pointer" }}>Save &amp; exit</button>
        </div>
      </header>

      <div className="census-wizard__body">
        <main>
          {step === 0 && <CompanyStep draft={draft} set={set} ticker={ticker} warning={nameWarning} />}
          {step === 1 && <AnchorsStep draft={draft} set={set} anchor={anchor} />}
          {step === 2 && <EconomicsStep draft={draft} set={set} anchor={anchor} ticker={ticker} ethUsd={ethUsd} picks={picks} pctOf={pctOf} setPct={setPct} togglePick={togglePick} pickLabel={pickLabel} allowed={allowedAssets} allowedError={allowedError} />}
          {step === 3 && <IdentityStep draft={draft} set={set} ticker={ticker} reserved={reserved} hasFactory={hasFactory} />}
          {step === 4 && <ReviewStep draft={draft} ticker={ticker} isV2={isV2} picks={picks} pctOf={pctOf} pickLabel={pickLabel} reserved={reserved} onEdit={goTo} status={status} anchorKey={anchor.key} />}
        </main>
        <aside className="census-wizard__aside">
          <Preview draft={draft} ticker={ticker} isV2={isV2} picks={picks} pctOf={pctOf} pickLabel={pickLabel} reserved={reserved} anchor={anchor} />
        </aside>
      </div>

      <div className="census-dock">
        <div className="census-dock__inner">
          <div style={{ flex: "none" }}>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Step {step + 1} of {STEPS.length}</div>
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
          {pendingMeta ? (
            <span style={{ display: "inline-flex", gap: 10, flexWrap: "wrap" }}>
              <button className="census-btn" onClick={async () => {
                const r = await putMetadata(pendingMeta.token, CHAIN.id, pendingMeta.meta, signMessageAsync);
                if (r.ok) { setPendingMeta(null); nav(`/coin/${pendingMeta.token}`, { state: { metaSaved: true } }); }
                else setStatus(`Still not saved (${r.reason}).`);
              }}>Retry saving details</button>
              <button className="census-btn-ghost" onClick={() => nav(`/coin/${pendingMeta.token}`, { state: { metaSaved: false } })}>Open the coin <span aria-hidden="true">→</span></button>
            </span>
          ) : (
            <button className="census-btn" disabled={!valid[step] || launching} onClick={onContinue}>
              {launching ? "launching…" : ctaLabel} <span aria-hidden="true">→</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- steps ---------------- */

function CompanyStep({ draft, set, ticker, warning }: { draft: Draft; set: Setter; ticker: string; warning: NameWarning }) {
  return (
    <>
      <h1 className="census-wizard__title">Start a company.</h1>
      <p className="census-wizard__subtitle">Name it, say what it is, and pick how it launches.</p>

      <div className="census-field-label">Launch type</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 26 }}>
        {([["v1", "Prima", "A meme coin. Anchor to ETH or HOOD; a clean coin, live from block one."], ["v2", "Maxima", "A company coin. Holders earn a reflection on every trade, paid in a basket of the pairing asset and/or listed tokenised stocks — never in the coin itself."]] as const).map(([t, name, desc]) => (
          <button key={t} onClick={() => set(t === draft.tier ? { tier: t } : { tier: t, reflectionBps: DEFAULT_REFLECTION[t], picks: t === "v1" ? [] : draft.picks, graduationEth: gradFor(t, draft.graduationEth) })}
            className={"census-card" + (draft.tier === t ? " census-card--selected" : "")}
            style={{ textAlign: "left", cursor: "pointer", color: "var(--census-text)" }}>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{name} {draft.tier === t && <span className="census-dot">.</span>}</div>
            <div style={{ fontSize: 13, color: "var(--census-text-secondary)", marginTop: 6 }}>{desc}</div>
          </button>
        ))}
      </div>

      <div className="census-field-label">Company name</div>
      <input className="census-input" value={draft.name} maxLength={42} onChange={(e) => set({ name: stripConfusables(e.target.value) })} placeholder="Iron Man Industries" />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7 }}>
        <span style={{ fontSize: 12, color: "var(--census-text-muted)" }}>Ticker auto-derives to <span className="census-mono" style={{ color: "var(--census-lime)" }}>${ticker}</span> — editable at Identity.</span>
        <span className="census-counter">{draft.name.length}/42</span>
      </div>
      {warning && <div style={{ marginTop: 8, fontSize: 12.5, color: "#e0a33a", lineHeight: 1.5 }}>⚠ {warning.message}</div>}

      <div className="census-field-label" style={{ marginTop: 24 }}>One-line thesis</div>
      <input className="census-input" value={draft.thesis} maxLength={80} onChange={(e) => set({ thesis: e.target.value })} placeholder="The arc reactor of on-chain energy." />
      <div style={{ textAlign: "right", marginTop: 7 }}><span className="census-counter">{draft.thesis.length}/80</span></div>

      <div className="census-field-label" style={{ marginTop: 24 }}>Description <span style={{ color: "var(--census-text-muted)", fontWeight: 400 }}>(optional)</span></div>
      <textarea className="census-input" value={draft.description} rows={4} maxLength={2000} onChange={(e) => set({ description: e.target.value })} placeholder="What is it, who's it for, why now." style={{ resize: "vertical" }} />
    </>
  );
}

function QuotePicker({ draft, set }: { draft: Draft; set: Setter }) {
  const coinPicked = isCoinKey(draft.quoteKey);
  const [showCoins, setShowCoins] = useState(coinPicked);
  const unavailable = ANCHORS.filter((a) => !anchorAvailable(a));
  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {ANCHORS.map((a) => {
          const ok = anchorAvailable(a);
          return (
            <button key={a.key} className="census-chip" aria-pressed={draft.quoteKey === a.key} disabled={!ok} title={ok ? undefined : `${a.key} anchoring is live on mainnet`}
              onClick={() => { if (!ok) return; set({ quoteKey: a.key, quoteSymbol: "" }); setShowCoins(false); }} style={{ display: "inline-flex", alignItems: "center", gap: 8, opacity: ok ? 1 : 0.45, cursor: ok ? "pointer" : "not-allowed" }}>
              <AssetLogo src={a.logo} label={a.key} size={18} radius={5} />
              {a.label} ({a.key})
            </button>
          );
        })}
        <button className="census-chip" aria-pressed={coinPicked} onClick={() => setShowCoins(true)} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {coinPicked ? <><CxAvatar name={draft.quoteSymbol} size={18} /> {draft.quoteSymbol || "Company coin"}</> : "A company coin"}
        </button>
      </div>
      {unavailable.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--census-text-muted)" }}>{unavailable.map((a) => a.key).join(", ")} anchoring is live on mainnet.</div>
      )}
      {showCoins && <CompanyPicker draft={draft} set={set} />}
    </>
  );
}

// Graduated V4 Census coins ("company coins") a new launch can anchor to. Its canonical pool is where the
// new coin's anchor trades. (Legacy V3-era coins aren't pairable on the V4 curve.)
function CompanyPicker({ draft, set }: { draft: Draft; set: Setter }) {
  const { coins, loading } = useLaunches();
  const stats = useCurveStats(coins.map((c) => c.address));
  const ready = !loading && (coins.length === 0 || Object.keys(stats).length > 0);
  const graduated = coins.filter((c) => { const s = stats[c.address.toLowerCase()]; return s?.graduated && s.venue === "v4"; });
  if (!ready) return <div style={{ marginTop: 14, fontSize: 13, color: "var(--census-text-muted)" }}>Looking for graduated companies…</div>;
  if (!graduated.length) {
    return (
      <div style={{ marginTop: 14, border: "1px dashed rgba(242,245,241,0.18)", borderRadius: "var(--census-radius-input)", padding: "22px 20px", textAlign: "center" }}>
        <div style={{ fontSize: 15, color: "var(--census-text-secondary)" }}>No company has graduated yet</div>
        <div style={{ fontSize: 13, color: "var(--census-text-muted)", marginTop: 6 }}>The first graduation unlocks pairing. Until then, anchor to ETH or HOOD.</div>
      </div>
    );
  }
  return (
    <div className="census-card" style={{ padding: 0, overflow: "hidden", marginTop: 14 }}>
      {graduated.map((c, i) => {
        const s = stats[c.address.toLowerCase()];
        const on = draft.quoteKey.toLowerCase() === c.address.toLowerCase();
        return (
          <button key={c.address} onClick={() => set({ quoteKey: c.address, quoteSymbol: c.symbol })} aria-pressed={on}
            style={{ display: "grid", gridTemplateColumns: "34px minmax(0,1fr) auto", gap: 14, alignItems: "center", width: "100%", padding: "12px 16px", textAlign: "left",
              background: on ? "var(--census-lime-fill)" : "none", border: 0, borderTop: i ? "1px solid var(--census-hairline)" : 0, cursor: "pointer", color: "var(--census-text)" }}>
            <CxAvatar name={c.name} size={34} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontWeight: 600, fontSize: 14 }}>{c.name} <span className="census-mono" style={{ color: "var(--census-lime)", fontWeight: 500 }}>${c.symbol}</span></span>
              <span style={{ display: "block", fontSize: 12, color: "var(--census-text-secondary)" }}>Graduated · anchored to {s?.anchor ?? "ETH"} · market cap {fmtUsd(s?.mcapUsd)}</span>
            </span>
            <span className="census-mono" style={{ fontSize: 12, color: on ? "var(--census-lime)" : "var(--census-text-muted)" }}>{on ? "✓" : "+"}</span>
          </button>
        );
      })}
      <div style={{ padding: "12px 16px", borderTop: "1px solid var(--census-hairline)", fontSize: 12, color: "var(--census-text-muted)" }}>
        Buyers pay in the company coin, so they need to hold it. Your coin's fees arrive in it; a reward basket can then hold the company coin (stocks route from ETH or HOOD only).
      </div>
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

type AnchorsProps = { draft: Draft; set: Setter; anchor: Anchor };
function AnchorsStep({ draft, set, anchor }: AnchorsProps) {
  return (
    <>
      <h1 className="census-wizard__title">What is it anchored to?</h1>
      <p className="census-wizard__subtitle">Choose the asset your coin is paired against — on the curve and, after graduation, in its canonical pool.</p>

      <div className="census-field-label">Anchored to</div>
      <QuotePicker draft={draft} set={set} />
      <div style={{ marginTop: 12, fontSize: 13, color: "var(--census-text-muted)" }}>
        {anchor.coin
          ? `Priced against ${anchor.key}. Buyers pay in it, and your fees arrive in it.`
          : `Priced against ${anchor.key}. Fees arrive in ${anchor.key}; if you turn on a holder reflection (next step) the vault turns its share into the reward basket automatically.`}
      </div>
    </>
  );
}

// The reward basket for a launch with a reflection: up to three QUOTED assets among the pairing asset
// and the tokenised stocks that are both routable and allow-listed on the curve (`allowed`; null while
// that read is in flight). The coin itself is never a reward. Stocks are reached by a V3 route from
// ETH/HOOD, so a company-coin anchor limits the basket to the pairing coin. Weights always read 100%.
type BasketProps = { set: Setter; anchor: Anchor; ticker: string; picks: string[]; pctOf: (t: string) => number; setPct: (t: string, p: number) => void; togglePick: (t: string) => void; pickLabel: (k: string) => string; allowed: Set<string> | null; allowedError: boolean };
function BasketPicker({ set, anchor, ticker, picks, pctOf, setPct, togglePick, pickLabel, allowed, allowedError }: BasketProps) {
  const [query, setQuery] = useState("");
  const [sector, setSector] = useState("All");
  const full = picks.length >= MAX_BASKET;
  const stocksRoutable = !anchor.coin;
  const loadingList = allowed == null;
  // Only stocks the contract will accept are ever shown.
  const listed = allowed ? UNIVERSE.filter((u) => isAllowedRewardAsset(allowed, stockAddress(u.ticker))) : [];
  const sectors = ["All", ...Array.from(new Set(listed.map((u) => u.sector)))];
  const results = listed
    .filter((u) => sector === "All" || u.sector === sector)
    .filter((u) => { const q = query.trim().toLowerCase(); return !q || u.ticker.toLowerCase().includes(q) || u.name.toLowerCase().includes(q); });
  const specials: { key: string; title: string; sub: string; node: ReactNode }[] = [
    { key: QUOTE_KEY, title: anchor.key, sub: anchor.coin ? "The pairing coin, credited as-is" : `${anchor.label} — the pairing asset, credited as-is`, node: anchor.coin ? <CxAvatar name={anchor.key} size={30} /> : <AssetLogo src={anchor.logo} label={anchor.key} size={30} radius={8} /> },
  ];
  const rowLogo = (k: string) => (k === QUOTE_KEY ? (anchor.coin ? <CxAvatar name={anchor.key} size={34} /> : <AssetLogo src={anchor.logo} label={anchor.key} size={34} radius={9} />) : <StockLogo ticker={k} size={34} />);
  const rowSub = (k: string) => (k === QUOTE_KEY ? "Pairing asset" : UNIVERSE.find((u) => u.ticker === k)?.name);

  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "30px 0 12px" }}>
        <div className="census-field-label" style={{ margin: 0 }}>Reward basket</div>
        <span className="census-mono" style={{ fontSize: 12, color: full ? "var(--census-lime)" : "var(--census-text-muted)" }}>{picks.length}/{MAX_BASKET} selected</span>
      </div>

      {picks.length === 0 ? (
        <div style={{ border: "1px dashed rgba(242,245,241,0.18)", borderRadius: "var(--census-radius-input)", padding: "34px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 15, color: "var(--census-text-secondary)" }}>Nothing in the basket yet</div>
          <div style={{ fontSize: 13, color: "var(--census-text-muted)", marginTop: 6 }}>Choose up to three assets below. Holders earn the reflection in these — paid in {anchor.key} and listed stocks, never in ${ticker}.</div>
        </div>
      ) : (
        <div className="census-card" style={{ padding: 0, overflow: "hidden" }}>
          {picks.map((t, i) => (
            <div key={t} style={{ display: "grid", gridTemplateColumns: "34px minmax(0,1.4fr) minmax(0,1fr) 120px 30px", alignItems: "center", gap: 14, padding: "14px 18px", borderTop: i === 0 ? 0 : "1px solid var(--census-hairline)" }}>
              {rowLogo(t)}
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontWeight: 600, fontSize: 14 }}>{pickLabel(t)}</span>
                <span style={{ display: "block", fontSize: 12, color: "var(--census-text-secondary)" }}>{rowSub(t)}</span>
              </span>
              <span className="census-bar" style={{ display: "block" }}><i className="census-bar__fill" style={{ width: `${pctOf(t)}%` }} /></span>
              <span style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
                <button className="census-btn-ghost" aria-label={`decrease ${pickLabel(t)}`} onClick={() => setPct(t, pctOf(t) - 5)} style={{ width: 26, height: 26, padding: 0, borderRadius: 7, fontSize: 16, lineHeight: 1 }}>−</button>
                <WeightInput value={pctOf(t)} onCommit={(n) => setPct(t, n)} />
                <button className="census-btn-ghost" aria-label={`increase ${pickLabel(t)}`} onClick={() => setPct(t, pctOf(t) + 5)} style={{ width: 26, height: 26, padding: 0, borderRadius: 7, fontSize: 16, lineHeight: 1 }}>+</button>
              </span>
              <button className="census-btn-ghost" aria-label={`remove ${pickLabel(t)}`} onClick={() => togglePick(t)} style={{ width: 30, height: 30, padding: 0, borderRadius: 8, fontSize: 15 }}>×</button>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "13px 18px", borderTop: "1px solid var(--census-hairline)", background: "rgba(180,240,61,0.03)" }}>
            <span style={{ fontSize: 13, color: "var(--census-text-secondary)" }}>Weights normalise to exactly 100% · frozen at launch</span>
            <span style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <button className="census-btn-ghost" onClick={() => set({ weights: Object.fromEntries(picks.map((t) => [t, 25])) })}>Split evenly</button>
              <span className="census-mono" style={{ fontSize: 13 }}>Total 100%</span>
            </span>
          </div>
        </div>
      )}

      <div className="census-field-label" style={{ marginTop: 30 }}>Pairing asset</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 10 }}>
        {specials.map((sp) => {
          const on = picks.includes(sp.key); const blocked = !on && full;
          return (
            <button key={sp.key} className={"census-card" + (on ? " census-card--selected" : "")} onClick={() => togglePick(sp.key)} disabled={blocked} aria-pressed={on}
              style={{ display: "flex", alignItems: "center", gap: 11, textAlign: "left", padding: "12px 13px", color: "var(--census-text)", cursor: blocked ? "not-allowed" : "pointer", opacity: blocked ? 0.45 : 1 }}>
              {sp.node}
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontWeight: 600, fontSize: 13.5 }}>{sp.title}</span>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--census-text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sp.sub}</span>
              </span>
              <span className="census-mono" style={{ fontSize: 12, color: on ? "var(--census-lime)" : "var(--census-text-muted)" }}>{on ? "✓" : "+"}</span>
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 30 }}>
        <div className="census-field-label" style={{ margin: 0 }}>Tokenised stocks listed for rewards</div>
        <span className="census-mono" style={{ fontSize: 12, color: "var(--census-text-muted)" }}>{loadingList ? "…" : `${results.length} of ${listed.length}`}</span>
      </div>
      {!stocksRoutable ? (
        <div style={{ marginTop: 10, fontSize: 13, color: "var(--census-text-muted)" }}>Stocks route from ETH or HOOD. With {anchor.key} as the anchor, the basket can hold {anchor.key}.</div>
      ) : loadingList ? (
        <div style={{ marginTop: 10, fontSize: 13, color: "var(--census-text-muted)" }} role="status">Checking which stocks are listed for rewards…</div>
      ) : listed.length === 0 ? (
        <div style={{ marginTop: 10, border: "1px dashed rgba(242,245,241,0.18)", borderRadius: "var(--census-radius-input)", padding: "22px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 15, color: "var(--census-text-secondary)" }}>{allowedError ? "Couldn't read which stocks are listed for rewards" : "No stocks are listed for rewards yet"}</div>
          <div style={{ fontSize: 13, color: "var(--census-text-muted)", marginTop: 6 }}>{allowedError ? "Reload to try again. " : ""}You can still reward holders in {anchor.key}, the pairing asset.</div>
        </div>
      ) : (<>
        {allowedError && <div style={{ marginTop: 10, fontSize: 12.5, color: "#e0a33a", lineHeight: 1.5 }}>⚠ Some listings couldn't be read — only stocks confirmed as listed are shown. Reload to check again.</div>}
        <input className="census-input" style={{ marginTop: 10 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search ticker or company — NVDA, Tesla, gold…" aria-label="Search stocks" />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
          {sectors.map((sc) => <button key={sc} className="census-chip" aria-pressed={sc === sector} onClick={() => setSector(sc)}>{sc}</button>)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 10, marginTop: 16 }}>
          {results.map((u) => {
            const on = picks.includes(u.ticker); const blocked = !on && full;
            return (
              <button key={u.ticker} className={"census-card" + (on ? " census-card--selected" : "")} onClick={() => togglePick(u.ticker)} disabled={blocked} aria-pressed={on}
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
        {results.length === 0 && <div style={{ marginTop: 12, fontSize: 13, color: "var(--census-text-muted)" }}>No listed stocks match — try another ticker or name.</div>}
        <div style={{ marginTop: 12, fontSize: 13, color: "var(--census-text-muted)" }}>Only stocks listed for rewards on-chain are shown. Stocks with stablecoin-only liquidity are reached automatically by routing the swap.</div>
      </>)}
    </>
  );
}

type EconomicsProps = { draft: Draft; set: Setter; anchor: Anchor; ticker: string; ethUsd: number; picks: string[]; pctOf: (t: string) => number; setPct: (t: string, p: number) => void; togglePick: (t: string) => void; pickLabel: (k: string) => string; allowed: Set<string> | null; allowedError: boolean };
function EconomicsStep({ draft, set, anchor, ticker, ethUsd, picks, pctOf, setPct, togglePick, pickLabel, allowed, allowedError }: EconomicsProps) {
  const anchorKey = anchor.key;
  const reflection = draft.reflectionBps;
  const totalBps = TRADE_FEE_BPS + reflection;
  const base = 1000 * (TRADE_FEE_BPS / 10000); // the base fee on $1,000 traded
  const refl = 1000 * (reflection / 10000); // the reflection on $1,000 traded
  return (
    <>
      <h1 className="census-wizard__title">The economics.</h1>
      <p className="census-wizard__subtitle">Every trade pays a {TRADE_FEE_LABEL} base fee. Add a holder reflection on top, and choose what holders earn it in.</p>

      <div className="census-field-label">Trade fee</div>
      <FeeSplitTip reflectionBps={reflection} basket={picks.map(pickLabel)} block>
        <div className="census-card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>Fee <span className="census-mono" style={{ color: "var(--census-lime)" }}>{pctLabel(totalBps)}</span> per trade</div>
            <div style={{ fontSize: 13, color: "var(--census-text-secondary)", marginTop: 4 }}>{feeBreakdown(reflection)} · on every buy and sell, on the curve and in the canonical pool. Same for every company.</div>
          </div>
          <span className="census-tip__hint" aria-hidden="true">ⓘ where it goes</span>
        </div>
      </FeeSplitTip>

      <div className="census-field-label" style={{ marginTop: 30 }}>Holder reflection</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {REFLECTION_OPTIONS.map((bps) => (
          <button key={bps} className="census-chip" aria-pressed={reflection === bps} onClick={() => set({ reflectionBps: bps, picks: bps === 0 ? [] : draft.picks })}>{bps === 0 ? "Off" : pctLabel(bps)}</button>
        ))}
      </div>
      <div style={{ fontSize: 13, color: "var(--census-text-muted)" }}>
        {reflection > 0
          ? `Charged on top of the ${TRADE_FEE_LABEL} base on every buy and sell, and paid to holders in the basket below. Reflection and basket are frozen at launch.`
          : `Off: trades pay the ${TRADE_FEE_LABEL} base fee only. Turn it on to reward holders — it's frozen at launch.`}
      </div>

      {reflection > 0 && <BasketPicker set={set} anchor={anchor} ticker={ticker} picks={picks} pctOf={pctOf} setPct={setPct} togglePick={togglePick} pickLabel={pickLabel} allowed={allowed} allowedError={allowedError} />}

      <div className="census-field-label" style={{ marginTop: 30 }}>On every $1,000 traded</div>
      <div className="census-card" style={{ display: "grid", gap: 10 }}>
        <FeeRow label={`Base fee (${TRADE_FEE_LABEL})`} value={usd(base)} />
        {reflection > 0 && <FeeRow label={`Holder reflection (${pctLabel(reflection)})`} value={usd(refl)} accent />}
        <FeeRow label="Fee total" value={usd(base + refl)} accent={reflection === 0} />
      </div>
      <div style={{ marginTop: 10, fontSize: 13, color: "var(--census-text-muted)" }}>
        The base fee is shared between Census and you, the creator.{reflection > 0 ? ` The reflection goes to holders${picks.length ? ` as ${picks.map(pickLabel).join(", ")}` : ""}.` : ""}
      </div>

      <div className="census-field-label" style={{ marginTop: 30 }}>Graduation target</div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(2, gradsFor(draft.tier).length)},1fr)`, gap: 12 }}>
        {gradsFor(draft.tier).map((t) => {
          const on = t.eth === draft.graduationEth;
          return (
            <button key={t.eth} className={"census-card" + (on ? " census-card--selected" : "")} onClick={() => set({ graduationEth: t.eth })} aria-pressed={on} style={{ textAlign: "left", color: "var(--census-text)", cursor: "pointer" }}>
              <span className="census-mono" style={{ fontSize: 17, fontWeight: 500, color: on ? "var(--census-lime)" : "var(--census-text)" }}>{t.eth} ETH</span>
              <div style={{ fontSize: 13, color: "var(--census-text-secondary)", marginTop: 5 }}>{t.label}</div>
              <span className="census-mono" style={{ fontSize: 12, color: t.label === "Rehearsal" ? "#e06c60" : "var(--census-text-muted)", marginTop: 3, display: "block" }}>{t.label === "Rehearsal" ? "mainnet test run — not a real target" : `≈ ${usdK(graduationFdvEth(t.eth) * ethUsd)} mcap at graduation`}</span>
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: 10, fontSize: 13, color: "var(--census-text-muted)" }}>
        {draft.tier === "v1" ? "Prima (meme) coins graduate at 4 ETH. " : "Company coins choose 4 or 8 ETH. "}
        At the target the bonding curve graduates into the canonical Census pool — a milestone; liquidity stays locked and the same fee keeps applying there.
        {anchorKey !== "ETH" && ` Targets are set in ETH terms and converted to ${anchorKey} at launch.`}
      </div>
    </>
  );
}

// Drag-and-drop (or click / paste) logo field. Shows the image the instant it's dropped (downscaled
// data URL), then uploads it for a persistent hosted URL. Uploads are signed by the connected wallet
// (the store is wallet-gated and quota-limited); with no wallet, a declined signature or no store yet,
// the local preview stays and the coin still launches — the logo just isn't hosted.
function LogoDrop({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { address: wallet } = useAccount();
  const { signMessageAsync: signUpload } = useSignMessage();
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
      const hosted = await uploadImage(dataUrl, wallet ? { address: wallet, chainId: CHAIN.id, signMessage: signUpload } : null);
      if (hosted.url) { onChange(hosted.url); setNote(""); }
      else setNote(wallet ? `Shown here now — not hosted yet (${"reason" in hosted ? hosted.reason : "unknown"}).` : "Shown here now. Connect your wallet to host it with the coin.");
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

type IdentityProps = { draft: Draft; set: Setter; ticker: string; reserved: { address: Address } | null; hasFactory: boolean };
function IdentityStep({ draft, set, ticker, reserved, hasFactory }: IdentityProps) {
  return (
    <>
      <h1 className="census-wizard__title">Identity.</h1>
      <p className="census-wizard__subtitle">Your logo, ticker, and the address we've reserved for it.</p>

      <div className="census-field-label">Logo <span style={{ color: "var(--census-text-muted)", fontWeight: 400 }}>(optional)</span></div>
      <LogoDrop value={draft.image} onChange={(v) => set({ image: v })} />

      <div className="census-field-label" style={{ marginTop: 24 }}>Ticker</div>
      {/* Empty = derived from the name (shown as the placeholder); type to override. */}
      <input className="census-input census-mono" value={draft.ticker} maxLength={11} onChange={(e) => set({ ticker: e.target.value.replace(/[^a-zA-Z0-9]/g, "").toUpperCase() })} placeholder={ticker} aria-label="Ticker" style={{ maxWidth: 220 }} />

      <div className="census-field-label" style={{ marginTop: 24 }}>Reserved address</div>
      <div className="census-card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className="census-mono" style={{ fontSize: 14, color: reserved ? "var(--census-text)" : "var(--census-text-muted)", wordBreak: "break-all" }}>
          {reserved
            ? <>{reserved.address.slice(0, -4)}<span className="census-dot" style={{ color: "var(--census-lime)" }}>c0de</span></>
            : hasFactory ? "grinding a …c0de address…" : "assigned at launch on this network"}
        </span>
      </div>
      <div style={{ fontSize: 13, color: "var(--census-text-muted)", marginTop: 8 }}>Every Census token address ends in <span className="census-mono" style={{ color: "var(--census-lime)" }}>c0de</span>. Held for you until you launch.</div>

      <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 26, cursor: "pointer" }}>
        <input type="checkbox" checked={draft.publicConsent} onChange={(e) => set({ publicConsent: e.target.checked })} style={{ marginTop: 3, accentColor: "var(--census-lime)" }} />
        <span style={{ fontSize: 13, color: "var(--census-text-secondary)" }}>I understand launch details and images are public and subject to moderation.</span>
      </label>
    </>
  );
}

const Group = ({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) => (
  <div className="census-card" style={{ marginBottom: 14 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
      <div className="census-field-label" style={{ margin: 0 }}>{title}</div>
      <button className="census-btn-ghost" onClick={onEdit} aria-label={`Edit ${title}`}>Edit</button>
    </div>
    {children}
  </div>
);
const Row = ({ k, v, accent }: { k: ReactNode; v: ReactNode; accent?: boolean }) => (
  <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: 13 }}>
    <span style={{ color: "var(--census-text-secondary)" }}>{k}</span>
    <span className="census-mono" style={{ color: accent ? "var(--census-lime)" : "var(--census-text)" }}>{v}</span>
  </div>
);

type ReviewProps = { draft: Draft; ticker: string; isV2: boolean; picks: string[]; pctOf: (t: string) => number; pickLabel: (k: string) => string; reserved: { address: Address } | null; onEdit: (step: number) => void; status: string; anchorKey: string };
function ReviewStep({ draft, ticker, isV2, picks, pctOf, pickLabel, reserved, onEdit, status, anchorKey }: ReviewProps) {
  const reflection = draft.reflectionBps;
  return (
    <>
      <h1 className="census-wizard__title">Review &amp; launch.</h1>
      <p className="census-wizard__subtitle">The whole supply seeds the curve — trading from block one. Liquidity locks in the canonical pool at graduation.</p>

      <Group title="Company" onEdit={() => onEdit(0)}>
        <Row k="Name" v={draft.name || "—"} /><Row k="Ticker" v={`$${ticker}`} accent /><Row k="Type" v={isV2 ? "Maxima" : "Prima"} />
        <div style={{ fontSize: 13, color: "var(--census-text-secondary)", marginTop: 8 }}>{draft.thesis}</div>
      </Group>
      <Group title="Anchors" onEdit={() => onEdit(1)}>
        <Row k="Anchored to" v={anchorKey} accent />
      </Group>
      <Group title="Economics" onEdit={() => onEdit(2)}>
        <Row k={<FeeSplitTip reflectionBps={reflection} basket={picks.map(pickLabel)}><span className="census-tip__label">Trade fee</span></FeeSplitTip>} v={`${pctLabel(TRADE_FEE_BPS + reflection)} (${feeBreakdown(reflection)})`} />
        <Row k="Holder reflection" v={reflection > 0 ? pctLabel(reflection) : "Off"} accent={reflection > 0} />
        {reflection > 0 && picks.map((t) => <Row key={t} k={`Basket · ${pickLabel(t)}`} v={`${pctOf(t)}%`} />)}
        <Row k="Graduation" v={gradLabel(draft.graduationEth, anchorKey)} />
        {reflection > 0 && <div style={{ fontSize: 12, color: "var(--census-text-muted)", marginTop: 6 }}>Reflection and basket are frozen at launch.</div>}
      </Group>
      <Group title="Identity" onEdit={() => onEdit(3)}>
        <Row k="Logo" v={draft.image ? (isHostedUrl(draft.image) ? "Set" : "Preview only — not saved yet") : "None"} />
        <Row k="Address" v={reserved ? `…${reserved.address.slice(-8)}` : "assigned at launch"} accent={!!reserved} />
      </Group>
      {status && <div className="census-panel" style={{ color: "var(--census-text-secondary)", fontSize: 13, wordBreak: "break-word" }}>{status}</div>}
    </>
  );
}

/* ---------------- sticky preview ---------------- */

type PreviewProps = { draft: Draft; ticker: string; isV2: boolean; picks: string[]; pctOf: (t: string) => number; pickLabel: (k: string) => string; reserved: { address: Address } | null; anchor: Anchor };
function Preview({ draft, ticker, isV2, picks, pctOf, pickLabel, reserved, anchor }: PreviewProps) {
  const reflection = draft.reflectionBps;
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
        <PvRow k="Anchored to" v={<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><AssetLogo src={anchor.logo} label={anchor.key} size={16} radius={4} />{anchor.key}</span>} />
        <PvRow k={<FeeSplitTip reflectionBps={reflection} basket={picks.map(pickLabel)}><span className="census-tip__label">Trade fee</span></FeeSplitTip>} v={pctLabel(TRADE_FEE_BPS + reflection)} />
        <PvRow k="Holder reflection" v={reflection > 0 ? pctLabel(reflection) : "Off"} accent={reflection > 0} />
        {reflection > 0 && <PvRow k="Holders earn" v={picks.length ? picks.map((t) => `${pickLabel(t)} ${pctOf(t)}%`).join(", ") : "—"} />}
        <PvRow k="Graduation" v={gradLabel(draft.graduationEth, anchor.key)} />
        <PvRow k="Liquidity" v="Locks at graduation" accent />
        {reserved && <PvRow k="Address" v={`…${reserved.address.slice(-8)}`} />}
      </div>
    </div>
  );
}

function PvRow({ k, v, accent }: { k: ReactNode; v: ReactNode; accent?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
      <span style={{ color: "var(--census-text-secondary)", flex: "none" }}>{k}</span>
      <span className="census-mono" style={{ color: accent ? "var(--census-lime)" : "var(--census-text)", textAlign: "right" }}>{v}</span>
    </div>
  );
}

// Hover / focus tooltip spelling out where every part of the trade fee goes — creators asked for the
// distribution to be explicit. Shares come from config.feeSplit (mirrored from the contracts). Wraps its
// trigger; `block` makes a whole card the hover target. Keyboard and tap users get it via focus.
function FeeSplitTip({ reflectionBps, basket, block, children }: { reflectionBps: number; basket: string[]; block?: boolean; children: ReactNode }) {
  const s = feeSplit(reflectionBps);
  const Wrap = block ? "div" : "span";
  return (
    <Wrap className={"census-tip" + (block ? " census-tip--block" : "")} tabIndex={0}>
      {children}
      <span className="census-tip__pop" role="tooltip">
        <span className="census-tip__title">Where the {pctLabel(s.total)} goes</span>
        Charged on every buy and sell. Nothing else is ever taken from a trade.
        <span className="census-tip__row"><span>Base fee — Census and you</span><span className="census-mono">{pctLabel(s.base)}</span></span>
        {s.phases.map((p) => (
          <span key={p.phase} className="census-tip__sub">
            <span>{p.phase} ({p.censusShare / 100} / {100 - p.censusShare / 100})</span>
            <span className="census-mono" style={{ flex: "none" }}>Census {pctLabel(p.census)} · you {pctLabel(p.creator)}</span>
          </span>
        ))}
        {s.reflection > 0 ? (
          <>
            <span className="census-tip__row"><span>Holder reflection — holders</span><span className="census-mono">{pctLabel(s.reflection)}</span></span>
            <span className="census-tip__sub">
              <span>All of it, paid {basket.length ? "as " + basket.join(", ") : "into the reward basket"}</span>
              <span className="census-mono" style={{ flex: "none" }}>holders {pctLabel(s.reflection)}</span>
            </span>
          </>
        ) : (
          <span className="census-tip__sub"><span>No holder reflection on this launch — holders receive nothing from the fee.</span></span>
        )}
        <span className="census-tip__foot">Census's share goes to the Census treasury; your share goes to the wallet that launches the coin. The split is fixed by the contracts for the life of the coin.</span>
      </span>
    </Wrap>
  );
}

function FeeRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13, color: "var(--census-text-secondary)" }}>
      <span>{label}</span>
      <span className="census-mono" style={{ fontWeight: 500, color: accent ? "var(--census-lime)" : "var(--census-text)" }}>{value}</span>
    </div>
  );
}
