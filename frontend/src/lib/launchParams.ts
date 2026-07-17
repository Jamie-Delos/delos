// TypeScript port of contracts/scripts/lib/launchParams.js — single-sided V3 launch math.
import type { Address } from "viem";

const MIN_TICK = -887272;
const MAX_TICK = 887272;
const TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

export function isqrt(value: bigint): bigint {
  if (value < 0n) throw new Error("isqrt of negative");
  if (value < 2n) return value;
  let x0 = value;
  let x1 = (x0 + 1n) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) >> 1n;
  }
  return x0;
}

const tenPow = (n: number) => 10n ** BigInt(n);

function rawPriceFraction(tokenIsToken0: boolean, tokenDecimals: number, quoteDecimals: number, priceWethPerToken: number) {
  const denH = tenPow(18);
  const numH = BigInt(Math.round(priceWethPerToken * 1e18));
  if (numH <= 0n) throw new Error("priceWethPerToken must be > 0");

  let num: bigint, den: bigint;
  if (tokenIsToken0) {
    const e = quoteDecimals - tokenDecimals;
    if (e >= 0) { num = numH * tenPow(e); den = denH; }
    else { num = numH; den = denH * tenPow(-e); }
  } else {
    const e = tokenDecimals - quoteDecimals;
    if (e >= 0) { num = denH * tenPow(e); den = numH; }
    else { num = denH; den = numH * tenPow(-e); }
  }
  return { num, den };
}

function usableTick(tick: number, spacing: number, roundUp: boolean): number {
  const q = Math.trunc(tick / spacing);
  let t = q * spacing;
  if (roundUp && t < tick) t += spacing;
  if (!roundUp && t > tick) t -= spacing;
  return t;
}

export interface LaunchParams {
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  tokenIsToken0: boolean;
}

// Tick (pool orientation, unaligned) at the graduation price — compared live against the pool
// tick in LaunchLocker to flip the fee split from 100% creator to 80/20.
export function computeGraduationTick(opts: {
  token: Address;
  weth: Address;
  tokenDecimals?: number;
  quoteDecimals?: number;
  graduationPriceWethPerToken: number;
}): number {
  const { token, weth, tokenDecimals = 18, quoteDecimals = 18, graduationPriceWethPerToken } = opts;
  const tokenIsToken0 = BigInt(token) < BigInt(weth);
  const { num, den } = rawPriceFraction(tokenIsToken0, tokenDecimals, quoteDecimals, graduationPriceWethPerToken);
  const priceFloat = Number(num) / Number(den);
  return Math.floor(Math.log(priceFloat) / Math.log(1.0001));
}

export function computeLaunchParams(opts: {
  token: Address;
  weth: Address;
  tokenDecimals?: number;
  quoteDecimals?: number;
  fee?: number;
  priceWethPerToken: number;
}): LaunchParams {
  const { token, weth, tokenDecimals = 18, quoteDecimals = 18, fee = 3000, priceWethPerToken } = opts;
  const spacing = TICK_SPACING[fee];
  if (!spacing) throw new Error(`unsupported fee tier ${fee}`);

  const tokenIsToken0 = BigInt(token) < BigInt(weth);
  const { num, den } = rawPriceFraction(tokenIsToken0, tokenDecimals, quoteDecimals, priceWethPerToken);

  const sqrtPriceX96 = isqrt((num << 192n) / den);
  const priceFloat = Number(num) / Number(den);
  const currentTick = Math.floor(Math.log(priceFloat) / Math.log(1.0001));

  const maxUsable = usableTick(MAX_TICK, spacing, false);
  const minUsable = usableTick(MIN_TICK, spacing, true);

  let tickLower: number, tickUpper: number;
  if (tokenIsToken0) {
    tickLower = usableTick(currentTick, spacing, true);
    if (tickLower <= currentTick) tickLower += spacing;
    tickUpper = maxUsable;
  } else {
    tickUpper = usableTick(currentTick, spacing, false);
    if (tickUpper >= currentTick) tickUpper -= spacing;
    tickLower = minUsable;
  }

  if (tickLower >= tickUpper) throw new Error("degenerate tick range; adjust price or fee tier");
  return { sqrtPriceX96, tickLower, tickUpper, tokenIsToken0 };
}
