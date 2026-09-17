/* Census inner-app UI kit — ported from the designer's reference (census-app-reference.jsx), wired to
 * react-router + the real wallet.
 * Rules (do not "improve" away): lime is the only accent + one key numeral per screen; every numeral is
 * mono/tabular; coin avatars are the real image or a FLAT tile (never metal); anchors/stocks always use
 * the real logo; a value we do not have renders as "—", never 0 or a fabricated number.
 */
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAccount, useConnect, useSwitchChain } from "wagmi";
import { CHAIN as CONFIG_CHAIN } from "./config";

// Real, env-driven chain (46630 on testnet, 4663 on mainnet) — used for the sidebar meta and for
// connecting on the correct network.
export const CHAIN = { name: CONFIG_CHAIN.name, id: CONFIG_CHAIN.id };

const ANCHOR_LOGO: Record<string, string> = {
  ETH: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
  HOOD: "https://financialmodelingprep.com/image-stock/HOOD.png",
};
export const assetLogoSrc = (t: string) => ANCHOR_LOGO[t] ?? `https://financialmodelingprep.com/image-stock/${t}.png`;

/* live on-chain today vs waiting on the indexer — drive the UI off this so pending fields can't be faked */
const PENDING = ["change24h", "holders", "holderDistribution", "priceHistory", "feesEarned", "holdings", "thread", "replies", "tape"];
export const isPending = (field: string) => PENDING.includes(field);

/* -------- formatters (encode the honest-data rules) -------- */
export const fmtUsd = (n: number | null | undefined) =>
  n == null ? "—" : n === 0 ? "new"
    : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B`
    : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M`
    : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K`
    : `$${n.toFixed(2)}`;
export const fmtPrice = (n: number | null | undefined) => (n == null ? "—" : `$${n.toPrecision(3)}`);
export const fmtPct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n)}%`);
export const fmtAmount = (n: number, digits = 4) => n.toLocaleString(undefined, { maximumFractionDigits: digits });
export const shortAddr = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
export const initials = (name: string) =>
  (name || "").split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "C";

/* A display-ready coin, mapped from the real launches + curve stats by each page. */
export type DisplayCoin = {
  address: string; name: string; symbol: string; image?: string;
  creator?: string; age?: string; anchor?: string;
  marketCap?: number | null; price?: number | null; graduation?: number | null;
  graduated?: boolean; reserve?: number; graduationTarget?: number | null; replies?: number | null;
  quoteAddress?: string; anchorIsCoin?: boolean; // a coin anchored to another Census coin
};

/* -------- primitives -------- */
export const Num = ({ children, kind = "value" }: { children: ReactNode; kind?: "key" | "value" }) => (
  <span className={`cx-num cx-num--${children === "—" ? "pending" : kind}`}>{children}</span>
);

