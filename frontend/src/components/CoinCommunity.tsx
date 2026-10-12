import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { formatUnits } from "viem";
import { INDEXER_URL } from "../config";
import { shortAddr, useWalletConnect } from "../census";
import { getCallouts, getHolders, sendCalloutAction, type Callout, type CalloutsResponse, type HoldersResponse } from "../lib/callouts";
import "./coin-community.css";

const waitRemaining = (updatedAt: string) => Math.max(0, 86_400_000 - (Date.now() - Date.parse(updatedAt)));
const errorText = (e: unknown) => e instanceof Error ? e.message.slice(0, 180) : "Please try again.";

export function CoinCommunity({ coin, symbol, decimals }: { coin: string; symbol: string; decimals: number }) {
  const { address } = useAccount();
  const { connect, ensureChain } = useWalletConnect();
  const { signMessageAsync } = useSignMessage();
  const [holders, setHolders] = useState<HoldersResponse | null>(null);
  const [callouts, setCallouts] = useState<CalloutsResponse | null>(null);
  const [holdersError, setHoldersError] = useState("");
  const [calloutsError, setCalloutsError] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const viewer = address?.toLowerCase();
  const mine = callouts?.callouts.find((c) => c.author === viewer);
  const editWait = mine ? waitRemaining(mine.updatedAt) : 0;

  const refresh = useCallback(async () => {
    if (!INDEXER_URL) return;
    const [h, c] = await Promise.allSettled([getHolders(coin), getCallouts(coin, viewer)]);
    if (h.status === "fulfilled") { setHolders(h.value); setHoldersError(""); }
    else setHoldersError("Holder list unavailable. The indexer may be catching up.");
    if (c.status === "fulfilled") { setCallouts(c.value); setCalloutsError(""); }
    else setCalloutsError("Callouts unavailable. Try again shortly.");
  }, [coin, viewer]);

  useEffect(() => {
    setHolders(null); setCallouts(null);
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function act(action: "post" | "like" | "unlike", target?: string) {
    if (!address) { await connect(); return; }
    if (busy || !await ensureChain()) return;
    setBusy(true); setNotice("");
    try {
      await sendCalloutAction({ coin, wallet: address, action, text: draft, target,
        sign: async (message) => signMessageAsync({ message }) });
      if (action === "post") { setDraft(""); setNotice("Callout published. You can update it in 24 hours."); }
      await refresh();
    } catch (e) { setNotice(errorText(e)); }
    finally { setBusy(false); }
  }

  return <div className="delos-community">
    <section aria-label="Top holders" className="delos-community__section">
      <div className="delos-community__heading"><div><h2>Top holders</h2><p>On-chain balances · protocol custody excluded · share of total supply</p></div>
        {holders?.available && <span>{holders.totalHolders?.toLocaleString()} holders · finalized block {holders.asOfBlock ?? "—"}</span>}
      </div>
      {!INDEXER_URL ? <p className="delos-community__empty">Connect the Delos indexer to show verified holder balances.</p>
        : holdersError ? <p className="delos-community__empty">{holdersError}</p>
        : !holders ? <p className="delos-community__empty">Loading holder balances…</p>
        : !holders.available ? <p className="delos-community__empty">Holder history is being prepared. Rankings will appear after transfers are indexed from this token’s mint.</p>
        : holders.holders.length === 0 ? <p className="delos-community__empty">No non-custody holders indexed yet.</p>
        : <div className="delos-community__holder-wrap"><table className="delos-community__holders"><thead><tr><th>#</th><th>Wallet</th><th>Balance</th><th>Supply</th></tr></thead>
          <tbody>{holders.holders.map((h, i) => <tr key={h.wallet} className={h.wallet === viewer ? "delos-community__mine" : ""}>
            <td>{i + 1}</td><td title={h.wallet}>{shortAddr(h.wallet)}{h.wallet === viewer ? " · you" : ""}</td>
            <td>{Number(formatUnits(BigInt(h.balance), decimals)).toLocaleString(undefined, { maximumFractionDigits: 2 })} {symbol}</td>
            <td>{(h.shareBps / 100).toFixed(2)}%</td>
          </tr>)}</tbody></table></div>}
    </section>

    <section aria-label="Holder callouts" className="delos-community__section">
      <div className="delos-community__heading"><div><h2>Holder callouts</h2><p>Token theses from wallets holding at least 0.5%. Everyone can like other callouts.</p></div>
        <span>One update every 24 hours</span>
      </div>
      {INDEXER_URL && <div className="delos-community__composer">
        {mine && <div className="delos-community__own">Your callout is live. {editWait > 0 ? `You can edit it in ${Math.ceil(editWait / 3_600_000)}h.` : "You can edit it now."}
          {editWait === 0 && !draft && <button type="button" onClick={() => setDraft(mine.text)}>Edit your callout</button>}
        </div>}
        <label htmlFor="delos-callout-text">{mine ? "Update your thesis" : "Write your thesis"}</label>
        <textarea id="delos-callout-text" maxLength={1000} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Why are you bullish on this token? Be specific about the product, team, or market." />
        <div className="delos-community__composer-foot"><span>{draft.trim().length}/1000 · requires a wallet signature, no gas</span>
          <button type="button" disabled={busy || !INDEXER_URL || draft.trim().length < 20 || editWait > 0} onClick={() => { void act("post"); }}>{busy ? "Working…" : address ? mine ? "Update callout" : "Publish callout" : "Connect wallet to publish"}</button>
        </div>
        {notice && <p role="status" className="delos-community__notice">{notice}</p>}
      </div>}
      {!INDEXER_URL ? <p className="delos-community__empty">Callouts will open when the Delos indexer is configured.</p>
        : calloutsError ? <p className="delos-community__empty">{calloutsError}</p>
        : !callouts ? <p className="delos-community__empty">Loading callouts…</p>
        : callouts.callouts.length === 0 ? <p className="delos-community__empty">No callouts yet. Be the first holder to write one.</p>
        : <div className="delos-community__cards">{callouts.callouts.map((c) => <CalloutCard key={c.id} item={c} viewer={viewer} busy={busy} onLike={(action) => { void act(action, c.id); }} />)}</div>}
    </section>
  </div>;
}

function CalloutCard({ item, viewer, busy, onLike }: { item: Callout; viewer?: string; busy: boolean; onLike: (action: "like" | "unlike") => void }) {
  return <article className={`delos-community__card${item.officialCompany ? " delos-community__card--company" : ""}`}>
    <div className="delos-community__card-head"><div><strong>{item.officialCompany ? "OFFICIAL COMPANY CALLOUT" : "HOLDER THESIS"}</strong>
      <span title={item.author}>{shortAddr(item.author)} · {new Date(item.updatedAt).toLocaleString()}</span></div>
      {item.officialCompany && <span className="delos-community__verified">Verified company wallet</span>}
    </div>
    <p>{item.text}</p>
    <button type="button" className={item.likedByViewer ? "delos-community__liked" : ""} disabled={busy || viewer === item.author}
      onClick={() => onLike(item.likedByViewer ? "unlike" : "like")} aria-label={`${item.likedByViewer ? "Unlike" : "Like"} callout by ${shortAddr(item.author)}`}>
      {item.likedByViewer ? "♥" : "♡"} {item.likes}
    </button>
  </article>;
}
