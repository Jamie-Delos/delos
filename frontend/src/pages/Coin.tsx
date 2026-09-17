import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useAccount, usePublicClient, useSendTransaction, useSignMessage, useWriteContract } from "wagmi";
import { parseUnits, formatUnits, isAddress, zeroAddress, type Address } from "viem";
import { CONTRACTS, DEFAULT_FEE, CHAIN, TRADE_FEE_BPS, TRADE_FEE_LABEL } from "../config";
import { wethAbi, erc20Abi, swapRouterAbi, censusCurveAbi, vaultAbi } from "../abis";
import { zeroExPrice, zeroExQuote, allowanceSpender, routeSummary } from "../lib/zeroex";
import { cachedQuoteUsd, quoteInfo, type QuoteInfo } from "../lib/anchors";
import { poolSpotOut, poolQuoteOut, poolTwapDeviationBps } from "../lib/pool";
import { useCoinQuote } from "../lib/useCoinQuote";
import { useLaunches } from "../lib/useLaunches";
import { useCurveStats } from "../lib/useCurveStats";
import { getMetadata, pendingMetadata, retryPendingMetadata, type CoinMetadata } from "../lib/metadata";
import { curveSpot } from "../lib/curveOffset";
import { readRewards, type Rewards } from "../lib/rewards";
import { CxAvatar, AnchorMark, HomeRow, Num, StatBand, PendingPanel, GraduationBar, Icon, fmtUsd, fmtPrice, fmtAmount, shortAddr, reserveCaption, useWalletConnect, type DisplayCoin } from "../census";

const SLIPPAGE_BPS = 200; // 2% — the default minimum-out tolerance; user-adjustable (see SLIPPAGE_PRESETS)
const SLIPPAGE_PRESETS = [50, 200, 500, 1000]; // 0.5% / 2% / 5% / 10% — a shallow post-graduation pool may need more
// CX-H1: a graduated pool's minimum-out is derived from the live spot; refuse to trade when the spot has
// moved more than this from the pool TWAP (manipulation, or a violent move) rather than execute against a
// number an attacker could have set one block earlier. A warming pool with no TWAP yet is allowed on spot.
const MAX_POOL_DEVIATION_BPS = 1000; // 10%
const BUY_PRESETS = ["0.01", "0.1", "0.5", "1"];
const SELL_PRESETS = [25, 50, 75, 100]; // % of the coins you hold

const friendly = (e: any) => {
  const raw = String(e?.shortMessage ?? e?.message ?? e ?? "");
  if (/reject|denied|cancel/i.test(raw)) return "Cancelled in your wallet.";
  return raw.slice(0, 140) || "Something went wrong.";
};

