import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAccount, useBalance, usePublicClient, useWriteContract } from "wagmi";
import { formatUnits, type Address } from "viem";
import { useLaunches, type LaunchedCoin } from "../lib/useLaunches";
import { useCurveStats } from "../lib/useCurveStats";
import { readRewards, hasClaimable, type Rewards } from "../lib/rewards";
import { readCurve } from "../lib/curves";
import { vaultAbi } from "../abis";
import { CxAvatar, HomeRow, StatBand, PendingPanel, EmptyPanel, Icon, Num, fmtUsd, fmtAmount, shortAddr, CHAIN, useWalletConnect, type DisplayCoin } from "../census";
import { IS_MAINNET, pctLabel } from "../config";

type WalletReward = { coin: LaunchedCoin; rewards: Rewards };

// Claimable holder rewards for a wallet across the V4 launches that have a reflection vault: one
// withdrawableOf read per basket asset per vault, straight off the vaults (no indexer needed).
function useWalletRewards(addr: Address | undefined, coins: LaunchedCoin[], nonce: number): { rewards: WalletReward[] | null; vaults: number } {
  const pc = usePublicClient({ chainId: CHAIN.id });
  const [rewards, setRewards] = useState<WalletReward[] | null>(null);
  const vaultCoins = coins.filter((c) => c.venue === "v4" && !!c.vault);
  const key = vaultCoins.map((c) => c.address.toLowerCase()).sort().join(",");
  useEffect(() => {
    let cancelled = false;
    setRewards(null);
    if (!pc || !addr) return;
    if (!vaultCoins.length) { setRewards([]); return; }
    (async () => {
      const found = await Promise.all(vaultCoins.map(async (coin): Promise<WalletReward | null> => {
        try {
          const quote = coin.quote ?? (await readCurve(pc, coin.address))?.quote;
          if (!quote || !coin.vault) return null;
          const r = await readRewards(pc, coin.vault, quote, addr);
          return hasClaimable(r) ? { coin, rewards: r } : null;
        } catch { return null; }
      }));
      if (!cancelled) setRewards(found.filter((x): x is WalletReward => !!x));
    })();
    return () => { cancelled = true; };
  }, [pc, addr, key, nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  return { rewards, vaults: vaultCoins.length };
}

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
  const { connect, signUp, connecting, pending, error: connectError, signOut, session, exportWallet, ensureChain } = useWalletConnect();
  const [exporting, setExporting] = useState(false);
  const addr = (param || me) as Address | undefined;
  const isMine = !!me && (!param || param.toLowerCase() === me.toLowerCase());
  const [tab, setTab] = useState<"created" | "held" | "replies">("created");
  const [copied, setCopied] = useState(false);

  const { coins, loading } = useLaunches();
  const mine = addr ? coins.filter((c) => c.creator.toLowerCase() === addr.toLowerCase()) : [];
  const stats = useCurveStats(mine.map((c) => c.address));
  const bal = useBalance({ address: addr });
  // Claimable reflection rewards across V4 launches this wallet holds (any vault with withdrawableOf > 0).
  const [rewardNonce, setRewardNonce] = useState(0);
  const { rewards: claimables, vaults } = useWalletRewards(addr, coins, rewardNonce);
  const publicClient = usePublicClient({ chainId: CHAIN.id });
  const { writeContractAsync } = useWriteContract();
  const [claimingVault, setClaimingVault] = useState<string | null>(null);
  const [claimStatus, setClaimStatus] = useState("");
  async function claimFrom(vault: Address) {
    if (!publicClient || claimingVault) return;
    setClaimStatus(""); setClaimingVault(vault);
    try {
      if (!(await ensureChain())) { setClaimStatus(`Switch your wallet to ${CHAIN.name}, then claim.`); return; }
      const h = await writeContractAsync({ chainId: CHAIN.id, address: vault, abi: vaultAbi, functionName: "claim" });
      await publicClient.waitForTransactionReceipt({ hash: h });
      setClaimStatus("Claimed ✓");
    } catch (e: any) {
      const raw = String(e?.shortMessage ?? e?.message ?? e ?? "");
      setClaimStatus(/reject|denied|cancel/i.test(raw) ? "Cancelled in your wallet." : raw.slice(0, 140) || "Something went wrong.");
    } finally { setClaimingVault(null); setRewardNonce((n) => n + 1); }
  }

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

      {/* Claimable holder rewards across the V4 launches this wallet holds — read straight off the vaults. */}
      {vaults > 0 && (
        <div className="cx-panel cx-panel--plain" style={{ marginTop: 28 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
            <div className="cx-section-title">Claimable rewards</div>
            <span className="cx-label">{claimables == null ? "Reading vaults…" : `${claimables.length} of ${vaults} reflection ${vaults === 1 ? "launch" : "launches"}`}</span>
          </div>
          {claimables == null ? (
            <div className="cx-stat__note" style={{ marginTop: 0 }}>Checking what this wallet can claim…</div>
          ) : claimables.length === 0 ? (
            <div className="cx-stat__note" style={{ marginTop: 0 }}>Nothing to claim right now. Hold a coin with a holder reflection and its trade fees accrue to you here.</div>
          ) : (
            <div style={{ display: "grid", gap: 14 }}>
              {claimables.map(({ coin, rewards }) => (
                <div key={coin.address} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                    <CxAvatar name={coin.name} size={34} />
                    <div style={{ minWidth: 0 }}>
                      <Link to={`/coin/${coin.address}`} className="cx-link-control" style={{ padding: 0, fontSize: 14, letterSpacing: "inherit", textTransform: "inherit" }}>{coin.name} <span className="cx-num" style={{ color: "var(--census-lime)" }}>${coin.symbol}</span></Link>
                      <div className="cx-label" style={{ marginTop: 4 }}>
                        {coin.reflectionBps != null ? `${pctLabel(coin.reflectionBps)} reflection · ` : ""}
                        {rewards.assets.filter((a) => a.amount > 0n).map((a) => `${fmtAmount(Number(formatUnits(a.amount, a.decimals)), 6)} ${a.ticker}`).join(" · ")}
                      </div>
                    </div>
                  </div>
                  {isMine
                    ? <button className="cx-cta" disabled={!!claimingVault} onClick={() => claimFrom(rewards.vault)}>{claimingVault === rewards.vault ? "Claiming…" : "Claim"}</button>
                    : <Num kind="key">claimable</Num>}
                </div>
              ))}
            </div>
          )}
          {claimStatus && <div className="cx-label" style={{ marginTop: 12, color: "var(--census-text-secondary)" }}>{claimStatus}</div>}
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
