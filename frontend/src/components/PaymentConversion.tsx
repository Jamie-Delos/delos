import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { formatUnits, isAddress, parseUnits, type Address, type Hex } from "viem";
import { CHAIN, CONTRACTS, EXPLORER } from "../config";
import { erc20Abi, swapRouterAbi } from "../abis";
import { assertLaunchChain } from "../lib/launchReceipt";
import { quotePaymentRoute, receivedWeth, minimumOutput, type PaymentRoute } from "../lib/paymentRoutes";

// Conversion is deliberately a separate review step. A cancelled Census purchase leaves the
// converted WETH in the user's wallet. Persist submitted hashes so a timeout cannot invite a repeat.
export function PaymentConversion({ coin, disabled, ensureChain, onFunded, onBusy }: {
  coin: Address; disabled: boolean; ensureChain: () => Promise<boolean>; onFunded: (amount: bigint) => void; onBusy: (busy: boolean) => void;
}) {
  const { address: me } = useAccount();
  const pc = usePublicClient({ chainId: CHAIN.id });
  const { writeContractAsync } = useWriteContract();
  const [token, setToken] = useState("");
  const [amount, setAmount] = useState("");
  const [asset, setAsset] = useState<{ symbol: string; decimals: number } | null>(null);
  const [route, setRoute] = useState<PaymentRoute | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Hex | null>(null);
  const storageKey = `census:conversion:${CHAIN.id}:${me?.toLowerCase()}`;
  useEffect(() => { onBusy(busy || !!pending); return () => onBusy(false); }, [busy, pending, onBusy]);

  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    setPending(saved && /^0x[0-9a-f]{64}$/i.test(saved) ? saved as Hex : null);
  }, [storageKey]);

  useEffect(() => {
    let cancelled = false;
    setRoute(null); setAsset(null); setMessage("");
    if (!pc || !isAddress(token)) return;
    if ([coin, CONTRACTS.weth].some(a => a.toLowerCase() === token.toLowerCase())) {
      setMessage("Choose another payment token; use the main trade panel for this asset."); return;
    }
    const timer = setTimeout(async () => {
      try {
        const [symbol, decimals] = await Promise.all([
          pc.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
          pc.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
        ]);
        if (cancelled) return;
        if (decimals > 36) throw new Error("Unsupported token decimals");
        setAsset({ symbol, decimals });
        if (!amount || Number(amount) <= 0) return;
        const result = await quotePaymentRoute(pc, token, parseUnits(amount, decimals));
        if (cancelled) return;
        setRoute(result);
        if (!result) setMessage("No supported liquid route to WETH found for this amount.");
      } catch { if (!cancelled) setMessage("Couldn't quote this token. Check its address and try again."); }
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pc, token, amount, coin]);

  async function confirm(hash: Hex) {
    if (!pc || !me) return;
    setMessage("Checking conversion confirmation…");
    const receipt = await pc.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status === "reverted") {
      localStorage.removeItem(storageKey); setPending(null);
      throw new Error("Conversion reverted. Your tokens were not converted.");
    }
    const received = receivedWeth(receipt.logs, me);
    // A confirmed conversion must never be resubmitted, even if an unusual token omitted its logs.
    localStorage.removeItem(storageKey); setPending(null); setRoute(null);
    if (received <= 0n) throw new Error("Conversion confirmed. Check your WETH balance before continuing.");
    setMessage(`Converted to ${formatUnits(received, 18)} WETH. Review the refreshed Census quote, then place your purchase above.`);
    onFunded(received);
  }

  async function convert() {
    if (!pc || !me || busy) return;
    setBusy(true);
    try {
      if (!(await ensureChain())) throw new Error(`Switch to ${CHAIN.name}.`);
      await assertLaunchChain(pc, CHAIN.id);
      if (pending) { await confirm(pending); return; }
      if (!asset || !route || !isAddress(token)) return;
      const amountIn = parseUnits(amount, asset.decimals);
      const minimum = minimumOutput(route.amountOut, 100); // explicit 1% conversion tolerance
      const balance = await pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [me] });
      if (balance < amountIn) throw new Error(`Insufficient ${asset.symbol} balance.`);
      const allowance = await pc.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [me, CONTRACTS.swapRouter] });
      if (allowance < amountIn) {
        // Some standard tokens require resetting an existing allowance before changing it.
        for (const value of allowance > 0n ? [0n, amountIn] : [amountIn]) {
          setMessage("Confirm payment-token approval…");
          const hash = await writeContractAsync({ chainId: CHAIN.id, address: token, abi: erc20Abi, functionName: "approve", args: [CONTRACTS.swapRouter, value] });
          const receipt = await pc.waitForTransactionReceipt({ hash, timeout: 60_000 });
          if (receipt.status !== "success") throw new Error("Approval reverted.");
        }
      }
      const args = [{ path: route.path, recipient: me, amountIn, amountOutMinimum: minimum }] as const;
      await pc.simulateContract({ address: CONTRACTS.swapRouter, abi: swapRouterAbi, functionName: "exactInput", args, account: me });
      setMessage("Confirm conversion to WETH in your wallet…");
      const hash = await writeContractAsync({ chainId: CHAIN.id, address: CONTRACTS.swapRouter, abi: swapRouterAbi, functionName: "exactInput", args });
      setPending(hash); localStorage.setItem(storageKey, hash);
      await confirm(hash);
    } catch (e: any) { setMessage(String(e?.shortMessage ?? e?.message ?? e).slice(0, 220)); }
    finally { setBusy(false); }
  }

  return <details style={{ marginTop: 20 }}>
    <summary style={{ cursor: "pointer" }}>Buy using another token</summary>
    <p className="cx-label">1. Convert to WETH. 2. Review and confirm your Census purchase. Separate transactions; any unspent WETH stays in your wallet. ETH is still required for gas.</p>
    <p className="cx-label">Same-network ERC20 tokens with a direct or USDG route on Uniswap V3. Unsupported tokens and other networks need a separate swap or bridge.</p>
    <input className="cx-field" aria-label="Payment token contract address" placeholder="Payment token address (0x…)" value={token} disabled={busy || !!pending || disabled} onChange={e => setToken(e.target.value.trim())} style={{ width: "100%" }} />
    <input className="cx-field" aria-label="Payment token amount" inputMode="decimal" placeholder="Amount to convert" value={amount} disabled={busy || !!pending || disabled} onChange={e => setAmount(e.target.value)} style={{ width: "100%", marginTop: 10 }} />
    {route && asset && <p className="cx-label">{asset.symbol}{route.viaUSDG ? " → USDG" : ""} → WETH: ~{formatUnits(route.amountOut, 18)} WETH. Conversion pool fees: {route.fees.map(f => `${f / 10000}%`).join(" + ")} (included). Conversion slippage: 1%. Census fees apply separately to the next purchase.</p>}
    <button className="cx-cta" style={{ marginTop: 12 }} disabled={busy || disabled || !me || (!pending && !route)} onClick={convert}>{busy ? "Working…" : pending ? "Check submitted conversion" : "Convert to WETH"}</button>
    {pending && <p className="cx-label">Conversion submitted. Check confirmation before repeating: <a href={`${EXPLORER}/tx/${pending}`} target="_blank" rel="noreferrer">View transaction</a></p>}
    {message && <p role="status" className="cx-label">{message}</p>}
  </details>;
}