export function CxAvatar({ name, image, wallet = false, size }: { name?: string; image?: string; wallet?: boolean; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = size ? { width: size, height: size, fontSize: Math.round(size * 0.26) } : undefined;
  return (
    <span className={`cx-avatar${wallet ? " cx-avatar--wallet" : ""}`} style={style}>
      {image && !failed ? <img src={image} alt="" onError={() => setFailed(true)} /> : initials(name || "")}
    </span>
  );
}

export function CxAssetLogo({ ticker, size = 14, src }: { ticker: string; size?: number; src?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    let h = 0; for (const ch of ticker) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return <span className="cx-asset-logo" style={{ width: size, height: size, background: `hsl(${h} 55% 55%)`, color: "#0c130f", display: "grid", placeItems: "center", fontSize: size * 0.4, fontWeight: 700, padding: 0 }}>{ticker.slice(0, 1)}</span>;
  }
  return <img className="cx-asset-logo" src={src ?? assetLogoSrc(ticker)} alt={ticker} loading="lazy" width={size} height={size} onError={() => setFailed(true)} />;
}

/* The anchor's mark: the real asset logo for ETH/HOOD/stocks, a flat lettermark for a Census coin. */
export const AnchorMark = ({ anchor, isCoin, size = 14 }: { anchor: string; isCoin?: boolean; size?: number }) =>
  isCoin
    ? <span className="cx-avatar" style={{ width: size, height: size, fontSize: Math.max(7, Math.round(size * 0.5)), borderRadius: 4 }}>{(anchor || "C").slice(0, 1)}</span>
    : <CxAssetLogo ticker={anchor} size={size} />;

export const GraduationBar = ({ pct, large = false }: { pct: number; large?: boolean }) => (
  <span className={`cx-bar${large ? " cx-bar--lg" : ""}${pct >= 100 ? " cx-bar--done" : ""}`}>
    <i style={{ width: `${Math.min(pct, 100)}%` }} />
  </span>
);

export const StatBand = ({ stats }: { stats: { label: string; value: ReactNode; note: string; key?: boolean }[] }) => (
  <div className="cx-stats">
    {stats.map((s) => (
      <div key={s.label}>
        <div className="cx-label">{s.label}</div>
        <div className="cx-stat__value"><Num kind={s.key ? "key" : "value"}>{s.value}</Num></div>
        <div className="cx-stat__note">{s.note}</div>
      </div>
    ))}
  </div>
);

export const PendingPanel = ({ line, note }: { line: string; note?: string }) => (
  <div className="cx-pending"><div>
    <div className="cx-pending__line">{line}</div>
    {note ? <div className="cx-pending__note">{note}</div> : null}
  </div></div>
);

export const EmptyPanel = ({ title, body, action = "Create coin" }: { title: string; body: string; action?: string }) => (
  <div className="cx-panel cx-empty">
    <div className="cx-empty__count">0<i>.</i></div>
    <div className="cx-empty__title">{title}</div>
    <div className="cx-empty__body">{body}</div>
    <Link className="cx-cta" style={{ marginTop: 26 }} to="/create">{action}</Link>
  </div>
);

/* Search/filter came back empty — not the same thing as an empty market. */
export const NoMatchPanel = ({ query }: { query: string }) => (
  <PendingPanel line={`Nothing matches “${query}”`} note="Try a company name or ticker." />
);

/* -------- icons (paths from the designer's reference) -------- */
const ICON: Record<string, ReactNode> = {
  home: <path d="M3 11l9-8 9 8M5 10v10h14V10" strokeWidth={1.9} />,
  board: <><circle cx="7" cy="8" r="2.4" /><circle cx="16" cy="16" r="2.4" /><path d="M2 8h3M9.4 8H22M2 16h11.6M18.4 16H22" /></>,
  profile: <><circle cx="12" cy="12" r="9.2" /><circle cx="12" cy="9.5" r="3" /><path d="M6 19a6 6 0 0112 0" /></>,
  paper: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9.5 12.5h5M9.5 16h5" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" strokeWidth={1.9} /></>,
  plus: <path d="M12 5v14M5 12h14" strokeWidth={2} />,
  back: <path d="M15 6l-6 6 6 6" strokeWidth={2} />,
  copy: <path d="M9 9h10v10H9zM5 15H4V4h11v1" />,
};
export const Icon = ({ name, size = 18 }: { name: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICON[name]}</svg>
);

/* -------- shell -------- */
const NAV = [
  { key: "companies", label: "Companies", to: "/home", icon: "home" },
  { key: "market", label: "Market", to: "/board", icon: "board" },
  { key: "paper", label: "CensusPaper", to: "/paper", icon: "paper" },
  { key: "profile", label: "Profile", to: "/profile", icon: "profile" },
];
const MOBILE_TABS = [
  { key: "companies", label: "Companies", icon: "home", to: "/home" },
  { key: "market", label: "Market", icon: "board", to: "/board" },
  { key: "create", label: "Create", icon: "plus", to: "/create", action: true },
  { key: "paper", label: "Paper", icon: "paper", to: "/paper" },
  { key: "profile", label: "Profile", icon: "profile", to: "/profile" },
];

/* -------- wallet picker: one host (mounted in App), opened by useWalletConnect -------- */
export type WalletOption = { id: string; name: string; icon?: string; hint?: string };
type PickerState = { open: boolean; title: string; options: WalletOption[]; resolve: ((id: string | null) => void) | null };
let picker: PickerState = { open: false, title: "", options: [], resolve: null };
const pickerSubs = new Set<() => void>();
const setPicker = (s: PickerState) => { picker = s; pickerSubs.forEach((f) => f()); };
const pickWallet = (title: string, options: WalletOption[]) => new Promise<string | null>((resolve) => setPicker({ open: true, title, options, resolve }));
const closePicker = (id: string | null) => { picker.resolve?.(id); setPicker({ open: false, title: "", options: [], resolve: null }); };

export function WalletPicker() {
  const s = useSyncExternalStore((cb) => { pickerSubs.add(cb); return () => { pickerSubs.delete(cb); }; }, () => picker);
  useEffect(() => {
    if (!s.open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closePicker(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.open]);
  if (!s.open) return null;
  return (
    <div className="cx-modal-backdrop" onClick={() => closePicker(null)} role="presentation">
      <div className="cx-modal" role="dialog" aria-modal="true" aria-label={s.title} onClick={(e) => e.stopPropagation()}>
        <div className="cx-label" style={{ marginBottom: 14 }}>{s.title}</div>
        <div className="cx-wallets">
          {s.options.map((o) => (
            <button key={o.id} className="cx-wallet" onClick={() => closePicker(o.id)}>
              {o.icon
                ? <img src={o.icon} alt="" width={28} height={28} style={{ borderRadius: 8 }} />
                : <span className="cx-avatar" style={{ width: 28, height: 28, fontSize: 11, borderRadius: 8 }}>{o.name.slice(0, 1)}</span>}
              <span style={{ minWidth: 0 }}>
                <span className="cx-wallet__name">{o.name}</span>
                {o.hint && <span className="cx-wallet__hint">{o.hint}</span>}
              </span>
              <span className="cx-label" aria-hidden="true">→</span>
            </button>
          ))}
        </div>
        <button className="cx-link-control" style={{ marginTop: 16 }} onClick={() => closePicker(null)}>Cancel</button>
      </div>
    </div>
  );
}

// Plain mobile Safari/Chrome inject no wallet; the big wallet apps' in-app browsers do. Each link opens
// the current page inside that app, where "Connect wallet" then works like on desktop.
function mobileWalletLinks(): (WalletOption & { href: string })[] {
  const enc = encodeURIComponent(window.location.href);
  const bare = window.location.host + window.location.pathname + window.location.search + window.location.hash;
  const hint = "Opens this page inside the app";
  return [
    { id: "metamask", name: "MetaMask", hint, href: `https://metamask.app.link/dapp/${bare}` },
    { id: "phantom", name: "Phantom", hint, href: `https://phantom.app/ul/browse/${enc}?ref=${encodeURIComponent(window.location.origin)}` },
    { id: "trust", name: "Trust Wallet", hint, href: `https://link.trustwallet.com/open_url?coin_id=60&url=${enc}` },
    { id: "coinbase", name: "Coinbase Wallet", hint, href: `https://go.cb-w.com/dapp?cb_url=${enc}` },
  ];
}

// One wallet-connect flow, shared by the app chrome (CensusConnect), the coin page, the profile and the
// launch wizard, so "Connect wallet" behaves identically everywhere. Wallets are discovered via
// EIP-6963 (one connector per installed extension — MetaMask, Phantom, Trust, Rabby…); with several
// installed the user picks, instead of silently getting whichever one won the window.ethereum race. It
// opens the wallet FIRST (no chainId), then best-effort switches to Robinhood Chain — decoupling the two
// means a network add/switch hiccup can never stop the wallet window from opening. Errors come back as
// clear text, never silence.
export function useWalletConnect() {
  const { connectAsync, connectors } = useConnect();
  const { connector: active } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const connect = useCallback(async (): Promise<{ ok: boolean; error: string }> => {
    setError("");
    // Candidate wallets: EIP-6963 announcements plus the explicit targets in wagmi.ts — kept only when the
    // wallet is actually present (its provider resolves), and deduped by provider object so a wallet seen
    // both ways (e.g. Phantom announced AND at window.phantom.ethereum) is listed once.
    const named = connectors.filter((c) => c.type === "injected" && c.id !== "injected").sort((a, b) => Number(!a.icon) - Number(!b.icon)); // EIP-6963 entries (with icons) first, so they win the dedupe
    const generic = connectors.find((c) => c.id === "injected"); // whatever owns window.ethereum (older extensions, in-app browsers)
    const resolved = await Promise.all(named.map(async (c) => ({ c, p: await c.getProvider().catch(() => undefined) })));
    const seen = new Set<unknown>();
    const discovered = resolved.filter(({ p }) => { if (!p || seen.has(p)) return false; seen.add(p); return true; }).map(({ c }) => c);
    const genericProvider = generic ? await generic.getProvider().catch(() => undefined) : undefined;
    let connector = discovered.length === 1 ? discovered[0] : undefined;
    if (discovered.length > 1) {
      const id = await pickWallet("Choose a wallet", discovered.map((c) => ({ id: c.id, name: c.name, icon: c.icon })));
      if (!id) return { ok: false, error: "" };
      connector = discovered.find((c) => c.id === id);
    }
    if (!connector && genericProvider && generic) connector = generic;
    if (!connector) {
      const isMobile = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (isMobile && typeof window !== "undefined") {
        const links = mobileWalletLinks();
        const id = await pickWallet("Open in your wallet app", links);
        const link = links.find((l) => l.id === id);
        if (!link) return { ok: false, error: "" };
        window.location.href = link.href;
        const m = `Opening ${link.name}…`;
        setError(m);
        return { ok: false, error: m };
      }
      const m = "No wallet detected. Install MetaMask, Phantom or another browser wallet, unlock it, then retry.";
      setError(m);
      return { ok: false, error: m };
    }
    setConnecting(true);
    try {
      await connectAsync({ connector });                                  // opens the chosen wallet
      try { await switchChainAsync({ chainId: CHAIN.id }); } catch { /* stay connected; the tx re-prompts the switch */ }
      setConnecting(false);
      return { ok: true, error: "" };
    } catch (e: any) {
      setConnecting(false);
      const raw = String(e?.shortMessage ?? e?.message ?? "");
      let m: string;
      if (/reject|denied|cancel|user/i.test(raw)) m = "Connection cancelled in your wallet — retry.";
      else if (/provider|not found|no injected|getProvider/i.test(raw)) m = "No wallet detected. Install a browser wallet, unlock it, then retry.";
      else m = (raw || "Couldn't connect").slice(0, 90);
      setError(m);
      return { ok: false, error: m };
    }
  }, [connectAsync, connectors, switchChainAsync]);

  // Make sure the wallet is on Robinhood Chain before a tx. Without this a user connected to Ethereum
  // mainnet would be asked to pay real gas there and the tx would fail — there are no Census contracts
  // on Ethereum. Returns false (with a clear error) if the switch is declined. Phantom ships Robinhood
  // Chain built in but off by default, and can't add networks, so its message says where the switch is.
  const ensureChain = useCallback(async (): Promise<boolean> => {
    try {
      await switchChainAsync({ chainId: CHAIN.id });
      return true;
    } catch {
      const phantom = /phantom/i.test(active?.name ?? "");
      setError(phantom
        ? `Switch Phantom to ${CHAIN.name}: Settings → Active Networks → turn on ${CHAIN.name}, then retry.`
        : `Switch your wallet to ${CHAIN.name} to continue.`);
      return false;
    }
  }, [switchChainAsync, active]);

  return { connect, connecting, error, ensureChain };
}

export function CensusConnect() {
  const { address, isConnected } = useAccount();
  const { connect, connecting, error } = useWalletConnect();
  const nav = useNavigate();
  if (!isConnected)
    return (
      <button className="cx-quiet" onClick={connect} title={error || undefined} style={{ whiteSpace: "nowrap" }}>
        {connecting ? "Connecting…" : error ? "Connect wallet — retry" : "Connect wallet"}
      </button>
    );
  return (
    <button className="cx-quiet" onClick={() => nav("/profile")} title="Profile" style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--census-lime)" }} />
      <span className="cx-num" style={{ fontSize: 13 }}>{shortAddr(address)}</span>
    </button>
  );
}

export function AppShell({ active, topbar, children }: { active: string; topbar: ReactNode; children: ReactNode }) {
  return (
    <div className="cx-app">
      <aside className="cx-side">
        <Link className="cx-wordmark" to="/">census.fund</Link>
        <nav className="cx-nav">
          {NAV.map((n) => (
            <Link key={n.key} to={n.to} aria-current={active === n.key ? "page" : undefined}>
              <Icon name={n.icon} /><span>{n.label}</span>
            </Link>
          ))}
        </nav>
        <Link className="cx-cta" to="/create">Create coin</Link>
        <div className="cx-side-meta">
          <div>{CHAIN.name}</div>
          <div>chainId {CHAIN.id}</div>
          <b>Crack the <i>c0de</i>.</b>
        </div>
      </aside>
      <div style={{ minWidth: 0 }}>
        <div className="cx-topbar">{topbar}</div>
        <div className="cx-page">{children}</div>
      </div>
      <MobileTabBar active={active} />
    </div>
  );
}

export const MobileTabBar = ({ active }: { active: string }) => (
  <nav className="cx-tabbar">
    {MOBILE_TABS.map((t) => (
      <Link key={t.key} to={t.to} aria-current={active === t.key ? "page" : undefined}>
        {/* Uniform-height icon zone so the Create pill and the plain icons share one baseline. */}
        <span className="cx-tabbar__icon">
          {t.action ? <span className="cx-tabbar__create"><Icon name={t.icon} size={16} /></span> : <Icon name={t.icon} size={19} />}
        </span>
        <span>{t.label}</span>
      </Link>
    ))}
  </nav>
);

/* Transaction tape — renders the single hidden line until a real feed exists (no fabricated trades). The
 * events shape is what the indexer's websocket will push. */
export function Tape({ events }: { events?: { id: string; kind: string; actor: string; amount?: string; quote?: string; coinName: string }[] }) {
  if (!events?.length) {
    return (
      <div className="cx-tape">
        <span className="cx-tape__item" style={{ borderRight: 0 }}>
          <span className="cx-tape__dot cx-tape__dot--off" />
          <span className="cx-tape__action">The tape resumes once the indexer is connected</span>
        </span>
      </div>
    );
  }
  return (
    <div className="cx-tape">
      {events.map((e) => (
        <span className="cx-tape__item" key={e.id}>
          <span className={`cx-tape__dot cx-tape__dot--${e.kind}`} />
          <span className="cx-tape__who">{shortAddr(e.actor)}</span>
          <span className="cx-tape__action">{e.kind === "create" ? "started" : `${e.kind === "buy" ? "bought" : "sold"} ${e.amount} ${e.quote} of`}</span>
          <span className="cx-tape__coin">{e.coinName}</span>
        </span>
      ))}
    </div>
  );
}

/* Graduation caption shared by rows and the coin page: "3.10 / 4.00 ETH reserve", or the honest
 * partial when the target isn't known yet. */
export const reserveCaption = (c: { reserve?: number; graduationTarget?: number | null; anchor?: string }) =>
  c.graduationTarget != null
    ? `${(c.reserve ?? 0).toFixed(2)} / ${c.graduationTarget.toFixed(2)} ${c.anchor ?? "ETH"} reserve`
    : `${(c.reserve ?? 0).toFixed(2)} ${c.anchor ?? "ETH"} raised`;

/* -------- shared rows -------- */
export const HomeRow = ({ c }: { c: DisplayCoin }) => (
  <Link className="cx-row cx-grid-home" to={`/coin/${c.address}`}>
    <CxAvatar name={c.name} image={c.image} />
    <span style={{ minWidth: 0 }}>
      <span className="cx-row__name">{c.name}</span>
      <span className="cx-row__meta">${c.symbol}</span>
    </span>
    <span className="cx-row__meta" style={{ marginTop: 0 }}>{shortAddr(c.creator)} · {c.age}</span>
    <span>
      <GraduationBar pct={c.graduation ?? 0} />
      <span className="cx-label" style={{ display: "block", marginTop: 8 }}>
        {(c.graduation ?? 0) >= 100 ? "Graduated · pool locked" : `${fmtPct(c.graduation)} to graduation`}
      </span>
    </span>
    <span style={{ textAlign: "right", fontSize: 15 }}><Num>{fmtUsd(c.marketCap)}</Num></span>
    <span className="cx-row__meta" style={{ marginTop: 0, textAlign: "right" }}>{isPending("replies") ? "—" : `${c.replies} replies`}</span>
  </Link>
);

export const TrendingCard = ({ c, king }: { c: DisplayCoin; king?: boolean }) => (
  <Link to={`/coin/${c.address}`} className={`cx-panel${king ? " cx-panel--hilite" : " cx-panel--plain"}`} style={{ padding: 22, textDecoration: "none", color: "var(--census-text)" }}>
    <div className="cx-label" aria-hidden={!king} style={{ height: 14, color: king ? "var(--census-lime)" : "transparent" }}>King of the hill</div>
    <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16 }}>
      <CxAvatar name={c.name} image={c.image} />
      <span style={{ minWidth: 0 }}>
        <span className="cx-row__name">{c.name}</span>
        <span className="cx-row__meta">${c.symbol}</span>
      </span>
    </div>
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 24 }}>
      <span>
        <span className="cx-label">Market cap</span>
        <span style={{ display: "block", fontSize: 19, marginTop: 6 }}><Num>{fmtUsd(c.marketCap)}</Num></span>
      </span>
      <span className="cx-label">{isPending("replies") ? "—" : `${c.replies} replies`}</span>
    </div>
    <div style={{ marginTop: 20 }}><GraduationBar pct={c.graduation ?? 0} /></div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 9 }}>
      <span className="cx-label" style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <AnchorMark anchor={c.anchor ?? "ETH"} isCoin={c.anchorIsCoin} /> Anchored to {c.anchor ?? "ETH"}
      </span>
      <span className="cx-label">{fmtPct(c.graduation)}</span>
    </div>
  </Link>
);

