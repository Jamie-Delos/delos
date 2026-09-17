import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useAccount, usePublicClient, useSendTransaction, useWriteContract } from "wagmi";
import { parseUnits, formatUnits, type Address } from "viem";
import { CONTRACTS, DEFAULT_FEE, QUOTE, SWAP_HAS_DEADLINE, CHAIN } from "../config";
import { wethAbi, erc20Abi, swapRouterAbi, swapRouterV1Abi, censusCurveAbi } from "../abis";
import { zeroExPrice, zeroExQuote, allowanceSpender, routeSummary } from "../lib/zeroex";
import { ANCHORS, ETH_USD } from "../lib/anchors";
import { useCoinQuote } from "../lib/useCoinQuote";
import { COINS } from "../lib/mock";
import { usd, price as fmtPrice, short } from "../lib/format";
import { CxAssetLogo, Num, StatBand, PendingPanel, GraduationBar, Icon, feeBreakdown, GRADUATION_RESERVE_ETH, initials, useWalletConnect } from "../census";

export function Coin() {
  const { address } = useParams();
  const { address: me, isConnected } = useAccount();
  const { connect, connecting, ensureChain } = useWalletConnect();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();

  const coin = COINS.find((c) => c.address.toLowerCase() === (address || "").toLowerCase())
    ?? { address: address || "", emoji: "🪙", name: "Token", symbol: "TOKEN", creator: "0x000000", age: "just now", mcap: 1200, price: 0.0000012, change24: 0, replies: 0, desc: "" };

  const [buy, setBuy] = useState(true);
  const [amount, setAmount] = useState("0.1");
  const [tf, setTf] = useState("1h");
  const [status, setStatus] = useState("");
  const [quoteOut, setQuoteOut] = useState("");
  const [via, setVia] = useState("");
  const [gradBps, setGradBps] = useState<number | null>(null);
  const [curveFeeBps, setCurveFeeBps] = useState<number | null>(null);

  const ZERO = "0x0000000000000000000000000000000000000000";

  // What this coin is actually paired against (WETH default, or HOOD, …) + its real name/symbol.
  const cq = useCoinQuote(coin.address);
  const quote = cq.quote;
  const isWethQuote = quote.toLowerCase() === CONTRACTS.weth.toLowerCase();
  const quoteSym = ANCHORS.find((a) => a.quote.toLowerCase() === quote.toLowerCase())?.key ?? QUOTE;
  // Non-graduated + registered on the curve → use its base fee and any active launch tax.
  // Graduated (or unknown/preview) coins fall through to the 0x/pool path below.
  const curveAddr = CONTRACTS.curve;
  const hasCurve = curveAddr !== ZERO;
  const onCurve = hasCurve && !!cq.routed && !cq.graduated;
  // The launch fee depends on the buyer and chain timestamp; never label it as a flat 2%.
  useEffect(() => {
    let cancelled = false;
    setCurveFeeBps(null);
    if (!onCurve || !publicClient) return;
    const refresh = async () => {
      try {
        const fee = buy ? Number(await publicClient.readContract({ address: curveAddr, abi: censusCurveAbi,
          functionName: "buyFeeBps", args: [coin.address as Address, me ?? ZERO] })) : 200;
        if (!cancelled) setCurveFeeBps(fee);
      } catch { if (!cancelled) setCurveFeeBps(null); }
    };
    void refresh();
    const interval = setInterval(refresh, 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [onCurve, publicClient, curveAddr, coin.address, me, buy]);
  const coinName = cq.name ?? coin.name;
  const coinSym = cq.symbol ?? coin.symbol;

  // Live spot price + market cap, straight off the curve (no indexer needed): spot = virtualQuote /
  // (tokenReserve + virtualTokenOffset) (quote per token). USD via the app's ETH_USD calibration for ETH-quoted coins; for a
  // non-ETH anchor we show the price in that anchor's units. Stays null (shows "new") until the coin is
  // registered on the curve with reserves. Richer stats (24h, holders, history) need the indexer.
  const liveStats = onCurve && cq.virtualQuote != null && cq.tokenReserve != null && cq.virtualTokenOffset != null && cq.tokenReserve > 0n;
  const quoteDec = ANCHORS.find((a) => a.quote.toLowerCase() === quote.toLowerCase())?.quoteDecimals ?? 18;
  const priceQuote = liveStats ? (Number(cq.virtualQuote) / 10 ** quoteDec) / (Number(cq.tokenReserve! + cq.virtualTokenOffset!) / 1e18) : null;
  const supply = cq.totalSupply != null ? Number(cq.totalSupply) / 1e18 : null;
  const priceUsd = priceQuote != null && isWethQuote ? priceQuote * ETH_USD : null;
  const mcapUsd = priceUsd != null && supply != null ? priceUsd * supply : null;
  const creatorDisp = cq.creator ? short(cq.creator) : coin.creator && coin.creator !== "0x000000" ? coin.creator : "—";
  const priceDisp = priceUsd != null ? fmtPrice(priceUsd) : priceQuote != null ? `${priceQuote.toPrecision(3)} ${quoteSym}` : "new";
  const mcapDisp = mcapUsd != null ? usd(mcapUsd) : priceQuote != null && supply != null ? `${(priceQuote * supply).toPrecision(3)} ${quoteSym}` : "new";

  // Live indicative "you receive ≈" as the user types (debounced). On the bonding curve this reads
  // quoteBuy/quoteSell (net of the current fee) straight off the curve; for graduated coins it falls back to
  // the 0x proxy. Stays blank when there's no route (brand-new coin) or the dev proxy isn't running.
  useEffect(() => {
    let cancelled = false;
    const coinAddr = coin.address as Address;
    const n = Number(amount);
    if (!coinAddr || !amount || !Number.isFinite(n) || n <= 0) { setQuoteOut(""); setVia(""); return; }
    const t = setTimeout(async () => {
      try {
        if (onCurve && publicClient) {
          const amt = parseUnits(amount, 18);
          const out = (await publicClient.readContract({
            address: curveAddr, abi: censusCurveAbi,
            functionName: buy ? "quoteBuy" : "quoteSell", args: [coinAddr, amt], account: me ?? ZERO,
          })) as bigint;
          if (cancelled) return;
          setQuoteOut(out > 0n ? formatUnits(out, 18) : "");
          setVia(out > 0n ? "census curve" : "");
          return;
        }
        const sellToken = buy ? quote : coinAddr;
        const buyToken = buy ? coinAddr : quote;
        const q = await zeroExPrice({ sellToken, buyToken, sellAmount: parseUnits(amount, 18), taker: me, slippageBps: 200 });
        if (cancelled) return;
        if (q.liquidityAvailable === false || !q.buyAmount) { setQuoteOut(""); setVia(""); return; }
        setQuoteOut(formatUnits(BigInt(q.buyAmount), 18));
        setVia(routeSummary(q));
      } catch { if (!cancelled) { setQuoteOut(""); setVia(""); } }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [amount, buy, coin.address, me, quote, onCurve, curveAddr, publicClient, curveFeeBps]);

  // Live graduation progress (bps 0..10000) straight off the curve. Replaces the old hardcoded 42%.
  useEffect(() => {
    let cancelled = false;
    const coinAddr = coin.address as Address;
    if (!publicClient || !hasCurve || (coinAddr || "").length !== 42) { setGradBps(null); return; }
    (async () => {
      try {
        const bps = (await publicClient.readContract({
          address: curveAddr, abi: censusCurveAbi, functionName: "graduationProgress", args: [coinAddr],
        })) as bigint;
        if (!cancelled) setGradBps(Number(bps));
      } catch { if (!cancelled) setGradBps(null); }
    })();
    return () => { cancelled = true; };
  }, [coin.address, publicClient, curveAddr, hasCurve, cq.graduated]);

  async function trade() {
    setStatus("");
    if (!isConnected || !me || !publicClient) { setStatus("connect your wallet to trade"); return; }
    const coinAddr = coin.address as Address;
    let amountIn: bigint;
    try { amountIn = parseUnits(amount || "0", 18); } catch { setStatus("enter a valid amount"); return; }
    if (amountIn <= 0n) { setStatus("enter an amount"); return; }
    // On the right network first — otherwise the trade goes to whatever chain the wallet is on and fails.
    if (!(await ensureChain())) { setStatus(`switch your wallet to ${CHAIN.name}, then trade`); return; }
    const sellToken = buy ? quote : coinAddr;
    const buyToken = buy ? coinAddr : quote;
    try {
      // Non-graduated coin → trade against the CensusCurve. There is no pool to route around, so the
      // current launch/base fee is taken on-chain (75% creator-side / 25% platform). BUY approves `quoteIn`
      // of the quote asset to the curve then curve.buy; SELL approves the coin then curve.sell. Works
      // for ETH- and HOOD-quoted coins.
      if (onCurve) {
        // Refresh immediately before submitting; do not trade with a missing/stale quote and minOut=0.
        const currentQuote = await publicClient.readContract({ address: curveAddr, abi: censusCurveAbi,
          functionName: buy ? "quoteBuy" : "quoteSell", args: [coinAddr, amountIn], account: me });
        if (currentQuote <= 0n) { setStatus("no executable curve quote"); return; }
        const minOut = currentQuote * 98n / 100n;
        const currentFee = buy ? Number(await publicClient.readContract({ address: curveAddr, abi: censusCurveAbi,
          functionName: "buyFeeBps", args: [coinAddr, me] })) : 200;
        setCurveFeeBps(currentFee);
        if (buy) {
          if (isWethQuote) {
            // one-tap: native ETH in, wrapped + bought in a single tx on the curve (no pre-wrap, no approval)
            setStatus(`buying · ${currentFee / 100}% current fee…`);
            const h = await writeContractAsync({ address: curveAddr, abi: censusCurveAbi, functionName: "buyWithETH", args: [coinAddr, minOut], value: amountIn });
            await publicClient.waitForTransactionReceipt({ hash: h });
            setStatus("bought ✓");
          } else {
            // non-ETH anchor (e.g. HOOD): the trader must already hold the quote token
            const bal = (await publicClient.readContract({ address: quote, abi: erc20Abi, functionName: "balanceOf", args: [me] })) as bigint;
            if (bal < amountIn) { setStatus(`you need ${quoteSym} in your wallet to buy this coin`); return; }
            setStatus("approving…");
            const a = await writeContractAsync({ address: quote, abi: erc20Abi, functionName: "approve", args: [curveAddr, amountIn] });
            await publicClient.waitForTransactionReceipt({ hash: a });
            setStatus(`buying · ${currentFee / 100}% current fee…`);
            const h = await writeContractAsync({ address: curveAddr, abi: censusCurveAbi, functionName: "buy", args: [coinAddr, amountIn, minOut] });
            await publicClient.waitForTransactionReceipt({ hash: h });
            setStatus("bought ✓");
          }
        } else {
          setStatus("approving…");
          const a = await writeContractAsync({ address: coinAddr, abi: erc20Abi, functionName: "approve", args: [curveAddr, amountIn] });
          await publicClient.waitForTransactionReceipt({ hash: a });
          // ETH-quoted → sellForETH returns native ETH (unwrapped); non-ETH → sell returns the quote token
          setStatus("selling · 2% fee…");
          const h = await writeContractAsync({ address: curveAddr, abi: censusCurveAbi, functionName: isWethQuote ? "sellForETH" : "sell", args: [coinAddr, amountIn, minOut] });
          await publicClient.waitForTransactionReceipt({ hash: h });
          setStatus(isWethQuote ? "sold ✓ (ETH)" : "sold ✓");
        }
        return;
      }
      // --- graduated coin (or unknown/preview): the coin now trades on a real Uniswap pool ---
      // Buying a WETH-paired coin spends native ETH -> wrap to WETH first (pools and 0x sell WETH).
      // A non-WETH quote (e.g. HOOD) is a token the trader must already hold — no wrap.
      if (buy && isWethQuote) {
        setStatus("wrapping…");
        const w = await writeContractAsync({ address: CONTRACTS.weth, abi: wethAbi, functionName: "deposit", value: amountIn });
        await publicClient.waitForTransactionReceipt({ hash: w });
      }
      // 0x best execution — only for WETH-paired coins. 0x won't route tokenised-stock quotes like
      // HOOD (the same legal restriction that blocks stock buys), so those go straight to the pool.
      if (isWethQuote) {
        const q = await zeroExQuote({ sellToken, buyToken, sellAmount: amountIn, taker: me, slippageBps: 200 }).catch(() => undefined);
        if (q && q.liquidityAvailable !== false && q.transaction?.data) {
          const spender = allowanceSpender(q);
          if (spender) {
            const current = (await publicClient.readContract({ address: sellToken, abi: erc20Abi, functionName: "allowance", args: [me, spender] })) as bigint;
            if (current < amountIn) {
              setStatus("approving…");
              const a = await writeContractAsync({ address: sellToken, abi: erc20Abi, functionName: "approve", args: [spender, amountIn] });
              await publicClient.waitForTransactionReceipt({ hash: a });
            }
          }
          setStatus(`swapping · ${routeSummary(q)}…`);
          const h = await sendTransactionAsync({ to: q.transaction.to, data: q.transaction.data, value: BigInt(q.transaction.value || "0") });
          await publicClient.waitForTransactionReceipt({ hash: h });
          setStatus(buy ? "bought ✓" : "sold ✓");
          return;
        }
      }
      // The coin's own Uniswap V3 pool (quote/coin at the 1% launch tier). This is the path for every
      // HOOD-paired coin, and the fallback for any coin 0x hasn't indexed yet.
      if (buy && !isWethQuote) {
        const bal = (await publicClient.readContract({ address: sellToken, abi: erc20Abi, functionName: "balanceOf", args: [me] })) as bigint;
        if (bal < amountIn) { setStatus(`you need ${quoteSym} in your wallet to buy this coin`); return; }
      }
      setStatus(isWethQuote ? "no 0x route — using the pool…" : `swapping via the ${quoteSym} pool…`);
      const a2 = await writeContractAsync({ address: sellToken, abi: erc20Abi, functionName: "approve", args: [CONTRACTS.swapRouter, amountIn] });
      await publicClient.waitForTransactionReceipt({ hash: a2 });
      const common = { tokenIn: sellToken, tokenOut: buyToken, fee: DEFAULT_FEE, recipient: me, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
      const h2 = SWAP_HAS_DEADLINE
        ? await writeContractAsync({ address: CONTRACTS.swapRouter, abi: swapRouterV1Abi, functionName: "exactInputSingle", args: [{ ...common, deadline: BigInt(Math.floor(Date.now() / 1000) + 1200) }] })
        : await writeContractAsync({ address: CONTRACTS.swapRouter, abi: swapRouterAbi, functionName: "exactInputSingle", args: [common] });
      await publicClient.waitForTransactionReceipt({ hash: h2 });
      setStatus(buy ? "bought ✓ (pool)" : "sold ✓ (pool)");
    } catch (e: any) { setStatus(e?.shortMessage ?? e?.message ?? String(e)); }
  }

  // Live values for the census render. Graduation %: 100 once graduated, else the live curve progress.
  const gradPct = cq.graduated ? 100 : gradBps != null ? Math.min(100, Math.round(gradBps / 100)) : 0;
  const anchor = quoteSym;
  const tier = cq.isV2 ? "Maxima" : "Prima";
  const reserveEth = cq.realQuote != null ? Number(cq.realQuote) / 10 ** quoteDec : 0;
  const feeAmt = onCurve
    ? buy ? (Number(amount) || 0) * (curveFeeBps ?? 0) / 10000 : (Number(quoteOut) || 0) * 200 / 9800
    : feeBreakdown(Number(amount) || 0).fee;
  const graduated = !!cq.graduated;

  return (
    <div className="cx-coin">
      {/* main column */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 20 }}>
          <span className="cx-avatar" style={{ width: 80, height: 80, fontSize: 20 }}>{initials(coinName)}</span>
          <div style={{ minWidth: 0 }}>
            <div className="cx-label">{tier} · anchored to {anchor}</div>
            <h1 className="cx-h1" style={{ fontSize: 40, marginTop: 10 }}>{coinName}</h1>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 14, flexWrap: "wrap" }}>
              <span className="cx-num" style={{ fontSize: 13, color: "var(--census-text-secondary)" }}>${coinSym}</span>
              <Sep />
              <span className="cx-num" style={{ fontSize: 13, color: "var(--census-text-secondary)" }}>Started by {creatorDisp} · {coin.age}</span>
              <Sep />
              <button className="cx-link-control" onClick={() => navigator.clipboard?.writeText(coin.address)} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <span className="cx-num">{coin.address.slice(0, 6)}…{coin.address.slice(-6, -4)}<span style={{ color: "var(--census-lime)" }}>{coin.address.slice(-4)}</span></span>
                <Icon name="copy" size={14} />
              </button>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 40 }}>
          <StatBand stats={[
            { label: "Market cap", value: mcapDisp, note: "Live from the curve", key: true },
            { label: "Price", value: priceDisp, note: "Live from the curve" },
            { label: "24h", value: "—", note: "Pending indexer" },
            { label: "Holders", value: "—", note: "Pending indexer" },
          ]} />
        </div>

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "44px 0 16px" }}>
          <div className="cx-section-title">Price</div>
          <div style={{ display: "flex", gap: 20 }}>{["1m", "5m", "1h", "1d"].map((t) => <button key={t} className="cx-link-control" aria-pressed={tf === t} onClick={() => setTf(t)}>{t}</button>)}</div>
        </div>
        <PendingPanel line="Price history appears once the indexer is connected" note="Price and market cap above are live from the curve." />

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "44px 0 14px" }}>
          <div className="cx-section-title">Graduation</div>
          <span className="cx-label">{graduated ? "Graduated · pool locked" : `${reserveEth.toFixed(2)} / ${GRADUATION_RESERVE_ETH.toFixed(2)} ${anchor} reserve`}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <GraduationBar pct={gradPct} large />
          <span className="cx-num cx-num--key" style={{ fontSize: 24 }}>{gradPct}%</span>
        </div>
        <p style={{ margin: "16px 0 0", fontSize: 14, color: "var(--census-text-secondary)" }}>
          {graduated ? "The curve closed. Liquidity is locked permanently in a Uniswap V3 pool." : `At ${GRADUATION_RESERVE_ETH} ${anchor} the curve closes and liquidity moves to a permanently locked Uniswap V3 pool.`}
        </p>

        <div className="cx-section-title" style={{ marginTop: 44, marginBottom: 16 }}>Holders</div>
        <PendingPanel line="Distribution appears once the indexer is connected." />

        <div className="cx-section-title" style={{ marginTop: 44, marginBottom: 16 }}>Creator fees</div>
        <div className="cx-panel cx-panel--plain" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div className="cx-stat__value"><Num>—</Num></div>
            <div className="cx-stat__note">75% of curve fees accrue to the creator side, including any launch tax.</div>
          </div>
          <span className="cx-cta" aria-disabled="true" style={{ pointerEvents: "none" }}>Collect</span>
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 44, marginBottom: 16 }}>
          <div className="cx-section-title">Thread</div><span className="cx-label">0 replies</span>
        </div>
        <label className="cx-field"><input placeholder="Add to the thread" aria-label="Add to the thread" /><span className="cx-link-control">POST</span></label>
        <div className="cx-label" style={{ marginTop: 14 }}>No replies yet. The thread opens with the indexer.</div>
      </div>

      {/* trade panel */}
      <div>
        <div className="cx-panel" style={{ position: "sticky", top: 24 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, borderBottom: "1px solid var(--census-border)" }}>
            {(["buy", "sell"] as const).map((side) => (
              <button key={side} onClick={() => setBuy(side === "buy")} aria-current={buy === (side === "buy")}
                style={{ background: "none", border: 0, cursor: "pointer", fontSize: 15, paddingBottom: 14, marginBottom: -1,
                  fontWeight: buy === (side === "buy") ? 500 : 400,
                  color: buy === (side === "buy") ? "var(--census-text)" : "var(--census-text-muted)",
                  borderBottom: `1px solid ${buy === (side === "buy") ? "var(--census-lime)" : "transparent"}` }}>
                {side === "buy" ? "Buy" : "Sell"}
              </button>
            ))}
          </div>

          <div className="cx-field" style={{ marginTop: 26, paddingBottom: 14 }}>
            <input value={amount} inputMode="decimal" aria-label="Amount" onChange={(e) => setAmount(e.target.value)}
              style={{ fontFamily: "var(--census-font-mono)", fontSize: 30, fontVariantNumeric: "tabular-nums" }} />
            <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <CxAssetLogo ticker={anchor} size={20} />
              <span className="cx-num" style={{ fontSize: 13, color: "var(--census-text-secondary)" }}>{buy ? anchor : coinSym}</span>
            </span>
          </div>

          <div style={{ display: "flex", gap: 22, marginTop: 16 }}>
            {["0.01", "0.1", "0.5", "1"].map((a) => (
              <button key={a} className="cx-link-control" aria-pressed={amount === a} onClick={() => setAmount(a)}>{a}</button>
            ))}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 28 }}>
            <QuoteRow label="You receive ~" value={quoteOut ? `${Number(quoteOut).toLocaleString(undefined, { maximumSignificantDigits: 6 })} ${buy ? coinSym : anchor}` : "—"} bright />
            <QuoteRow label={onCurve ? `Fee estimate (${curveFeeBps == null ? "loading" : `${curveFeeBps / 100}%`})` : "Fee (2%)"} value={onCurve && curveFeeBps == null ? "—" : `${feeAmt.toFixed(3)} ${anchor}`} />
            {onCurve && buy && curveFeeBps != null && curveFeeBps > 200 && <p role="status">Launch tax active. The buy fee decays to 2% within three seconds of launch; the mined transaction determines the final rate.</p>}
            <QuoteRow label="Slippage" value="2%" />
            <QuoteRow label="Route" value={graduated ? "Locked Uniswap pool" : via && via !== "census curve" ? via : onCurve ? "The Census curve" : `${anchor} pool`} />
          </div>

          <button className="cx-cta" style={{ width: "100%", marginTop: 26, padding: 16, fontSize: 16 }} disabled={connecting} onClick={isConnected ? trade : connect}>{isConnected ? "Place trade" : connecting ? "Connecting…" : "Connect wallet"}</button>
          <div className="cx-label" style={{ textAlign: "center", marginTop: 14 }}>2% trade fee</div>
          {status && <div className="cx-label" style={{ textAlign: "center", marginTop: 10, color: "var(--census-text-secondary)" }}>{status}</div>}
        </div>

        <div className="cx-panel cx-panel--plain" style={{ marginTop: 16 }}>
          <div className="cx-label" style={{ marginBottom: 14 }}>The curve</div>
          <CurveRow k="Supply" v="1,000,000,000" />
          <CurveRow k="Anchored to" v={anchor} />
          <CurveRow k="Graduation at" v={`${GRADUATION_RESERVE_ETH} ${anchor}`} />
          <CurveRow k="Trade fee" v="2%" />
        </div>
      </div>
    </div>
  );
}

const Sep = () => <span style={{ width: 1, height: 11, background: "var(--census-border)" }} />;

const QuoteRow = ({ label, value, bright }: { label: string; value: string; bright?: boolean }) => (
  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
    <span style={{ fontSize: 13.5, color: "var(--census-text-secondary)" }}>{label}</span>
    <span className="cx-num" style={{ fontSize: 13, color: bright ? "var(--census-bone)" : "var(--census-text-secondary)" }}>{value}</span>
  </div>
);

const CurveRow = ({ k, v }: { k: string; v: string }) => (
  <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "6px 0", fontSize: 13 }}>
    <span style={{ color: "var(--census-text-secondary)" }}>{k}</span>
    <span className="cx-num">{v}</span>
  </div>
);
