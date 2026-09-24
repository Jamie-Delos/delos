import { encodePacked, parseAbi, parseEventLogs, zeroAddress, type Address, type Hex, type PublicClient, type Log } from "viem";
import { CONTRACTS } from "../config";
import { v3FactoryAbi } from "../abis";

const USDG: Address = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const FEES = [100, 500, 3000, 10000];
const quoteAbi = parseAbi(["function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)"]);
export type PaymentRoute = { path: Hex; fees: number[]; viaUSDG: boolean; amountOut: bigint };
const pairs = new Map<string, { at: number; fees: number[] }>();

export function minimumOutput(out: bigint, slippageBps: number): bigint {
  if (out <= 0n || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10000) throw new Error("Invalid minimum output");
  const minimum = out * BigInt(10000 - slippageBps) / 10000n;
  if (minimum <= 0n) throw new Error("Amount too small for a protected swap");
  return minimum;
}

export function receivedWeth(logs: Log[], recipient: Address): bigint {
  const transfers = parseEventLogs({ abi: parseAbi(["event Transfer(address indexed from,address indexed to,uint256 value)"]),
    eventName: "Transfer", logs: logs.filter(l => l.address.toLowerCase() === CONTRACTS.weth.toLowerCase()) });
  return transfers.reduce((sum, log) => sum + (log.args.to.toLowerCase() === recipient.toLowerCase() ? log.args.value : 0n), 0n);
}

async function pairFees(pc: PublicClient, a: Address, b: Address): Promise<number[]> {
  const key = `${pc.uid}:${CONTRACTS.v3Factory}:${[a.toLowerCase(), b.toLowerCase()].sort().join(":")}`;
  const hit = pairs.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.fees;
  // An RPC error is not "no route": don't cache failures as absent pools.
  const pools = await Promise.all(FEES.map(fee => pc.readContract({ address: CONTRACTS.v3Factory, abi: v3FactoryAbi, functionName: "getPool", args: [a, b, fee] })));
  const fees = FEES.filter((_, i) => pools[i] !== zeroAddress);
  pairs.set(key, { at: Date.now(), fees });
  return fees;
}

// Bounded route discovery: arbitrary standard ERC20 -> WETH directly or via USDG. The final
// token purchase always uses Census's canonical venue; no route silently bypasses its hook.
// Tokens on other chains, taxed-transfer tokens, and assets with no supported liquidity aren't promised.
export async function quotePaymentRoute(pc: PublicClient, token: Address, amountIn: bigint): Promise<PaymentRoute | null> {
  if (amountIn <= 0n || token.toLowerCase() === CONTRACTS.weth.toLowerCase() || CONTRACTS.conversionQuoter === zeroAddress) return null;
  const candidates: Omit<PaymentRoute, "amountOut">[] = [];
  for (const fee of await pairFees(pc, token, CONTRACTS.weth)) {
    candidates.push({ path: encodePacked(["address", "uint24", "address"], [token, fee, CONTRACTS.weth]), fees: [fee], viaUSDG: false });
  }
  if (token.toLowerCase() !== USDG.toLowerCase()) {
    const [first, second] = await Promise.all([pairFees(pc, token, USDG), pairFees(pc, USDG, CONTRACTS.weth)]);
    for (const a of first) for (const b of second) {
      candidates.push({ path: encodePacked(["address", "uint24", "address", "uint24", "address"], [token, a, USDG, b, CONTRACTS.weth]), fees: [a, b], viaUSDG: true });
    }
  }
  let best: PaymentRoute | null = null;
  for (let i = 0; i < candidates.length; i += 4) {
    const quoted = await Promise.all(candidates.slice(i, i + 4).map(async route => {
      try {
        const { result } = await pc.simulateContract({ address: CONTRACTS.conversionQuoter, abi: quoteAbi, functionName: "quoteExactInput", args: [route.path, amountIn] });
        return result[0] > 0n ? { ...route, amountOut: result[0] } : null;
      } catch { return null; }
    }));
    for (const route of quoted) if (route && (!best || route.amountOut > best.amountOut)) best = route;
  }
  return best;
}