export function Coin() {
  const { address: param } = useParams();
  const loc = useLocation();
  const coinAddr = param && isAddress(param) ? (param as Address) : undefined;
  const { address: me, isConnected } = useAccount();
  const { connect, signUp, connecting, pending, error: connectError, ensureChain } = useWalletConnect();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const { signMessageAsync } = useSignMessage();
  const [retryNonce, setRetryNonce] = useState(0); // bumped by the "couldn't reach the chain" retry
  const [slippageBps, setSlippageBps] = useState(SLIPPAGE_BPS); // user-chosen minimum-out tolerance
  const cq = useCoinQuote(coinAddr, retryNonce);

  const [buy, setBuy] = useState(true);
  const [amount, setAmount] = useState("0.1");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [quoteOut, setQuoteOut] = useState<bigint | null>(null); // what you'd receive, raw units of the out-asset
  const [via, setVia] = useState("");
  const [gradBps, setGradBps] = useState<number | null>(null);
  const [meta, setMeta] = useState<CoinMetadata | null>(null);
  const [copied, setCopied] = useState(false);
  const [coinBal, setCoinBal] = useState<bigint | null>(null);
  const [quoteBal, setQuoteBal] = useState<bigint | null>(null);
  const [quoteUsd, setQuoteUsd] = useState<number | null>(null);
  const [qi, setQi] = useState<QuoteInfo | null>(null); // the anchor's symbol/decimals (menu asset or company coin)
  const [poolPrice, setPoolPrice] = useState<number | null>(null); // quote per coin, graduated coins only
  const [rewards, setRewards] = useState<Rewards | null>(null); // Maxima: the holder's claimable basket
  const [claiming, setClaiming] = useState(false);
  const [buyFeeBps, setBuyFeeBps] = useState<number | null>(null); // this buyer's current curve buy fee (2% + any launch tax)
  const [maxIn, setMaxIn] = useState<bigint | null>(null); // gross quote the curve still accepts before it fills
  const [savingMeta, setSavingMeta] = useState(false);
  const [tick, setTick] = useState(0); // bumps after a trade/claim to refresh balances, quote and rewards

  // What this coin is anchored to (WETH default, HOOD, or another Census coin) and where it trades now.
  const quote = cq.quote;
  const anchor = qi?.symbol ?? "ETH";
  const quoteDec = qi?.decimals ?? 18;
  const anchorIsCoin = !!qi?.isCoin;
  const isWethQuote = quote.toLowerCase() === CONTRACTS.weth.toLowerCase();
  const hasCurve = CONTRACTS.curve !== zeroAddress;
  const registered = !!cq.routed;
  const graduated = !!cq.graduated;
  const onCurve = registered && !graduated; // pre-graduation: every trade is on the CensusCurve
  const poolFee = cq.routerPoolFee || DEFAULT_FEE;
  const coinName = cq.name ?? (cq.resolved ? "Unknown token" : "…");
  const coinSym = cq.symbol ?? "";
  const tier = cq.isV2 ? "Maxima" : "Prima";
  const hasVault = !!cq.vault && cq.vault !== zeroAddress;
  const tradeBlock = !hasCurve ? "Trading isn't configured on this deployment." : cq.resolved && !registered ? "This address isn't a Census coin." : "";
  const canTrade = hasCurve && cq.resolved && registered && !!qi;

  // Coins anchored to THIS coin (only possible once it has graduated — its pool is what they trade through).
  const { coins: allCoins, loading: ecoLoading } = useLaunches(graduated);
  const ecoStats = useCurveStats(graduated ? allCoins.map((c) => c.address) : []);
  const paired: DisplayCoin[] = graduated && coinAddr
    ? allCoins.filter((c) => ecoStats[c.address.toLowerCase()]?.quoteAddress?.toLowerCase() === coinAddr.toLowerCase()).map((c) => {
        const s = ecoStats[c.address.toLowerCase()];
        return { address: c.address, name: c.name, symbol: c.symbol, creator: c.creator, age: c.age, anchor: s?.anchor, anchorIsCoin: s?.anchorIsCoin, marketCap: s?.mcapUsd ?? null, graduation: s?.gradPct ?? 0, graduated: s?.graduated, reserve: s?.reserve, graduationTarget: s?.graduationTarget };
      })
    : [];
  const ecoReady = !ecoLoading && (allCoins.length === 0 || Object.keys(ecoStats).length > 0);

  // Price + market cap. On the curve: spot = virtualQuote / (tokenReserve + virtualTokenOffset), the PF
  // pricing offset being an unminted term the curve exposes. Graduated: the pool's spot. USD via the
  // anchor's live price (null => shown in anchor units, never a made-up dollar figure).
  const curvePrice = onCurve && cq.virtualQuote != null && cq.tokenReserve != null && cq.tokenReserve > 0n
    ? curveSpot(cq.virtualQuote, cq.tokenReserve, cq.virtualTokenOffset ?? null, quoteDec) : null;
  const priceQuote = onCurve ? curvePrice : graduated ? poolPrice : null;
  const supply = cq.totalSupply != null ? Number(cq.totalSupply) / 1e18 : null;
  const priceUsd = priceQuote != null && quoteUsd != null ? priceQuote * quoteUsd : null;
  const mcapUsd = priceUsd != null && supply != null ? priceUsd * supply : null;
  const priceDisp = priceUsd != null ? fmtPrice(priceUsd) : priceQuote != null ? `${priceQuote.toPrecision(3)} ${anchor}` : "—";
  const mcapDisp = mcapUsd != null ? fmtUsd(mcapUsd) : priceQuote != null && supply != null ? `${fmtAmount(priceQuote * supply, 2)} ${anchor}` : "—";
  const liveNote = onCurve ? "Live from the curve" : graduated ? "Live from the pool" : "—";
  const reserve = cq.realQuote != null ? Number(cq.realQuote) / 10 ** quoteDec : 0;
  const graduationTarget = cq.graduationQuote != null && cq.graduationQuote > 0n ? Number(cq.graduationQuote) / 10 ** quoteDec : null;
  const gradPct = graduated ? 100 : gradBps != null ? Math.min(100, Math.round(gradBps / 100)) : 0;

  // The anchor's identity and USD price (both cached across pages).
  useEffect(() => {
    let cancelled = false;
    if (!publicClient || !cq.resolved) return;
    quoteInfo(publicClient, quote).then((i) => { if (!cancelled) setQi(i); });
    cachedQuoteUsd(publicClient, quote).then((p) => { if (!cancelled) setQuoteUsd(p); });
    return () => { cancelled = true; };
  }, [publicClient, quote, cq.resolved]);

  // Graduated coins: spot price from the locked pool (1 anchor unit -> coins).
  useEffect(() => {
    let cancelled = false;
    setPoolPrice(null);
    if (!publicClient || !coinAddr || !graduated || !qi) return;
    poolSpotOut(publicClient, quote, coinAddr, parseUnits("1", quoteDec), poolFee).then((out) => {
      if (cancelled || out == null || out <= 0n) return;
      setPoolPrice(1 / (Number(out) / 1e18));
    });
    return () => { cancelled = true; };
  }, [publicClient, coinAddr, graduated, quote, quoteDec, poolFee, qi, tick]);

  // Off-chain details from the launch wizard (thesis, description, logo) — null until the store is live.
  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    if (!coinAddr) return;
    getMetadata(coinAddr).then((m) => { if (!cancelled) setMeta(m); });
    return () => { cancelled = true; };
  }, [coinAddr]);

  // Your balances: the coin (for the sell presets) and the anchor (native ETH, or the anchor token).
  useEffect(() => {
    let cancelled = false;
    setCoinBal(null); setQuoteBal(null);
    if (!publicClient || !coinAddr || !me || !cq.resolved) return;
    (async () => {
      try {
        const [c, q] = await Promise.all([
          publicClient.readContract({ address: coinAddr, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
          isWethQuote ? publicClient.getBalance({ address: me }) : publicClient.readContract({ address: quote, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
        ]);
        if (!cancelled) { setCoinBal(c); setQuoteBal(q); }
      } catch { /* leave unknown */ }
    })();
    return () => { cancelled = true; };
  }, [publicClient, coinAddr, me, quote, isWethQuote, cq.resolved, tick]);

  // Maxima: what the connected wallet can claim from the rewards vault, and what's waiting to be distributed.
  useEffect(() => {
    let cancelled = false;
    setRewards(null);
    if (!publicClient || !cq.resolved || !hasVault || !cq.vault) return;
    readRewards(publicClient, cq.vault, quote, me).then((r) => { if (!cancelled) setRewards(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [publicClient, cq.resolved, hasVault, cq.vault, quote, me, tick]);

  // This buyer's curve buy fee and the room left before the curve fills. In the three seconds after a
  // launch the buy fee decays from 99% to 2% (creator and bundle wallets exempt), so poll every second
  // while a launch window could be open; otherwise read once per refresh.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setBuyFeeBps(null); setMaxIn(null);
    if (!publicClient || !coinAddr || !onCurve) return;
    const buyer = me ?? zeroAddress;
    const read = async () => {
      try {
        const [fee, room] = await Promise.all([
          publicClient.readContract({ address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "buyFeeBps", args: [coinAddr, buyer] }),
          publicClient.readContract({ address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "maxQuoteInFor", args: [coinAddr, buyer] }),
        ]);
        if (cancelled) return;
        setBuyFeeBps(Number(fee)); setMaxIn(room);
        if (Number(fee) > TRADE_FEE_BPS) timer = setTimeout(read, 1000); // launch window: keep the label live
      } catch { if (!cancelled) { setBuyFeeBps(TRADE_FEE_BPS); setMaxIn(null); } } // legacy curve: flat 2%, no cap
    };
    read();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [publicClient, coinAddr, onCurve, me, tick]);

  // Live graduation progress (bps 0..10000) straight off the curve.
  useEffect(() => {
    let cancelled = false;
    if (!publicClient || !hasCurve || !coinAddr || !registered || graduated) { setGradBps(null); return; }
    publicClient.readContract({ address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "graduationProgress", args: [coinAddr] })
      .then((bps) => { if (!cancelled) setGradBps(Number(bps)); })
      .catch(() => { if (!cancelled) setGradBps(null); });
    return () => { cancelled = true; };
  }, [publicClient, coinAddr, hasCurve, registered, graduated, tick]);

  // Indicative "you receive ~" as the user types (debounced). On the curve this is quoteBuy/quoteSell
  // (fee-net) straight off the contract; graduated WETH-anchored coins ask 0x, everything else reads
  // the pool's spot. Blank when there's no price for the amount.
  useEffect(() => {
    let cancelled = false;
    setQuoteOut(null); setVia("");
    if (!coinAddr || !publicClient || !canTrade) return;
    const n = Number(amount);
    if (!amount || !Number.isFinite(n) || n <= 0) return;
    const t = setTimeout(async () => {
      try {
        const amt = parseUnits(amount, buy ? quoteDec : 18);
        if (onCurve) {
          // Buys quote for THIS buyer (launch tax + exemptions) and are capped at what the curve still
          // accepts; a legacy curve without quoteBuyFor falls back to the plain quote.
          const out = buy
            ? await publicClient.readContract({ address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "quoteBuyFor", args: [coinAddr, amt, me ?? zeroAddress] })
                .catch(() => publicClient.readContract({ address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "quoteBuy", args: [coinAddr, amt] }))
            : await publicClient.readContract({ address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "quoteSell", args: [coinAddr, amt] });
          if (!cancelled) { setQuoteOut(out > 0n ? out : null); setVia(out > 0n ? "curve" : ""); }
          return;
        }
        const sellToken = buy ? quote : coinAddr, buyToken = buy ? coinAddr : quote;
        if (isWethQuote) {
          try {
            const q = await zeroExPrice({ sellToken, buyToken, sellAmount: amt, taker: me, slippageBps: SLIPPAGE_BPS });
            if (cancelled) return;
            if (q.liquidityAvailable !== false && q.buyAmount) { setQuoteOut(BigInt(q.buyAmount)); setVia(routeSummary(q)); return; }
          } catch { /* fall through to the pool */ }
        }
        // "You receive ~" for a direct-pool trade: prefer QuoterV2 (real, price-impact-aware) so the
        // estimate — and the minimum-out derived from it — reflect a shallow pool and don't revert a
        // normal trade. Fall back to the impact-free spot estimate when no quoter is configured; the
        // user's slippage then covers the impact. Headline price/mcap still use the TWAP; spot
        // manipulation is caught by the deviation guard in trade().
        const quoted = await poolQuoteOut(publicClient, sellToken, buyToken, amt, poolFee);
        const out = quoted ?? (await poolSpotOut(publicClient, sellToken, buyToken, amt, poolFee, true));
        if (!cancelled) { setQuoteOut(out); setVia(out ? (quoted != null ? "pool" : "pool (est.)") : ""); }
      } catch { if (!cancelled) { setQuoteOut(null); setVia(""); } }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [amount, buy, coinAddr, me, quote, onCurve, canTrade, publicClient, quoteDec, isWethQuote, poolFee, tick]);

  async function trade() {
    if (!coinAddr || !publicClient || busy) return;
    setStatus("");
    if (!isConnected || !me) { setStatus("Connect your wallet to trade."); return; }
    if (!canTrade) { setStatus(tradeBlock || "Still loading — try again in a moment."); return; }
    let amountIn: bigint;
    try { amountIn = parseUnits(amount || "0", buy ? quoteDec : 18); } catch { setStatus("Enter a valid amount."); return; }
    if (amountIn <= 0n) { setStatus("Enter an amount."); return; }
    if (!buy && coinBal != null && amountIn > coinBal) { setStatus(`You hold ${fmtAmount(Number(formatUnits(coinBal, 18)))} ${coinSym}.`); return; }
    if (quoteOut == null) { setStatus("No price for this amount right now — adjust it or try again."); return; }
    const minOut = (quoteOut * BigInt(10000 - slippageBps)) / 10000n; // never trade unprotected (user slippage)
    setBusy(true);
    try {
      // On the right network first — otherwise the trade goes to whatever chain the wallet is on and fails.
      if (!(await ensureChain())) { setStatus(`Switch your wallet to ${CHAIN.name}, then trade.`); return; }
      const sellToken = buy ? quote : coinAddr;
      const buyToken = buy ? coinAddr : quote;

      if (onCurve) {
        // Pre-graduation: trade against the CensusCurve (the fee is taken on-chain). BUY: an ETH-anchored
        // coin takes native ETH in one tx (buyWithETH wraps for you); another anchor means approving that
        // token, then curve.buy. SELL approves the coin, then sells — ETH-anchored coins pay out native ETH.
        if (buy) {
          if (isWethQuote) {
            setStatus("Confirm in your wallet…");
            const h = await writeContractAsync({ chainId: CHAIN.id, address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "buyWithETH", args: [coinAddr, minOut], value: amountIn });
            setStatus("Buying…");
            await publicClient.waitForTransactionReceipt({ hash: h });
            setStatus("Bought ✓");
          } else {
            if (quoteBal != null && quoteBal < amountIn) { setStatus(`You need ${anchor} in your wallet to buy this coin.`); return; }
            setStatus("Approving…");
            const a = await writeContractAsync({ chainId: CHAIN.id, address: quote, abi: erc20Abi, functionName: "approve", args: [CONTRACTS.curve, amountIn] });
            await publicClient.waitForTransactionReceipt({ hash: a });
            setStatus("Confirm in your wallet…");
            const h = await writeContractAsync({ chainId: CHAIN.id, address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "buy", args: [coinAddr, amountIn, minOut] });
            setStatus("Buying…");
            await publicClient.waitForTransactionReceipt({ hash: h });
            setStatus("Bought ✓");
          }
        } else {
          setStatus("Approving…");
          const a = await writeContractAsync({ chainId: CHAIN.id, address: coinAddr, abi: erc20Abi, functionName: "approve", args: [CONTRACTS.curve, amountIn] });
          await publicClient.waitForTransactionReceipt({ hash: a });
          setStatus("Confirm in your wallet…");
          const h = await writeContractAsync({ chainId: CHAIN.id, address: CONTRACTS.curve, abi: censusCurveAbi, functionName: isWethQuote ? "sellForETH" : "sell", args: [coinAddr, amountIn, minOut] });
          setStatus("Selling…");
          await publicClient.waitForTransactionReceipt({ hash: h });
          setStatus(isWethQuote ? "Sold ✓ — paid out in ETH" : "Sold ✓");
        }
        return;
      }

      // Graduated: the coin trades on its permanently locked Uniswap pool. WETH-anchored coins try 0x
      // first (best execution; 0x won't route tokenised-stock anchors like HOOD), else the pool directly.
      if (buy && !isWethQuote && quoteBal != null && quoteBal < amountIn) { setStatus(`You need ${anchor} in your wallet to buy this coin.`); return; }
      if (buy && isWethQuote) {
        setStatus("Wrapping ETH…");
        const w = await writeContractAsync({ chainId: CHAIN.id, address: CONTRACTS.weth, abi: wethAbi, functionName: "deposit", value: amountIn });
        await publicClient.waitForTransactionReceipt({ hash: w });
      }
      if (isWethQuote) {
        const q = await zeroExQuote({ sellToken, buyToken, sellAmount: amountIn, taker: me, slippageBps }).catch(() => undefined);
        if (q && q.liquidityAvailable !== false && q.transaction?.data) {
          const spender = allowanceSpender(q);
          if (spender) {
            const current = await publicClient.readContract({ address: sellToken, abi: erc20Abi, functionName: "allowance", args: [me, spender] });
            if (current < amountIn) {
              setStatus("Approving…");
              const a = await writeContractAsync({ chainId: CHAIN.id, address: sellToken, abi: erc20Abi, functionName: "approve", args: [spender, amountIn] });
              await publicClient.waitForTransactionReceipt({ hash: a });
            }
          }
          setStatus(`Swapping via ${routeSummary(q)}…`);
          const h = await sendTransactionAsync({ chainId: CHAIN.id, to: q.transaction.to, data: q.transaction.data, value: BigInt(q.transaction.value || "0") });
          await publicClient.waitForTransactionReceipt({ hash: h });
          setStatus(buy ? "Bought ✓" : "Sold ✓");
          return;
        }
      }
      // CX-H1: the pool path's minOut came from the live spot. Before trading against it, refuse if the
      // spot has swung far from the pool TWAP — an attacker who moved the pool one block earlier can't
      // set the reference our own minOut is measured against. A warming pool (no TWAP) is allowed on spot.
      const dev = await poolTwapDeviationBps(publicClient, sellToken, buyToken, poolFee);
      if (dev != null && dev > MAX_POOL_DEVIATION_BPS) { setStatus("This coin's pool price is swinging right now — wait a moment and try again."); return; }
      setStatus("Approving…");
      const a2 = await writeContractAsync({ chainId: CHAIN.id, address: sellToken, abi: erc20Abi, functionName: "approve", args: [CONTRACTS.swapRouter, amountIn] });
      await publicClient.waitForTransactionReceipt({ hash: a2 });
      setStatus("Swapping on the pool…");
      const h2 = await writeContractAsync({
        chainId: CHAIN.id, address: CONTRACTS.swapRouter, abi: swapRouterAbi, functionName: "exactInputSingle",
        args: [{ tokenIn: sellToken, tokenOut: buyToken, fee: poolFee, recipient: me, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
      });
      await publicClient.waitForTransactionReceipt({ hash: h2 });
      setStatus(buy ? "Bought ✓" : "Sold ✓");
    } catch (e: any) {
      setStatus(friendly(e));
    } finally {
      setBusy(false);
      setTick((t) => t + 1);
    }
  }

  // A launch whose signed details write failed keeps the payload locally; the creator can save it here.
  const pendingMeta = coinAddr ? pendingMetadata(CHAIN.id, coinAddr) : null;
  const isCreator = !!me && !!cq.creator && me.toLowerCase() === cq.creator.toLowerCase();
  async function saveDetails() {
    if (!coinAddr || savingMeta) return;
    setSavingMeta(true);
    setStatus("");
    try {
      const r = await retryPendingMetadata(CHAIN.id, coinAddr, signMessageAsync);
      if (r?.ok) { setStatus("Details saved ✓"); getMetadata(coinAddr).then(setMeta); }
      else if (r) setStatus(`Details not saved: ${r.reason}.`);
    } finally { setSavingMeta(false); }
  }

  // Maxima: pull the whole claimable basket in one call.
  async function claim() {
    if (!publicClient || !cq.vault || claiming) return;
    setStatus("");
    setClaiming(true);
    try {
      if (!(await ensureChain())) { setStatus(`Switch your wallet to ${CHAIN.name}, then claim.`); return; }
      setStatus("Confirm the claim in your wallet…");
      const h = await writeContractAsync({ chainId: CHAIN.id, address: cq.vault, abi: vaultAbi, functionName: "claim" });
      await publicClient.waitForTransactionReceipt({ hash: h });
      setStatus("Claimed ✓");
    } catch (e: any) {
      setStatus(friendly(e));
    } finally {
      setClaiming(false);
      setTick((t) => t + 1);
    }
  }

  if (!coinAddr) {
    return (
      <div className="cx-panel cx-empty">
        <div className="cx-empty__title">That's not a coin address</div>
        <div className="cx-empty__body">A Census coin address is 42 characters long and ends in c0de. Check the link and try again.</div>
        <Link className="cx-cta" style={{ marginTop: 26 }} to="/board">Open the market</Link>
      </div>
    );
  }

  // The registry read failed (RPC down) — a retry state, NOT "not a coin" (CX-N1/CX-M4: never mask an
  // outage as emptiness). Distinct from a confirmed miss below.
  if (hasCurve && cq.resolved && cq.error) {
    return (
      <div className="cx-panel cx-empty">
        <div className="cx-empty__title">Couldn't reach the chain</div>
        <div className="cx-empty__body">We couldn't read this coin from {CHAIN.name} just now. Check your connection and try again.</div>
        <button className="cx-cta" style={{ marginTop: 26 }} onClick={() => setRetryNonce((n) => n + 1)}>Retry</button>
      </div>
    );
  }

  // A real, well-formed address that is not a Census coin — show the honest error, not a blank coin
  // shell that a phishing link could pass off as a real launch (CX-N1).
  if (hasCurve && cq.resolved && !registered) {
    return (
      <div className="cx-panel cx-empty">
        <div className="cx-empty__title">Not a Census coin</div>
        <div className="cx-empty__body">{shortAddr(coinAddr)} isn't a coin launched on Census. Only Census launches trade here.</div>
        <Link className="cx-cta" style={{ marginTop: 26 }} to="/board">Open the market</Link>
      </div>
    );
  }

  const copy = () => { navigator.clipboard?.writeText(coinAddr); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  const metaNote = pendingMeta && isCreator ? "Your coin's thesis and logo haven't been saved yet." : (loc.state as any)?.metaSaved === false && !meta ? "Launched. Your coin's details weren't saved; connect as the creator to save them." : "";
  const launchTaxBps = onCurve && buyFeeBps != null && buyFeeBps > TRADE_FEE_BPS ? buyFeeBps - TRADE_FEE_BPS : 0;
  const feeRate = onCurve ? (buy ? (buyFeeBps ?? TRADE_FEE_BPS) : TRADE_FEE_BPS) / 10000 : poolFee / 1e6;
  let amountInRaw: bigint | null = null;
  try { amountInRaw = amount ? parseUnits(amount, buy ? quoteDec : 18) : null; } catch { amountInRaw = null; }
  const overRoom = buy && onCurve && maxIn != null && amountInRaw != null && amountInRaw > maxIn;
  const feePctLabel = `${+(feeRate * 100).toFixed(2)}%`;
  const outUnits = buy ? 18 : quoteDec;
  const outHuman = quoteOut != null ? Number(formatUnits(quoteOut, outUnits)) : null;
  const feeDisp = buy
    ? `${fmtAmount((Number(amount) || 0) * feeRate, 5)} ${anchor}`
    : outHuman != null ? `${fmtAmount((outHuman * feeRate) / (1 - feeRate), 5)} ${anchor}` : "—";
  const routeDisp = onCurve ? "The Census curve" : graduated ? (via && via !== "pool" ? `0x · ${via}` : "Locked Uniswap pool") : "—";
  const balDisp = !me ? "" : buy
    ? quoteBal != null ? `Balance ${fmtAmount(Number(formatUnits(quoteBal, quoteDec)))} ${anchor}` : ""
    : coinBal != null ? `Balance ${fmtAmount(Number(formatUnits(coinBal, 18)), 2)} ${coinSym}` : "";
  const sellPreset = (pct: number) => { if (coinBal == null) return; setAmount(formatUnits((coinBal * BigInt(pct)) / 100n, 18)); };
  const claimable = rewards?.stocks.some((s) => s.amount > 0n) ?? false;
  const anchorNode = anchorIsCoin
    ? <Link to={`/coin/${quote}`} className="cx-link-control" style={{ padding: 0, fontSize: "inherit", letterSpacing: "inherit", textTransform: "inherit" }}>${anchor}</Link>
    : <>{anchor}</>;

  return (
    <div className="cx-coin">
      {/* main column */}
      <div style={{ minWidth: 0 }}>
        {metaNote && (
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18, flexWrap: "wrap" }}>
            <span className="cx-label" style={{ color: "var(--census-text-secondary)" }}>{metaNote}</span>
            {pendingMeta && isCreator && <button className="cx-link-control" onClick={saveDetails} disabled={savingMeta}>{savingMeta ? "Saving…" : "Save details"}</button>}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 20 }}>
          <CxAvatar name={coinName} image={meta?.image} size={80} />
          <div style={{ minWidth: 0 }}>
            <div className="cx-label">{cq.resolved ? <>{tier} · anchored to {anchorNode}{graduated ? " · Company coin" : ""}</> : "Loading"}</div>
            <h1 className="cx-h1" style={{ fontSize: 40, marginTop: 10 }}>{coinName}</h1>
            {meta?.thesis && <p style={{ margin: "10px 0 0", fontSize: 15, color: "var(--census-text-secondary)" }}>{meta.thesis}</p>}
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 14, flexWrap: "wrap" }}>
              <span className="cx-num" style={{ fontSize: 13, color: "var(--census-text-secondary)" }}>${coinSym || "—"}</span>
              <Sep />
              <span className="cx-num" style={{ fontSize: 13, color: "var(--census-text-secondary)" }}>Started by {cq.creator ? shortAddr(cq.creator) : "—"}</span>
              <Sep />
              <button className="cx-link-control" onClick={copy} aria-label="Copy coin address" style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <span className="cx-num">{coinAddr.slice(0, 6)}…{coinAddr.slice(-6, -4)}<span style={{ color: "var(--census-lime)" }}>{coinAddr.slice(-4)}</span></span>
                {copied ? <span className="cx-label">Copied</span> : <Icon name="copy" size={14} />}
              </button>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 40 }}>
          <StatBand stats={[
            { label: "Market cap", value: mcapDisp, note: liveNote, key: true },
            { label: "Price", value: priceDisp, note: liveNote },
            { label: "24h", value: "—", note: "Pending indexer" },
            { label: "Holders", value: "—", note: "Pending indexer" },
          ]} />
        </div>

        {meta?.description && (
          <>
            <div className="cx-section-title" style={{ margin: "44px 0 14px" }}>About</div>
            <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, color: "var(--census-text-secondary)", whiteSpace: "pre-wrap" }}>{meta.description}</p>
          </>
        )}

        <div className="cx-section-title" style={{ margin: "44px 0 16px" }}>Price</div>
        <PendingPanel line="Price history appears once the indexer is connected" note="Price and market cap above are live." />

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "44px 0 14px" }}>
          <div className="cx-section-title">Graduation</div>
          <span className="cx-label">{graduated ? "Graduated · pool locked" : reserveCaption({ reserve, graduationTarget, anchor })}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <GraduationBar pct={gradPct} large />
          <span className="cx-num cx-num--key" style={{ fontSize: 24 }}>{gradPct}%</span>
        </div>
        <p style={{ margin: "16px 0 0", fontSize: 14, color: "var(--census-text-secondary)" }}>
          {graduated
            ? "The curve closed. Liquidity is locked permanently in a Uniswap V3 pool."
            : graduationTarget != null
              ? `At ${fmtAmount(graduationTarget, 2)} ${anchor} the curve closes and liquidity moves to a permanently locked Uniswap V3 pool.`
              : "When the curve fills, liquidity moves to a permanently locked Uniswap V3 pool."}
        </p>

        {graduated && (
          <>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, margin: "44px 0 16px", flexWrap: "wrap" }}>
              <div className="cx-section-title">Ecosystem</div>
              <Link className="cx-link-control" to={`/create/anchors?anchor=${coinAddr}&symbol=${encodeURIComponent(coinSym)}`}>Launch a coin anchored to ${coinSym} →</Link>
            </div>
            {!ecoReady
              ? <PendingPanel line={`Looking for launches anchored to $${coinSym}`} />
              : paired.length
                ? <div className="cx-table">{paired.map((c) => <HomeRow key={c.address} c={c} />)}</div>
                : <PendingPanel line={`No launches anchored to $${coinSym} yet`} note="Any new coin can pick this company as its anchor at launch." />}
          </>
        )}

        <div className="cx-section-title" style={{ marginTop: 44, marginBottom: 16 }}>Holders</div>
        <PendingPanel line="Distribution appears once the indexer is connected." />

        {hasVault ? (
          <>
            <div className="cx-section-title" style={{ marginTop: 44, marginBottom: 16 }}>Your rewards</div>
            <div className="cx-panel cx-panel--plain">
              {!isConnected ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                  <div className="cx-stat__note" style={{ marginTop: 0 }}>Holders of ${coinSym || "this coin"} earn a share of every trade, paid in {rewards?.stocks.map((s) => s.ticker).join(", ") || "the stock basket"}. Connect to see yours.</div>
                  <button className="cx-cta" onClick={connect} disabled={connecting}>{connecting ? "Connecting…" : "Connect wallet"}</button>
                </div>
              ) : rewards == null ? (
                <div className="cx-stat__note" style={{ marginTop: 0 }}>Reading the vault…</div>
              ) : (
                <>
                  <div style={{ display: "grid", gap: 10 }}>
                    {rewards.stocks.map((s) => (
                      <div key={s.stock} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 9, fontSize: 14 }}><AnchorMark anchor={s.ticker} size={18} /> {s.ticker}</span>
                        <Num kind={s.amount > 0n ? "key" : "value"}>{s.amount > 0n ? fmtAmount(Number(formatUnits(s.amount, s.decimals)), 6) : "—"}</Num>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginTop: 18, flexWrap: "wrap" }}>
                    <div className="cx-stat__note" style={{ marginTop: 0 }}>
                      {rewards.undistributed > 0n
                        ? `${fmtAmount(Number(formatUnits(rewards.undistributed, quoteDec)), 5)} ${anchor} of fees are waiting to be swapped into the basket.`
                        : "Fees are swapped into the basket as they arrive."}
                    </div>
                    <button className="cx-cta" onClick={claim} disabled={!claimable || claiming} title={claimable ? undefined : "Nothing to claim yet"}>{claiming ? "Claiming…" : "Claim"}</button>
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="cx-section-title" style={{ marginTop: 44, marginBottom: 16 }}>Creator rewards</div>
            <div className="cx-panel cx-panel--plain" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
              <div>
                <div className="cx-stat__value"><Num>—</Num></div>
                <div className="cx-stat__note">Paid to the creator on every trade. The running total appears with the indexer.</div>
              </div>
            </div>
          </>
        )}

        <div className="cx-section-title" style={{ marginTop: 44, marginBottom: 16 }}>Thread</div>
        <PendingPanel line="The thread opens once the indexer is connected" />
      </div>

      {/* trade panel */}
      <div>
        <div className="cx-panel" style={{ position: "sticky", top: 24 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, borderBottom: "1px solid var(--census-border)" }}>
            {(["buy", "sell"] as const).map((side) => {
              const on = buy === (side === "buy");
              return (
                <button key={side} onClick={() => { setBuy(side === "buy"); setAmount(side === "buy" ? "0.1" : ""); }} aria-pressed={on}
                  style={{ background: "none", border: 0, cursor: "pointer", fontSize: 15, paddingTop: 15, paddingBottom: 14, marginBottom: -1,
                    fontWeight: on ? 500 : 400, color: on ? "var(--census-text)" : "var(--census-text-muted)",
                    borderBottom: `1px solid ${on ? "var(--census-lime)" : "transparent"}` }}>
                  {side === "buy" ? "Buy" : "Sell"}
                </button>
              );
            })}
          </div>

          <div className="cx-field" style={{ marginTop: 26, paddingBottom: 14 }}>
            <input value={amount} inputMode="decimal" aria-label="Amount" placeholder="0" onChange={(e) => setAmount(e.target.value)}
              style={{ fontFamily: "var(--census-font-mono)", fontSize: 30, fontVariantNumeric: "tabular-nums" }} />
            <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
              {buy ? <AnchorMark anchor={anchor} isCoin={anchorIsCoin} size={20} /> : <CxAvatar name={coinName} image={meta?.image} size={20} />}
              <span className="cx-num" style={{ fontSize: 13, color: "var(--census-text-secondary)" }}>{buy ? anchor : coinSym || "coin"}</span>
            </span>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 22 }}>
              {buy
                ? BUY_PRESETS.map((a) => <button key={a} className="cx-link-control" aria-pressed={amount === a} onClick={() => setAmount(a)}>{a}</button>)
                : SELL_PRESETS.map((p) => <button key={p} className="cx-link-control" disabled={coinBal == null || coinBal === 0n} onClick={() => sellPreset(p)}>{p}%</button>)}
            </div>
            {balDisp && <span className="cx-label">{balDisp}</span>}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 28 }}>
            <QuoteRow label="You receive ~" value={outHuman != null ? `${fmtAmount(outHuman, 6)} ${buy ? coinSym : anchor}` : "—"} bright />
            <QuoteRow label={`Fee (${feePctLabel})`} value={feeDisp} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="cx-label">Max slippage</span>
              <div style={{ display: "flex", gap: 8 }}>
                {SLIPPAGE_PRESETS.map((bps) => (
                  <button key={bps} className="cx-link-control" aria-pressed={slippageBps === bps} onClick={() => setSlippageBps(bps)}>{bps / 100}%</button>
                ))}
              </div>
            </div>
            <QuoteRow label="Route" value={routeDisp} />
          </div>
          {launchTaxBps > 0 && buy && (
            <div className="cx-label" style={{ marginTop: 12, color: "var(--census-text-secondary)" }}>
              Launch window: buys pay {feePctLabel} right now, falling to {TRADE_FEE_LABEL} within three seconds of launch. The block your trade lands in sets the rate.
            </div>
          )}
          {overRoom && maxIn != null && (
            <div className="cx-label" style={{ marginTop: 12, color: "var(--census-text-secondary)" }}>
              Only {fmtAmount(Number(formatUnits(maxIn, quoteDec)), 5)} {anchor} of room is left before the curve fills; anything above that is refunded in the same transaction.
            </div>
          )}

          {isConnected ? (
            <button className="cx-cta" style={{ width: "100%", marginTop: 26, padding: 16, fontSize: 16 }} disabled={busy || !canTrade} onClick={trade}>
              {busy ? "Working…" : !cq.resolved || (!qi && !tradeBlock) ? "Loading…" : "Place trade"}
            </button>
          ) : (
            <>
              <button className="cx-cta" style={{ width: "100%", marginTop: 26, padding: 16, fontSize: 16 }} disabled={connecting} onClick={connect}>
                {pending === "wallet" ? "Connecting…" : "Connect wallet"}
              </button>
              {signUp && (
                <button className="cx-link-control" style={{ display: "block", margin: "12px auto 0" }} disabled={connecting} onClick={signUp}>
                  {pending === "signup" ? "Signing up…" : "No wallet? Sign up with email"}
                </button>
              )}
            </>
          )}
          <div className="cx-label" style={{ textAlign: "center", marginTop: 14 }}>{onCurve ? (launchTaxBps > 0 && buy ? `${feePctLabel} during the launch window` : `${TRADE_FEE_LABEL} trade fee`) : graduated ? `${feePctLabel} pool fee` : "—"}</div>
          {anchorIsCoin && <div className="cx-label" style={{ textAlign: "center", marginTop: 10, color: "var(--census-text-secondary)" }}>Trades settle in ${anchor} — hold some to buy.</div>}
          {!isConnected && connectError && <div style={{ textAlign: "center", marginTop: 10, fontSize: 13, color: "#e06c60" }}>{connectError}</div>}
          {isConnected && tradeBlock && <div className="cx-label" style={{ textAlign: "center", marginTop: 10, color: "var(--census-text-secondary)" }}>{tradeBlock}</div>}
          {status && <div className="cx-label" style={{ textAlign: "center", marginTop: 10, color: "var(--census-text-secondary)" }}>{status}</div>}
        </div>

        <div className="cx-panel cx-panel--plain" style={{ marginTop: 16 }}>
          <div className="cx-label" style={{ marginBottom: 14 }}>The curve</div>
          <CurveRow k="Supply" v={supply != null ? fmtAmount(supply, 0) : "—"} />
          <CurveRow k="Anchored to" v={cq.resolved ? anchor : "—"} />
          <CurveRow k="Graduation at" v={graduationTarget != null ? `${fmtAmount(graduationTarget, 2)} ${anchor}` : "—"} />
          <CurveRow k="Trade fee" v={graduated ? `${feePctLabel} (pool)` : TRADE_FEE_LABEL} />
          {hasVault && cq.holdersBps != null && <CurveRow k="Holders' share" v={`${Math.round(cq.holdersBps / 100)}% of creator rewards`} />}
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
