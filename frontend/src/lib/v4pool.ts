// A graduated coin's canonical Uniswap V4 pool: the fixed PoolKey (sorted coin/quote, fee 0, tickSpacing
// 60, hooks = the Census hook), its id, the spot price from StateView, an impact-aware quote from the
// V4Quoter, and the swap request CensusV4Router takes. The Census hook charges the trade fee (2% base +
// reflection) inside this pool; other venues are not charged and do not fund creator/holder rewards.
//
// V4 has no TWAP: the spot is what there is, and callers label it as such.
import { encodeAbiParameters, keccak256, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { CONTRACTS, V4_POOL_FEE, V4_TICK_SPACING } from "../config";
import { stateViewAbi, v4QuoterAbi } from "../abis";

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

// sqrtPriceLimitX96 bounds (TickMath MIN_SQRT_PRICE + 1 / MAX_SQRT_PRICE - 1): "no limit" for the direction.
export const SQRT_PRICE_LIMIT_MIN = 4295128740n; // zeroForOne
export const SQRT_PRICE_LIMIT_MAX = 1461446703485210103287273052203988822378723970341n; // oneForZero

export const v4Configured = () => CONTRACTS.v4Hook !== zeroAddress && CONTRACTS.v4Router !== zeroAddress;

// The pool key for a coin/quote pair. `coinIsCurrency0` says which side the coin sits on: a BUY (quote
// in, coin out) is zeroForOne when the quote is currency0, i.e. when the coin is NOT currency0.
export function poolKeyFor(coin: Address, quote: Address): { key: PoolKey; coinIsCurrency0: boolean } {
  const coinIsCurrency0 = BigInt(coin) < BigInt(quote);
  return {
    coinIsCurrency0,
    key: { currency0: coinIsCurrency0 ? coin : quote, currency1: coinIsCurrency0 ? quote : coin, fee: V4_POOL_FEE, tickSpacing: V4_TICK_SPACING, hooks: CONTRACTS.v4Hook },
  };
}

// poolId = keccak256(abi.encode(PoolKey)) — cross-checked against CensusCurveV4.poolIds(coin).
export const poolIdFor = (key: PoolKey): Hex =>
  keccak256(encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }] }],
    [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]],
  ));

// The swap request for CensusV4Router.swapExactInput. `buy` = quote in, coin out. `minOut` must be > 0
// (the router refuses unprotected trades) and `deadline` is unix seconds.
export function swapRequest(args: { coin: Address; quote: Address; buy: boolean; amountIn: bigint; minOut: bigint; recipient: Address; deadlineSeconds?: number }) {
  const { key, coinIsCurrency0 } = poolKeyFor(args.coin, args.quote);
  const zeroForOne = args.buy ? !coinIsCurrency0 : coinIsCurrency0;
  return {
    key, zeroForOne, amountIn: args.amountIn, minOut: args.minOut,
    sqrtPriceLimitX96: zeroForOne ? SQRT_PRICE_LIMIT_MIN : SQRT_PRICE_LIMIT_MAX,
    recipient: args.recipient,
    deadline: BigInt(Math.floor(Date.now() / 1000) + (args.deadlineSeconds ?? 20 * 60)),
  };
}

// token1/token0 (raw units) from the pool's slot0, or null when StateView isn't configured / the pool
// isn't initialised.
export async function v4SpotRaw(pc: PublicClient, poolId: Hex): Promise<number | null> {
  if (CONTRACTS.stateView === zeroAddress) return null;
  try {
    const slot0 = await pc.readContract({ address: CONTRACTS.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] });
    const sqrt = Number(slot0[0]);
    if (!(sqrt > 0)) return null;
    return (sqrt / 2 ** 96) ** 2;
  } catch { return null; }
}

// Spot price of the coin in quote units (human: quote per 1 coin), oriented by which currency the coin
// is and scaled by decimals (the coin is always 18). Same convention as the indexer's pool-swap pricing.
export async function v4SpotPrice(pc: PublicClient, coin: Address, quote: Address, quoteDecimals: number): Promise<number | null> {
  const { key, coinIsCurrency0 } = poolKeyFor(coin, quote);
  const raw = await v4SpotRaw(pc, poolIdFor(key));
  if (raw == null || !(raw > 0)) return null;
  const p = (coinIsCurrency0 ? raw : 1 / raw) * 10 ** (18 - quoteDecimals);
  return Number.isFinite(p) && p > 0 ? p : null;
}

// Impact-free estimate of what a trade returns, net of the hook fee (base + reflection, in bps), from
// the spot. Used only when no V4Quoter is configured — the user's slippage then covers price impact.
export async function v4SpotOut(pc: PublicClient, coin: Address, quote: Address, buy: boolean, amountIn: bigint, feeBps: number): Promise<bigint | null> {
  const { key, coinIsCurrency0 } = poolKeyFor(coin, quote);
  const raw = await v4SpotRaw(pc, poolIdFor(key));
  if (raw == null || !(raw > 0)) return null;
  // raw = currency1 per currency0. Rate = tokenOut per tokenIn (raw units).
  const inIsCurrency0 = buy ? !coinIsCurrency0 : coinIsCurrency0;
  const rate = inIsCurrency0 ? raw : 1 / raw;
  const out = Number(amountIn) * rate * (1 - feeBps / 10000);
  return Number.isFinite(out) && out > 0 ? BigInt(Math.floor(out)) : null;
}

// Real, price-impact-aware output from the V4Quoter (the hook runs inside the simulated swap, so the
// fee is already in the number). null when no quoter is configured or the quote reverts.
export async function v4QuoteOut(pc: PublicClient, coin: Address, quote: Address, buy: boolean, amountIn: bigint): Promise<bigint | null> {
  if (CONTRACTS.v4Quoter === zeroAddress || amountIn <= 0n || amountIn >= 2n ** 128n) return null;
  const { key, coinIsCurrency0 } = poolKeyFor(coin, quote);
  try {
    const res = await pc.readContract({
      address: CONTRACTS.v4Quoter,
      abi: v4QuoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: key, zeroForOne: buy ? !coinIsCurrency0 : coinIsCurrency0, exactAmount: amountIn, hookData: "0x" }],
    });
    const out = res[0] as bigint;
    return out > 0n ? out : null;
  } catch { return null; }
}
