// Direct reads of a coin's graduated Uniswap V3 pool. Only used after graduation, when the curve no
// longer prices the coin: an indicative "you receive ~", the displayed price/mcap, and the trade bound.
//
// Pricing is TWAP-first (CX-H1). A one-block Uniswap spot (slot0) is trivially manipulable on a shallow
// full-range position, and it used to drive displayed price, market cap AND the on-chain amountOutMinimum.
// We now read a short time-weighted average via observe() — graduation grows the pool's oracle buffer
// (CensusCurve.GRAD_OBS_CARDINALITY) so an average is available — and fall back to spot only while a
// fresh pool's buffer is still warming. Display/mcap use the TWAP; the trade estimate uses the executable
// spot but is gated by poolTwapDeviationBps (a spot far from the TWAP = manipulation/instability → block).
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

// TWAP windows (seconds), longest first. Graduation grows the oracle buffer, so a multi-minute average
// is available for a normally-traded coin; a still-warming pool serves the shorter window, and a
// brand-new one serves neither (observe reverts "OLD") and the caller falls back to spot.
const TWAP_WINDOWS = [120, 30];

// token1/token0 price (raw units) from a manipulation-resistant TWAP, or null if the pool can't serve
// one yet. Tries progressively shorter windows; observe() reverts when the window exceeds recorded history.
async function poolTwapRaw(pc: PublicClient, pool: Address): Promise<number | null> {
  for (const w of TWAP_WINDOWS) {
    try {
      const res = await pc.readContract({ address: pool, abi: poolAbi, functionName: "observe", args: [[w, 0]] });
      const ticks = res[0] as readonly bigint[];
      const meanTick = Number(ticks[1] - ticks[0]) / w; // arithmetic-mean tick over the window
      const raw = 1.0001 ** meanTick;                    // 1.0001^tick = token1/token0 (raw), same convention as sqrtPrice
      if (Number.isFinite(raw) && raw > 0) return raw;
    } catch { /* window longer than this pool's history — try a shorter one */ }
  }
  return null;
}

// token1/token0 price (raw units) from the live spot.
async function poolSpotRaw(pc: PublicClient, pool: Address): Promise<number | null> {
  try {
    const slot0 = await pc.readContract({ address: pool, abi: poolAbi, functionName: "slot0" });
    const sqrt = Number(slot0[0]);
    if (!(sqrt > 0)) return null;
    return (sqrt / 2 ** 96) ** 2;
  } catch { return null; }
}

// token1/token0 raw price, TWAP-first with a spot fallback for a warming pool. `spotOnly` forces the
// live spot (for an executable trade estimate). Exposes its source so callers can label a spot fallback.
export async function poolRawPrice(pc: PublicClient, pool: Address, spotOnly = false): Promise<{ raw: number; source: "twap" | "spot" } | null> {
  if (!spotOnly) { const t = await poolTwapRaw(pc, pool); if (t != null) return { raw: t, source: "twap" }; }
  const s = await poolSpotRaw(pc, pool);
  return s == null ? null : { raw: s, source: "spot" };
}

function outFromRaw(raw: number, tokenIn: Address, token0: Address, amountIn: bigint, fee: number): bigint | null {
  const rate = tokenIn.toLowerCase() === token0.toLowerCase() ? raw : 1 / raw; // tokenOut per tokenIn
  const out = Number(amountIn) * rate * (1 - fee / 1e6);                       // net of the pool fee
  return Number.isFinite(out) && out > 0 ? BigInt(Math.floor(out)) : null;
}

// Estimated out for swapping `amountIn` of tokenIn for tokenOut (net of the pool fee). Prices off the
// pool TWAP by default so display/mcap can't be moved by a one-block spot; pass spotOnly=true for an
// executable trade estimate. Price impact is ignored — a larger trade simply misses its minimum-out.
export async function poolSpotOut(pc: PublicClient, tokenIn: Address, tokenOut: Address, amountIn: bigint, fee = DEFAULT_FEE, spotOnly = false): Promise<bigint | null> {
  const p = await poolFor(pc, tokenIn, tokenOut, fee);
  if (!p) return null;
  const r = await poolRawPrice(pc, p.pool, spotOnly);
  return r == null ? null : outFromRaw(r.raw, tokenIn, p.token0, amountIn, fee);
}

// How far the live spot has moved from the TWAP, in bps — the instability/manipulation signal used to
// gate a pool trade. null when no TWAP is available yet (a warming pool: the caller decides whether to
// allow the trade on spot alone).
export async function poolTwapDeviationBps(pc: PublicClient, tokenIn: Address, tokenOut: Address, fee = DEFAULT_FEE): Promise<number | null> {
  const p = await poolFor(pc, tokenIn, tokenOut, fee);
  if (!p) return null;
  const [t, s] = await Promise.all([poolTwapRaw(pc, p.pool), poolSpotRaw(pc, p.pool)]);
  if (t == null || s == null || !(t > 0)) return null;
  return Math.abs(s / t - 1) * 10000;
}
