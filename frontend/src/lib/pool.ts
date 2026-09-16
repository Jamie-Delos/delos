// Direct reads of a coin's graduated Uniswap V3 pool. Only used after graduation, when the curve no
// longer prices the coin: an indicative "you receive ~" and a minimum-out for the pool trade.
import { zeroAddress, type Address, type PublicClient } from "viem";
import { CONTRACTS, DEFAULT_FEE } from "../config";
import { v3FactoryAbi, poolAbi } from "../abis";

type PoolInfo = { pool: Address; token0: Address };
const cache = new Map<string, PoolInfo | null>();

// The pool for a token pair at a fee tier (null when the factory isn't configured or no pool exists).
export async function poolFor(pc: PublicClient, a: Address, b: Address, fee = DEFAULT_FEE): Promise<PoolInfo | null> {
  if (CONTRACTS.v3Factory === zeroAddress) return null;
  const key = [a.toLowerCase(), b.toLowerCase()].sort().join("/") + ":" + fee;
  if (cache.has(key)) return cache.get(key)!;
  let info: PoolInfo | null = null;
  try {
    const pool = await pc.readContract({ address: CONTRACTS.v3Factory, abi: v3FactoryAbi, functionName: "getPool", args: [a, b, fee] });
    if (pool !== zeroAddress) {
      const token0 = await pc.readContract({ address: pool, abi: poolAbi, functionName: "token0" });
      info = { pool, token0 };
    }
  } catch { info = null; }
  cache.set(key, info);
  return info;
}

// Spot-price estimate of swapping `amountIn` of tokenIn for tokenOut through the pool, net of the pool
// fee. Price impact is ignored: a full-range locked position keeps small trades close to spot, and a
// larger one simply fails its 2% minimum-out instead of filling badly. null when there's no pool.
export async function poolSpotOut(pc: PublicClient, tokenIn: Address, tokenOut: Address, amountIn: bigint, fee = DEFAULT_FEE): Promise<bigint | null> {
  const p = await poolFor(pc, tokenIn, tokenOut, fee);
  if (!p) return null;
  try {
    const slot0 = await pc.readContract({ address: p.pool, abi: poolAbi, functionName: "slot0" });
    const sqrt = Number(slot0[0]);
    if (!(sqrt > 0)) return null;
    const raw = (sqrt / 2 ** 96) ** 2; // token1 per token0, raw units
    const rate = tokenIn.toLowerCase() === p.token0.toLowerCase() ? raw : 1 / raw;
    const out = Number(amountIn) * rate * (1 - fee / 1e6);
    return Number.isFinite(out) && out > 0 ? BigInt(Math.floor(out)) : null;
  } catch {
    return null;
  }
}
