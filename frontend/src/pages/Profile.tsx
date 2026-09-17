import { useState } from "react";
import { useParams } from "react-router-dom";
import { useAccount, useBalance } from "wagmi";
import { type Address } from "viem";
import { useLaunches } from "../lib/useLaunches";
import { useCurveStats } from "../lib/useCurveStats";
import { CxAvatar, HomeRow, StatBand, PendingPanel, EmptyPanel, Icon, fmtUsd, shortAddr, CHAIN, useWalletConnect, type DisplayCoin } from "../census";
import { IS_MAINNET } from "../config";

const TABS = [
  { key: "created", label: "Created" },
  { key: "held", label: "Held", pending: true },
  { key: "replies", label: "Replies", pending: true },
] as const;

// A profile is a wallet: real balance and the coins it launched (from the launch events). Fees, holdings
// and replies wait on the indexer and keep honest pending slots.
export function Profile() {
  const { address: param } = useParams();
  const { address: me } = useAccount();
  const { connect, signUp, connecting, pending, error: connectError, signOut, session, exportWallet } = useWalletConnect();
  const [exporting, setExporting] = useState(false);
  const addr = (param || me) as Address | undefined;
  const isMine = !!me && (!param || param.toLowerCase() === me.toLowerCase());
  const [tab, setTab] = useState<"created" | "held" | "replies">("created");
  const [copied, setCopied] = useState(false);

  const { coins, loading } = useLaunches();
  const mine = addr ? coins.filter((c) => c.creator.toLowerCase() === addr.toLowerCase()) : [];
  const stats = useCurveStats(mine.map((c) => c.address));
  const bal = useBalance({ address: addr });

  if (!addr) {
    return (
      <div className="cx-panel cx-empty">
        <div className="cx-avatar cx-avatar--wallet" style={{ width: 58, height: 58, margin: "0 auto" }}>0x</div>
        <div className="cx-empty__title" style={{ marginTop: 20 }}>Your address is your profile</div>
        <div className="cx-empty__body">{signUp ? "Connect a wallet, or sign up with email and we'll create one for you." : "Connect to see what you started and what you hold."}</div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap", marginTop: 26 }}>
          <button className="cx-cta" onClick={connect} disabled={connecting}>{pending === "wallet" ? "Connecting…" : "Connect wallet"}</button>
          {signUp && <button className="cx-quiet" onClick={signUp} disabled={connecting}>{pending === "signup" ? "Signing up…" : "Sign up"}</button>}
        </div>
        {connectError && <div style={{ marginTop: 14, fontSize: 13, color: "#e06c60", maxWidth: 320, marginLeft: "auto", marginRight: "auto" }}>{connectError}</div>}
      </div>
    );
  }

  const created: DisplayCoin[] = mine.map((c) => {
    const s = stats[c.address.toLowerCase()];
    return {
      address: c.address, name: c.name, symbol: c.symbol, creator: c.creator, age: c.age,
      anchor: s?.anchor ?? "ETH", marketCap: s?.mcapUsd ?? null, graduation: s?.gradPct ?? 0, graduated: s?.graduated, reserve: s?.reserve, graduationTarget: s?.graduationTarget, quoteAddress: s?.quoteAddress, anchorIsCoin: s?.anchorIsCoin,
    };
  });
  const best = created.reduce<DisplayCoin | null>((b, c) => (c.marketCap != null && (!b || (b.marketCap ?? 0) < c.marketCap) ? c : b), null);
  const balStr = bal.data ? `${Number(bal.data.formatted).toFixed(3)} ${bal.data.symbol}` : "—";
  const copy = () => { navigator.clipboard?.writeText(addr); setCopied(true); setTimeout(() => setCopied(false), 1200); };

  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 24 }}>
        <CxAvatar name={addr.slice(2, 4)} wallet />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="cx-label">On {CHAIN.name}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 14 }}>
            <h1 className="cx-num" style={{ margin: 0, fontWeight: 400, fontSize: 31, letterSpacing: "-0.01em" }}>{shortAddr(addr)}</h1>
            <button className="cx-link-control" onClick={copy} aria-label="Copy address">{copied ? "Copied" : <Icon name="copy" size={16} />}</button>
            {/* Lets people switch wallets: disconnect (or sign out), then connect again. */}
            {isMine && <button className="cx-link-control" onClick={() => { signOut(); }}>{session.method ? "Sign out" : "Disconnect"}</button>}
            {isMine && exportWallet && (
              <button className="cx-link-control" disabled={exporting} onClick={async () => { setExporting(true); try { await exportWallet(); } finally { setExporting(false); } }}>Export wallet</button>
            )}
          </div>
          {isMine && session.method && <div className="cx-label" style={{ marginTop: 10 }}>Signed in with {session.method}</div>}
        </div>
      </div>

      {/* A wallet created at sign-up starts empty: say plainly how to fund it. */}
      {isMine && session.embedded && bal.data && bal.data.value === 0n && (
        <div className="cx-panel cx-panel--plain" style={{ marginTop: 28 }}>
          <div className="cx-section-title" style={{ marginBottom: 10 }}>Add funds</div>
          <div className="cx-stat__note" style={{ marginTop: 0, lineHeight: 1.55 }}>
            {IS_MAINNET
              ? `Trading and launching need ETH on ${CHAIN.name}. Send it to your address above: withdraw from the Robinhood app or an exchange and choose ${CHAIN.name} as the network, or send from another wallet.`
              : `This is ${CHAIN.name}. Get test ETH from the Robinhood Chain testnet faucet and send it to your address above.`}
          </div>
          <button className="cx-quiet" style={{ marginTop: 14 }} onClick={copy}>{copied ? "Address copied" : "Copy my address"}</button>
        </div>
      )}

      <div style={{ marginTop: 36 }}>
        <StatBand stats={[
          { label: "Companies started", value: loading ? "—" : String(created.length), note: "From the launch events", key: true },
          { label: "Wallet balance", value: balStr, note: "Live on-chain" },
          { label: "Fees earned", value: "—", note: "Pending indexer" },
          { label: "Best company", value: best ? fmtUsd(best.marketCap) : "—", note: best ? best.name : loading ? "Loading" : "No launches yet" },
        ]} />
      </div>

      <div role="tablist" style={{ display: "flex", gap: 36, marginTop: 52, borderBottom: "1px solid var(--census-border)" }}>
        {TABS.map((t) => (
          <button key={t.key} role="tab" onClick={() => setTab(t.key)} aria-selected={tab === t.key}
            style={{ background: "none", border: 0, cursor: "pointer", fontSize: 16, padding: "0 2px 16px", marginBottom: -1,
              color: tab === t.key ? "var(--census-text)" : "var(--census-text-muted)",
              borderBottom: `1px solid ${tab === t.key ? "var(--census-lime)" : "transparent"}` }}>
            {t.label}
            <span className="cx-num" style={{ fontSize: 11.5, color: "var(--census-text-muted)", marginLeft: 10 }}>{"pending" in t && t.pending ? "—" : loading ? "—" : created.length}</span>
          </button>
        ))}
      </div>

      <div style={{ marginTop: 8 }}>
        {tab === "created"
          ? loading
            ? <PendingPanel line="Loading companies" />
            : created.length
              ? <div className="cx-table">{created.map((c) => <HomeRow key={c.address} c={c} />)}</div>
              : <EmptyPanel title="Nothing started yet" body="Create a coin and it lands here." />
          : tab === "held"
            ? <PendingPanel line="Holdings appear once the indexer is connected" note="The wallet balance above is live on-chain." />
            : <PendingPanel line="Replies appear once the indexer is connected" />}
      </div>
    </>
  );
}