export function BoardRow({ r }: { r: DisplayCoin }) {
  const g = r.graduation ?? 0;
  return (
    <Link className="cx-row cx-grid-board" to={`/coin/${r.address}`}>
      <span style={{ display: "flex", alignItems: "center", gap: 16, minWidth: 0 }}>
        <CxAvatar name={r.name} image={r.image} />
        <span style={{ minWidth: 0 }}>
          <span className="cx-row__name">{r.name}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 5 }}>
            <span className="cx-row__meta" style={{ marginTop: 0 }}>${r.symbol}</span>
            <span style={{ width: 1, height: 10, background: "var(--census-border)" }} />
            <AnchorMark anchor={r.anchor ?? "ETH"} isCoin={r.anchorIsCoin} />
            <span className="cx-row__meta" style={{ marginTop: 0 }}>{r.anchor ?? "ETH"}</span>
          </span>
        </span>
      </span>
      <span style={{ textAlign: "right", fontSize: 15 }}><Num>{fmtUsd(r.marketCap)}</Num></span>
      <span style={{ textAlign: "right", fontSize: 13.5 }}><Num>{fmtPrice(r.price)}</Num></span>
      <span style={{ textAlign: "right" }}><Num>—</Num></span>
      <span>
        <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <GraduationBar pct={g} />
          <span style={{ width: 42, textAlign: "right" }}><Num kind={g >= 100 ? "key" : "value"}>{fmtPct(r.graduation)}</Num></span>
        </span>
        <span className="cx-label" style={{ display: "block", marginTop: 8 }}>
          {g >= 100 ? "Graduated · pool locked" : reserveCaption(r)}
        </span>
      </span>
      <span style={{ textAlign: "right" }}><Num>—</Num></span>
    </Link>
  );
}
