import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useAccount, usePublicClient, useSignMessage, useWriteContract } from "wagmi";
import { parseUnits, formatUnits, isAddress, zeroAddress, parseEventLogs, type Address, type Hex } from "viem";
import { CONTRACTS, CHAIN, EXPLORER, TRADE_FEE_BPS, TRADE_FEE_LABEL, LEGACY_V3_POOL_FEE, pctLabel, feeBreakdown } from "../config";
import { wethAbi, erc20Abi, censusCurveV4Abi, v4RouterAbi, vaultAbi } from "../abis";
import { cachedQuoteUsd, quoteInfo, type QuoteInfo } from "../lib/anchors";
import { poolSpotOut } from "../lib/pool";
import { v4Configured, v4QuoteOut, v4SpotPrice, swapRequest } from "../lib/v4pool";
import { hasAnyCurve, watchGraduation, readCurve } from "../lib/curves";
import { assertLaunchChain } from "../lib/launchReceipt";
import { PaymentConversion } from "../components/PaymentConversion";
import { MarketChart } from "../components/MarketChart";
import { useCoinQuote } from "../lib/useCoinQuote";
import { useLaunches } from "../lib/useLaunches";
import { useCurveStats } from "../lib/useCurveStats";
import { getMetadata, pendingMetadata, retryPendingMetadata, type CoinMetadata } from "../lib/metadata";
import { curveSpot } from "../lib/curveOffset";
import { readRewards, hasClaimable, type Rewards } from "../lib/rewards";
import { CxAvatar, AnchorMark, HomeRow, Num, StatBand, PendingPanel, GraduationBar, Icon, fmtUsd, fmtPrice, fmtAmount, shortAddr, reserveCaption, useWalletConnect, type DisplayCoin } from "../census";

const SLIPPAGE_BPS = 200; // 2% — the default minimum-out tolerance; user-adjustable (see SLIPPAGE_PRESETS)
const SLIPPAGE_PRESETS = [50, 200, 500, 1000]; // 0.5% / 2% / 5% / 10% — a shallow post-graduation pool may need more
const BUY_PRESETS = ["0.001", "0.01", "0.1", "1"];
const SELL_PRESETS = [25, 50, 75, 100]; // % of the coins you hold

const friendly = (e: any) => {
  const raw = String(e?.shortMessage ?? e?.message ?? e ?? "");
  if (/reject|denied|cancel/i.test(raw)) return "Cancelled in your wallet.";
  if (/IncompleteFill/i.test(raw)) return "The pool couldn't fill that amount at once — try a smaller trade.";
  if (/Slippage|minOut|TooLittleReceived/i.test(raw)) return "Price moved past your slippage — raise it or try again.";
  return raw.slice(0, 140) || "Something went wrong.";
};

export function Coin() {
  const { address: param } = useParams();
  const loc = useLocation();
  const coinAddr = param && isAddress(param) ? (param as Address) : undefined;
  const { address: me, isConnected } = useAccount();
  const { connect, signUp, connecting, pending, error: connectError, ensureChain } = useWalletConnect();
  const publicClient = usePublicClient({ chainId: CHAIN.id });
  const { writeContractAsync } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
  const [retryNonce, setRetryNonce] = useState(0); // bumped by the "couldn't reach the chain" retry
  const [slippageBps, setSlippageBps] = useState(SLIPPAGE_BPS); // user-chosen minimum-out tolerance
  const cq = useCoinQuote(coinAddr, retryNonce);

  const [buy, setBuy] = useState(true);
  const [useNative, setUseNative] = useState(true); // ETH vs WETH for both input and payout
  const [amount, setAmount] = useState("0.1");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [conversionBusy, setConversionBusy] = useState(false);
  const [pendingTrade, setPendingTrade] = useState<Hex | null>(null);
  const tradeStorageKey = `delos:trade:${CHAIN.id}:${me?.toLowerCase()}`;
  useEffect(() => {
    const saved = localStorage.getItem(tradeStorageKey);
    setPendingTrade(saved && /^0x[0-9a-f]{64}$/i.test(saved) ? saved as Hex : null);
  }, [tradeStorageKey]);
  const [quoteOut, setQuoteOut] = useState<bigint | null>(null); // what you'd receive, raw units of the out-asset
  const [via, setVia] = useState<"" | "curve" | "pool">("");
  const [gradBps, setGradBps] = useState<number | null>(null);
  const [meta, setMeta] = useState<CoinMetadata | null>(null);
  const [copied, setCopied] = useState(false);
  const [coinBal, setCoinBal] = useState<bigint | null>(null);
  const [quoteBal, setQuoteBal] = useState<bigint | null>(null);
  const [quoteUsd, setQuoteUsd] = useState<number | null>(null);
  const [qi, setQi] = useState<QuoteInfo | null>(null); // the anchor's symbol/decimals (menu asset or company coin)
  const [poolPrice, setPoolPrice] = useState<number | null>(null); // quote per coin, graduated coins only (spot)
  const [rewards, setRewards] = useState<Rewards | null>(null); // reflection launches: the holder's basket + claimable
  const [claiming, setClaiming] = useState(false);
  const [buyFeeBps, setBuyFeeBps] = useState<number | null>(null); // this buyer's current curve buy fee (base + reflection + any launch-window penalty)
  const [sellFeeBps, setSellFeeBps] = useState<number | null>(null); // the curve's sell fee (base + reflection)
  const [maxIn, setMaxIn] = useState<bigint | null>(null); // gross quote the curve still accepts before it fills
  const [savingMeta, setSavingMeta] = useState(false);
  const [tick, setTick] = useState(0); // bumps after a trade/claim to refresh balances, quote and rewards

  // What this coin is anchored to (WETH default, HOOD, or another Census coin) and where it trades now.
  const quote = cq.quote;
  const anchor = qi?.symbol ?? "ETH";
  const quoteDec = qi?.decimals ?? 18;
  const anchorIsCoin = !!qi?.isCoin;
  const isWethQuote = quote.toLowerCase() === CONTRACTS.weth.toLowerCase();
  const paymentSymbol = isWethQuote ? (useNative ? "ETH" : "WETH") : anchor;
  const hasCurve = hasAnyCurve();
  const registered = !!cq.routed;
  const graduated = !!cq.graduated;
  const isV4 = cq.venue === "v4";
  const curveAddr = cq.curve ?? zeroAddress;
  const onCurve = registered && !graduated; // pre-graduation: every trade is on the Census curve
  // Post-graduation a V4 coin trades in its canonical hooked pool through CensusV4Router. A pool id that
  // doesn't match what the curve registered means our key is wrong for this coin: never trade on it.
  const onPool = registered && graduated && isV4 && v4Configured() && !cq.poolIdMismatch;
  const legacyGraduated = registered && graduated && cq.venue === "legacy"; // V3-era coin: priced here, traded on Uniswap
  const coinName = cq.name ?? (cq.resolved ? "Unknown token" : "…");
  const coinSym = cq.symbol ?? "";
  const hasVault = !!cq.vault && cq.vault !== zeroAddress;
  const reflectionBps = cq.reflectionBps ?? 0;
  const standingFeeBps = TRADE_FEE_BPS + reflectionBps; // base + reflection: the fee outside the launch window, on the curve and in the pool
  const tradeBlock = !hasCurve ? "Trading isn't configured on this deployment."
    : cq.resolved && !registered ? "This address isn't a Delos coin."
    : legacyGraduated ? "Graduated to a legacy Uniswap V3 pool. Trade it on Uniswap."
    : graduated && isV4 && !v4Configured() ? "Pool trading isn't configured on this deployment."
    : graduated && isV4 && cq.poolIdMismatch ? "The pool doesn't match the coin's registration — trading is paused here."
    : "";
  const canTrade = hasCurve && cq.resolved && registered && !!qi && (onCurve || onPool);

  useEffect(() => {
    if (!publicClient || !coinAddr || !onCurve) return;
    return watchGraduation(publicClient, curveAddr, coinAddr, () => setRetryNonce(n => n + 1));
  }, [publicClient, coinAddr, onCurve, curveAddr]);

  // Coins anchored to THIS coin (only possible once it has graduated — its pool is what they trade through).
  const pairable = graduated && isV4;
  const { coins: allCoins, loading: ecoLoading } = useLaunches(pairable);
  const ecoStats = useCurveStats(pairable ? allCoins.map((c) => c.address) : []);
  const paired: DisplayCoin[] = pairable && coinAddr
    ? allCoins.filter((c) => ecoStats[c.address.toLowerCase()]?.quoteAddress?.toLowerCase() === coinAddr.toLowerCase()).map((c) => {
        const s = ecoStats[c.address.toLowerCase()];
        return { address: c.address, name: c.name, symbol: c.symbol, creator: c.creator, age: c.age, anchor: s?.anchor, anchorIsCoin: s?.anchorIsCoin, marketCap: s?.mcapUsd ?? null, graduation: s?.gradPct ?? 0, graduated: s?.graduated, reserve: s?.reserve, graduationTarget: s?.graduationTarget };
      })
    : [];
  const ecoReady = !ecoLoading && (allCoins.length === 0 || Object.keys(ecoStats).length > 0);

  // Price + market cap. On the curve: spot = virtualQuote / (tokenReserve + virtualTokenOffset), the PF
  // pricing offset being an unminted term the curve exposes. Graduated: the pool's spot (V4 has no TWAP,
  // so it is labelled as spot). USD via the anchor's live price (null => shown in anchor units, never a
  // made-up dollar figure).
  const curvePrice = onCurve && cq.virtualQuote != null && cq.tokenReserve != null && cq.tokenReserve > 0n
    ? curveSpot(cq.virtualQuote, cq.tokenReserve, cq.virtualTokenOffset ?? null, quoteDec) : null;
  const priceQuote = onCurve ? curvePrice : graduated ? poolPrice : null;
  const supply = cq.totalSupply != null ? Number(cq.totalSupply) / 1e18 : null;
  const priceUsd = priceQuote != null && quoteUsd != null ? priceQuote * quoteUsd : null;
  const mcapUsd = priceUsd != null && supply != null ? priceUsd * supply : null;
  const priceDisp = priceUsd != null ? fmtPrice(priceUsd) : priceQuote != null ? `${priceQuote.toPrecision(3)} ${anchor}` : "—";
  const mcapDisp = mcapUsd != null ? fmtUsd(mcapUsd) : priceQuote != null && supply != null ? `${fmtAmount(priceQuote * supply, 2)} ${anchor}` : "—";
  const liveNote = onCurve ? "Live from the curve" : graduated ? (isV4 ? "Spot from the canonical pool" : "Spot from its V3 pool") : "—";
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

  // Graduated coins: spot price from the pool (quote per coin). V4: StateView slot0 of the canonical
  // pool; legacy: the V3 pool the old curve minted.
  useEffect(() => {
    let cancelled = false;
    setPoolPrice(null);
    if (!publicClient || !coinAddr || !graduated || !qi) return;
    (async () => {
      if (isV4) {
        const p = await v4SpotPrice(publicClient, coinAddr, quote, quoteDec);
        if (!cancelled) setPoolPrice(p);
      } else {
        const out = await poolSpotOut(publicClient, quote, coinAddr, parseUnits("1", quoteDec), cq.legacyPoolFee || LEGACY_V3_POOL_FEE);
        if (!cancelled && out != null && out > 0n) setPoolPrice(1 / (Number(out) / 1e18));
      }
    })();
    return () => { cancelled = true; };
  }, [publicClient, coinAddr, graduated, isV4, quote, quoteDec, cq.legacyPoolFee, qi, tick]);

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
          isWethQuote && useNative ? publicClient.getBalance({ address: me }) : publicClient.readContract({ address: quote, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
        ]);
        if (!cancelled) { setCoinBal(c); setQuoteBal(q); }
      } catch { /* leave unknown */ }
    })();
    return () => { cancelled = true; };
  }, [publicClient, coinAddr, me, quote, isWethQuote, useNative, cq.resolved, tick]);

  // Reflection launches: the basket, what the connected wallet can claim from the vault, and what's
  // waiting to be distributed.
  useEffect(() => {
    let cancelled = false;
    setRewards(null);
    if (!publicClient || !cq.resolved || !hasVault || !cq.vault || !coinAddr) return;
    readRewards(publicClient, cq.vault, quote, me).then((r) => { if (!cancelled) setRewards(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [publicClient, cq.resolved, hasVault, cq.vault, quote, me, coinAddr, tick]);

  // This buyer's curve buy fee, the sell fee, and the room left before the curve fills. In the three
  // seconds after a launch the buy fee decays from 99% to base + reflection (creator and bundle wallets
  // exempt), so poll every second while a launch window could be open; otherwise read once per refresh.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setBuyFeeBps(null); setSellFeeBps(null); setMaxIn(null);
    if (!publicClient || !coinAddr || !onCurve || curveAddr === zeroAddress) return;
    const buyer = me ?? zeroAddress;
    const read = async () => {
      try {
        const [fee, room, sellFee] = await Promise.all([
          publicClient.readContract({ address: curveAddr, abi: censusCurveV4Abi, functionName: "buyFeeBps", args: [coinAddr, buyer] }),
          publicClient.readContract({ address: curveAddr, abi: censusCurveV4Abi, functionName: "maxQuoteInFor", args: [coinAddr, buyer] }),
          publicClient.readContract({ address: curveAddr, abi: censusCurveV4Abi, functionName: "sellFeeBps", args: [coinAddr] }).catch(() => BigInt(standingFeeBps)), // legacy curve: base only
        ]);
        if (cancelled) return;
        setBuyFeeBps(Number(fee)); setMaxIn(room); setSellFeeBps(Number(sellFee));
        if (Number(fee) > standingFeeBps) timer = setTimeout(read, 1000); // launch window: keep the label live
      } catch { if (!cancelled) { setBuyFeeBps(standingFeeBps); setSellFeeBps(standingFeeBps); setMaxIn(null); } } // legacy curve: flat fee, no cap
    };
    read();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [publicClient, coinAddr, onCurve, curveAddr, me, standingFeeBps, tick]);

  // Live graduation progress (bps 0..10000) straight off the curve.
  useEffect(() => {
    let cancelled = false;
    if (!publicClient || !hasCurve || !coinAddr || !registered || graduated || curveAddr === zeroAddress) { setGradBps(null); return; }
    publicClient.readContract({ address: curveAddr, abi: censusCurveV4Abi, functionName: "graduationProgress", args: [coinAddr] })
      .then((bps) => { if (!cancelled) setGradBps(Number(bps)); })
      .catch(() => { if (!cancelled) setGradBps(null); });
    return () => { cancelled = true; };
  }, [publicClient, coinAddr, hasCurve, registered, graduated, curveAddr, tick]);

  // Indicative "you receive ~" as the user types (debounced). On the curve this is quoteBuyFor/quoteSell
  // (fee-net) straight off the contract. In the canonical pool it's the V4Quoter's simulated output
  // (hook fee included, price impact included). Blank when no executable quote is available.
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
          // Buys quote for THIS buyer (launch window + exemptions) and are capped at what the curve still
          // accepts; a legacy curve without quoteBuyFor falls back to the plain quote.
          const out = buy
            ? await publicClient.readContract({ address: curveAddr, abi: censusCurveV4Abi, functionName: "quoteBuyFor", args: [coinAddr, amt, me ?? zeroAddress] })
                .catch(() => publicClient.readContract({ address: curveAddr, abi: censusCurveV4Abi, functionName: "quoteBuy", args: [coinAddr, amt] }))
            : await publicClient.readContract({ address: curveAddr, abi: censusCurveV4Abi, functionName: "quoteSell", args: [coinAddr, amt] });
          if (!cancelled) { setQuoteOut(out > 0n ? out : null); setVia(out > 0n ? "curve" : ""); }
          return;
        }
        const quoted = await v4QuoteOut(publicClient, coinAddr, quote, buy, amt);
        // A spot ratio ignores price impact. Never use it as an executable quote/minimum on a
        // shallow graduated pool; a missing executable quote is a retry state.
        const out = quoted;
        if (!cancelled) { setQuoteOut(out); setVia(out ? "pool" : ""); }
      } catch { if (!cancelled) { setQuoteOut(null); setVia(""); } }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [amount, buy, coinAddr, me, quote, onCurve, canTrade, curveAddr, standingFeeBps, publicClient, quoteDec, tick]);

  // Approve `spender` for `amountIn` of `token` unless the allowance already covers it.
  async function ensureAllowance(token: Address, spender: Address, amountIn: bigint) {
    if (!publicClient || !me) return;
    const current = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [me, spender] }).catch(() => 0n);
    if (current >= amountIn) return;
    setStatus("Approving…");
    const a = await writeContractAsync({ chainId: CHAIN.id, address: token, abi: erc20Abi, functionName: "approve", args: [spender, amountIn] });
    await confirmedTrade(a);
  }

  async function confirmedTrade(hash: Hex) {
    if (!publicClient) throw new Error("Network unavailable");
    setPendingTrade(hash); localStorage.setItem(tradeStorageKey, hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    localStorage.removeItem(tradeStorageKey); setPendingTrade(null);
    if (receipt.status === "reverted") throw new Error("Transaction reverted — the requested step did not complete.");
    return receipt;
  }

  async function checkPendingTrade() {
    if (!pendingTrade || busy) return;
    setBusy(true);
    try {
      await confirmedTrade(pendingTrade);
      setStatus("Submitted step confirmed. Check your updated balances before trading again. Any wrapped ETH or sale proceeds may be in WETH.");
      if (isWethQuote) setUseNative(false);
      setAmount("");
    } catch (e) { setStatus(friendly(e)); }
    finally { setBusy(false); setTick(t => t + 1); setRetryNonce(n => n + 1); }
  }

  async function trade() {
    if (!coinAddr || !publicClient || busy || conversionBusy || pendingTrade) return;
    setStatus("");
    if (!isConnected || !me) { setStatus("Connect your wallet to trade."); return; }
    if (!canTrade) { setStatus(tradeBlock || "Still loading — try again in a moment."); return; }
    let amountIn: bigint;
    try { amountIn = parseUnits(amount || "0", buy ? quoteDec : 18); } catch { setStatus("Enter a valid amount."); return; }
    if (amountIn <= 0n) { setStatus("Enter an amount."); return; }
    if (!buy && coinBal != null && amountIn > coinBal) { setStatus(`You hold ${fmtAmount(Number(formatUnits(coinBal, 18)))} ${coinSym}.`); return; }
    if (quoteOut == null) { setStatus("No price for this amount right now — adjust it or try again."); return; }
    const minOut = (quoteOut * BigInt(10000 - slippageBps)) / 10000n; // never trade unprotected (user slippage)
    if (minOut <= 0n) { setStatus("That amount is too small to protect with a minimum — try a larger one."); return; }
    setBusy(true);
    try {
      // On the right network first — otherwise the trade goes to whatever chain the wallet is on and fails.
      if (!(await ensureChain())) { setStatus(`Switch your wallet to ${CHAIN.name}, then trade.`); return; }
      await assertLaunchChain(publicClient, CHAIN.id);
      const latest = await readCurve(publicClient, coinAddr);
      if (!latest || latest.graduated !== graduated) {
        setRetryNonce(n => n + 1);
        setStatus("The coin's trading venue changed. Refreshing the quote — review it and place your trade again.");
        return;
      }

      if (onCurve) {
        // Pre-graduation: trade against the Census curve (the fee is taken on-chain). BUY: an ETH-anchored
        // coin takes native ETH in one tx (buyWithETH wraps for you); another anchor means approving that
        // token, then curve.buy. SELL approves the coin, then sells — ETH-anchored coins pay out native ETH.
        if (buy) {
          if (isWethQuote && useNative) {
            setStatus("Confirm in your wallet…");
            const h = await writeContractAsync({ chainId: CHAIN.id, address: curveAddr, abi: censusCurveV4Abi, functionName: "buyWithETH", args: [coinAddr, minOut], value: amountIn });
            setStatus("Buying…");
            await confirmedTrade(h);
            setStatus("Bought ✓");
          } else {
            if (quoteBal != null && quoteBal < amountIn) { setStatus(`You need ${paymentSymbol} in your wallet to buy this coin.`); return; }
            await ensureAllowance(quote, curveAddr, amountIn);
            setStatus("Confirm in your wallet…");
            const h = await writeContractAsync({ chainId: CHAIN.id, address: curveAddr, abi: censusCurveV4Abi, functionName: "buy", args: [coinAddr, amountIn, minOut] });
            setStatus("Buying…");
            await confirmedTrade(h);
            setStatus("Bought ✓");
          }
        } else {
          await ensureAllowance(coinAddr, curveAddr, amountIn);
          setStatus("Confirm in your wallet…");
          const h = await writeContractAsync({ chainId: CHAIN.id, address: curveAddr, abi: censusCurveV4Abi, functionName: isWethQuote && useNative ? "sellForETH" : "sell", args: [coinAddr, amountIn, minOut] });
          setStatus("Selling…");
          await confirmedTrade(h);
          setStatus(`Sold ✓ — paid out in ${paymentSymbol}`);
        }
        return;
      }

      // Graduated: the coin trades in its canonical hooked V4 pool through CensusV4Router (ERC20 exact
      // input). BUY: an ETH-anchored coin wraps ETH to WETH first, then approves the router and swaps;
      // SELL approves the coin to the router and swaps. The hook charges the fee inside the swap; the
      // quoter's number already includes it.
      if (buy) {
        if (quoteBal != null && quoteBal < amountIn) { setStatus(`You need ${paymentSymbol} in your wallet to buy this coin.`); return; }
        if (isWethQuote && useNative) {
          setStatus("Wrapping ETH…");
          const w = await writeContractAsync({ chainId: CHAIN.id, address: CONTRACTS.weth, abi: wethAbi, functionName: "deposit", value: amountIn });
          await confirmedTrade(w);
          setUseNative(false); // A cancelled next step can resume using the WETH already wrapped.
        }
        await ensureAllowance(quote, CONTRACTS.v4Router, amountIn);
      } else {
        await ensureAllowance(coinAddr, CONTRACTS.v4Router, amountIn);
      }
      setStatus("Confirm in your wallet…");
      const req = swapRequest({ coin: coinAddr, quote, buy, amountIn, minOut, recipient: me });
      // Gas buffer: other trades can move the pool between this estimate and inclusion, and a V4 swap that
      // runs out of gas inside the final token transfer surfaces as an opaque failure. Found in the testnet
      // stress harness; 30% headroom on the wallet's own estimate keeps the swap alive.
      let gas: bigint | undefined;
      try { gas = ((await publicClient.estimateContractGas({ address: CONTRACTS.v4Router, abi: v4RouterAbi, functionName: "swapExactInput", args: [req], account: me })) * 13n) / 10n; } catch { gas = undefined; }
      const h = await writeContractAsync({ chainId: CHAIN.id, address: CONTRACTS.v4Router, abi: v4RouterAbi, functionName: "swapExactInput", args: [req], ...(gas ? { gas } : {}) });
      setStatus("Swapping in the pool…");
      const receipt = await confirmedTrade(h);
      if (!buy && isWethQuote && useNative) {
        // Unwrap only this swap's proceeds, never the wallet's pre-existing WETH balance.
        const swap = parseEventLogs({ abi: v4RouterAbi, eventName: "Swap", logs: receipt.logs.filter(l => l.address.toLowerCase() === CONTRACTS.v4Router.toLowerCase()) })[0];
        try {
          if (!swap || swap.args.recipient.toLowerCase() !== me.toLowerCase()) throw new Error("Swap receipt unavailable");
          setStatus("Sold ✓ — confirm conversion of the received WETH to ETH…");
          const unwrap = await writeContractAsync({ chainId: CHAIN.id, address: CONTRACTS.weth, abi: wethAbi, functionName: "withdraw", args: [swap.args.amountOut] });
          await confirmedTrade(unwrap);
          setStatus("Sold ✓ — paid out in ETH");
        } catch { setStatus("Sold ✓ — check WETH/ETH balances and any pending conversion confirmation. Don't repeat the sale."); }
      } else setStatus(buy ? "Bought ✓" : `Sold ✓ — paid out in ${paymentSymbol}`);
    } catch (e: any) {
      setStatus(friendly(e));
    } finally {
      setBusy(false);
      setTick((t) => t + 1);
      setRetryNonce((n) => n + 1);
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

  // Pull the whole claimable basket from the vault in one call.
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
        <div className="cx-empty__body">A Delos coin address is 42 characters long and ends in c0de. Check the link and try again.</div>
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
        <div className="cx-empty__title">Not a Delos coin</div>
        <div className="cx-empty__body">{shortAddr(coinAddr)} isn't a coin launched on this Delos deployment. Only its launches trade here.</div>
        <Link className="cx-cta" style={{ marginTop: 26 }} to="/board">Open the market</Link>
      </div>
    );
  }

  const copy = () => { navigator.clipboard?.writeText(coinAddr); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  const metaNote = pendingMeta && isCreator ? "Your coin's thesis and logo haven't been saved yet." : (loc.state as any)?.metaSaved === false && !meta ? "Launched. Your coin's details weren't saved; connect as the creator to save them." : "";
  // Fee presentation: "Fee X%" where X is the live curve buy fee for buys (shows the launch-window penalty),
  // the curve sell fee for sells, and base + reflection in the canonical pool. Never a Uniswap tier.
  const launchTaxBps = onCurve && buy && buyFeeBps != null && buyFeeBps > standingFeeBps ? buyFeeBps - standingFeeBps : 0;
  const feeBps = onCurve ? (buy ? (buyFeeBps ?? standingFeeBps) : (sellFeeBps ?? standingFeeBps)) : standingFeeBps;
  const feeRate = feeBps / 10000;
  let amountInRaw: bigint | null = null;
  try { amountInRaw = amount ? parseUnits(amount, buy ? quoteDec : 18) : null; } catch { amountInRaw = null; }
  const overRoom = buy && onCurve && maxIn != null && amountInRaw != null && amountInRaw > maxIn;
  const feePctLabel = pctLabel(feeBps);
  const standingFeeLabel = pctLabel(standingFeeBps);
  const feeNote = launchTaxBps > 0 ? `${feeBreakdown(reflectionBps)} + ${pctLabel(launchTaxBps)} launch window` : feeBreakdown(reflectionBps);
  const outUnits = buy ? 18 : quoteDec;
  const outHuman = quoteOut != null ? Number(formatUnits(quoteOut, outUnits)) : null;
  const feeDisp = buy
    ? `${fmtAmount((Number(amount) || 0) * feeRate, 5)} ${anchor}`
    : outHuman != null ? `${fmtAmount((outHuman * feeRate) / (1 - feeRate), 5)} ${anchor}` : "—";
  const routeDisp = onCurve ? "The Delos curve" : graduated ? (isV4 ? "Canonical pool" : "Uniswap V3 pool (legacy)") : "—";
  const balDisp = !me ? "" : buy
    ? quoteBal != null ? `Balance ${fmtAmount(Number(formatUnits(quoteBal, quoteDec)))} ${paymentSymbol}` : ""
    : coinBal != null ? `Balance ${fmtAmount(Number(formatUnits(coinBal, 18)), 2)} ${coinSym}` : "";
  const sellPreset = (pct: number) => { if (coinBal == null) return; setAmount(formatUnits((coinBal * BigInt(pct)) / 100n, 18)); };
  const claimable = hasClaimable(rewards);
  const basketDisp = rewards?.assets.map((a) => `${a.ticker} ${Math.round(a.weightBps / 100)}%`).join(", ");
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
            <div className="cx-label">{cq.resolved ? <>{isV4 ? "Delos coin" : "Legacy coin"} · anchored to {anchorNode}{reflectionBps > 0 ? ` · ${pctLabel(reflectionBps)} holder reflection` : ""}{pairable ? " · Company coin" : ""}</> : "Loading"}</div>
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
          ]} />
        </div>

        {meta?.description && (
          <>
            <div className="cx-section-title" style={{ margin: "44px 0 14px" }}>About</div>
            <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, color: "var(--census-text-secondary)", whiteSpace: "pre-wrap" }}>{meta.description}</p>
          </>
        )}

        <div className="cx-section-title" style={{ margin: "44px 0 16px" }}>Price and trades</div>
        <MarketChart address={coinAddr} symbol={coinSym} quoteSymbol={anchor} quoteDecimals={quoteDec} />

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
            ? isV4
              ? `The curve closed. Liquidity is locked permanently in the canonical Delos pool, where the hook keeps charging the ${standingFeeLabel} fee.`
              : "The curve closed. Liquidity is locked permanently in a legacy Uniswap V3 pool."
            : graduationTarget != null
              ? `At ${fmtAmount(graduationTarget, 2)} ${anchor} the curve closes and liquidity moves to the canonical Delos pool, locked permanently. The same ${standingFeeLabel} fee applies there.`
              : `When the curve fills, liquidity moves to the canonical Delos pool, locked permanently. The same ${standingFeeLabel} fee applies there.`}
        </p>

        {pairable && (
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
              {rewards == null ? (
                <div className="cx-stat__note" style={{ marginTop: 0 }}>Reading the vault…</div>
              ) : (
                <>
                  <div className="cx-stat__note" style={{ marginTop: 0, marginBottom: 14 }}>
                    Holders of ${coinSym || "this coin"} earn a {pctLabel(reflectionBps)} reflection on every trade, paid in {basketDisp || "the reward basket"}. Rewards are paid in {anchor} and listed stocks, never in the coin. Basket and reflection were fixed at launch.
                  </div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {rewards.assets.map((a) => (
                      <div key={a.asset} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 9, fontSize: 14 }}>
                          <AnchorMark anchor={a.ticker} isCoin={a.isQuote && anchorIsCoin} size={18} />
                          {a.ticker}
                          <span className="cx-label">{Math.round(a.weightBps / 100)}%</span>
                        </span>
                        <Num kind={a.amount > 0n ? "key" : "value"}>{!isConnected ? "—" : a.amount > 0n ? fmtAmount(Number(formatUnits(a.amount, a.decimals)), 6) : "—"}</Num>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginTop: 18, flexWrap: "wrap" }}>
                    <div className="cx-stat__note" style={{ marginTop: 0 }}>
                      {!isConnected
                        ? "Connect to see what you can claim."
                        : rewards.undistributed > 0n
                          ? `${fmtAmount(Number(formatUnits(rewards.undistributed, quoteDec)), 5)} ${anchor} of fees are waiting to be distributed into the basket.`
                          : "Fees are distributed into the basket as they arrive."}
                    </div>
                    {isConnected
                      ? <button className="cx-cta" onClick={claim} disabled={!claimable || claiming} title={claimable ? undefined : "Nothing to claim yet"}>{claiming ? "Claiming…" : "Claim"}</button>
                      : <button className="cx-cta" onClick={connect} disabled={connecting}>{connecting ? "Connecting…" : "Connect wallet"}</button>}
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
                <button key={side} disabled={busy || conversionBusy} onClick={() => { setBuy(side === "buy"); setAmount(side === "buy" ? "0.1" : ""); }} aria-pressed={on}
                  style={{ background: "none", border: 0, cursor: "pointer", fontSize: 15, paddingTop: 15, paddingBottom: 14, marginBottom: -1,
                    fontWeight: on ? 500 : 400, color: on ? "var(--census-text)" : "var(--census-text-muted)",
                    borderBottom: `1px solid ${on ? "var(--census-lime)" : "transparent"}` }}>
                  {side === "buy" ? "Buy" : "Sell"}
                </button>
              );
            })}
          </div>

          <div className="cx-field" style={{ marginTop: 26, paddingBottom: 14 }}>
            <input value={amount} disabled={busy || conversionBusy} inputMode="decimal" aria-label="Amount" placeholder="0" onChange={(e) => setAmount(e.target.value)}
              style={{ fontFamily: "var(--census-font-mono)", fontSize: 30, fontVariantNumeric: "tabular-nums" }} />
            <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
              {buy ? <AnchorMark anchor={anchor} isCoin={anchorIsCoin} size={20} /> : <CxAvatar name={coinName} image={meta?.image} size={20} />}
              <span className="cx-num" style={{ fontSize: 13, color: "var(--census-text-secondary)" }}>{buy ? paymentSymbol : coinSym || "coin"}</span>
            </span>
          </div>

          {isWethQuote && <label className="cx-label" style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 14 }}>
            {buy ? "Pay with" : "Receive"}
            <select aria-label={buy ? "Payment asset" : "Receive asset"} value={useNative ? "ETH" : "WETH"} disabled={busy} onChange={e => setUseNative(e.target.value === "ETH")}>
              <option value="ETH">ETH</option><option value="WETH">WETH</option>
            </select>
          </label>}
          {onPool && isWethQuote && useNative && <div className="cx-label" style={{ marginTop: 10 }}>
            {buy ? "ETH is wrapped before the swap. Your wallet will confirm each required step." : "The pool pays WETH, then your wallet confirms converting the proceeds to ETH."}
          </div>}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 22 }}>
              {buy
                ? BUY_PRESETS.map((a) => <button key={a} className="cx-link-control" aria-pressed={amount === a} onClick={() => setAmount(a)}>{a}</button>)
                : SELL_PRESETS.map((p) => <button key={p} className="cx-link-control" disabled={coinBal == null || coinBal === 0n} onClick={() => sellPreset(p)}>{p}%</button>)}
            </div>
            {balDisp && <span className="cx-label">{balDisp}</span>}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 28 }}>
            <QuoteRow label="You receive ~" value={outHuman != null ? `${fmtAmount(outHuman, 6)} ${buy ? coinSym : paymentSymbol}` : "—"} bright />
            <QuoteRow label={`Fee ${feePctLabel}`} value={feeDisp} />
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
          {launchTaxBps > 0 && (
            <div className="cx-label" style={{ marginTop: 12, color: "var(--census-text-secondary)" }}>
              Launch window: buys pay {feePctLabel} right now, falling to {standingFeeLabel} within three seconds of launch. The block your trade lands in sets the rate.
            </div>
          )}
          {overRoom && maxIn != null && (
            <div className="cx-label" style={{ marginTop: 12, color: "var(--census-text-secondary)" }}>
              Only {fmtAmount(Number(formatUnits(maxIn, quoteDec)), 5)} {anchor} of room is left before the curve fills; anything above that is refunded in the same transaction.
            </div>
          )}

          {isConnected ? (
            <button className="cx-cta" style={{ width: "100%", marginTop: 26, padding: 16, fontSize: 16 }} disabled={busy || conversionBusy || !!pendingTrade || !canTrade || quoteOut == null} onClick={trade}>
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
          {!busy && <button className="cx-link-control" style={{ marginTop: 12 }} onClick={() => { setTick(t => t + 1); setRetryNonce(n => n + 1); }}>Refresh price and trading status</button>}
          <div className="cx-label" style={{ textAlign: "center", marginTop: 14 }}>
            {onCurve ? `Fee ${feePctLabel} · ${feeNote}` : onPool ? `Fee ${standingFeeLabel} · ${feeBreakdown(reflectionBps)}` : "—"}
          </div>
          {onPool && (
            <div className="cx-label" style={{ textAlign: "center", marginTop: 10, color: "var(--census-text-secondary)" }}>
              Charged by the Delos hook in the canonical pool. Trades in other venues aren't charged and don't fund creator or holder rewards.
            </div>
          )}
          {anchorIsCoin && <div className="cx-label" style={{ textAlign: "center", marginTop: 10, color: "var(--census-text-secondary)" }}>Trades settle in ${anchor} — hold some to buy.</div>}
          {!isConnected && connectError && <div style={{ textAlign: "center", marginTop: 10, fontSize: 13, color: "#e06c60" }}>{connectError}</div>}
          {isConnected && tradeBlock && <div className="cx-label" style={{ textAlign: "center", marginTop: 10, color: "var(--census-text-secondary)" }}>{tradeBlock}</div>}
          {status && <div className="cx-label" style={{ textAlign: "center", marginTop: 10, color: "var(--census-text-secondary)" }}>{status}</div>}
          {pendingTrade && <p className="cx-label">Submitted transaction awaiting confirmation. <a href={`${EXPLORER}/tx/${pendingTrade}`} target="_blank" rel="noreferrer">View transaction</a> · <button className="cx-link-control" disabled={busy} onClick={checkPendingTrade}>Check confirmation</button></p>}
          {isWethQuote && canTrade && <PaymentConversion coin={coinAddr} disabled={busy || !!pendingTrade} ensureChain={ensureChain} onBusy={setConversionBusy} onFunded={received => {
            setBuy(true); setUseNative(false); setQuoteOut(null); setAmount(formatUnits(received, 18)); setTick(t => t + 1);
          }} />}
        </div>

        <div className="cx-panel cx-panel--plain" style={{ marginTop: 16 }}>
          <div className="cx-label" style={{ marginBottom: 14 }}>The curve</div>
          <CurveRow k="Supply" v={supply != null ? fmtAmount(supply, 0) : "—"} />
          <CurveRow k="Anchored to" v={cq.resolved ? anchor : "—"} />
          <CurveRow k="Graduation at" v={graduationTarget != null ? `${fmtAmount(graduationTarget, 2)} ${anchor}` : "—"} />
          <CurveRow k="Trade fee" v={cq.resolved ? `${standingFeeLabel} (${feeBreakdown(reflectionBps)})` : TRADE_FEE_LABEL} />
          {hasVault && <CurveRow k="Holder reflection" v={`${pctLabel(reflectionBps)} → ${basketDisp || "reward basket"}`} />}
          <CurveRow k="Trades on" v={onCurve ? "The Delos curve" : graduated ? (isV4 ? "Canonical pool · Delos hook" : "Uniswap V3 pool (legacy)") : "—"} />
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
