// Off-chain math for a single-sided Uniswap V3 launch position.
//
// Given the (future) token address, WETH address, decimals, fee tier and a desired starting
// price (WETH per whole token), this computes:
//   - sqrtPriceX96   : the pool's initial price, encoded as sqrt(token1/token0) * 2^96
//   - tickLower/Upper : a range placed ENTIRELY on the sell side of the start price, so the
//                       minted position holds 100% of the launch token and 0 WETH.
//
// Uniswap price is always token1-per-token0 in raw base units, and token0/token1 are ordered by
// numeric address. So the geometry flips depending on whether the launch token sorts below WETH.

const MIN_TICK = -887272;
const MAX_TICK = 887272;

const TICK_SPACING = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

// Integer square root for BigInt (Newton's method).
function isqrt(value) {
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

function tenPow(n) {
  return 10n ** BigInt(n);
}

// Build price_raw = token1_baseunits per token0_baseunits as an exact BigInt fraction num/den.
// `quoteDecimals` is the decimals of the quote asset (18 for WETH and for Arc's WUSDC; would be 6
// for a raw-USDC-quoted chain).
function rawPriceFraction({ tokenIsToken0, tokenDecimals, quoteDecimals = 18, priceWethPerToken }) {
  // Human price as a fraction numH/denH (18 dp of precision is plenty for a testnet start price).
  const denH = tenPow(18);
  const numH = BigInt(Math.round(priceWethPerToken * 1e18));
  if (numH <= 0n) throw new Error("priceWethPerToken must be > 0");

  let num, den;
  if (tokenIsToken0) {
    // token0 = TOKEN(tokenDecimals), token1 = QUOTE. price_raw = P_h * 10^(quoteDecimals - tokenDecimals)
    const e = quoteDecimals - tokenDecimals;
    if (e >= 0) { num = numH * tenPow(e); den = denH; }
    else { num = numH; den = denH * tenPow(-e); }
  } else {
    // token0 = QUOTE, token1 = TOKEN(tokenDecimals). price_raw = (1/P_h) * 10^(tokenDecimals - quoteDecimals)
    const e = tokenDecimals - quoteDecimals;
    if (e >= 0) { num = denH * tenPow(e); den = numH; }
    else { num = denH; den = numH * tenPow(-e); }
  }
  return { num, den };
}

function usableTick(tick, spacing, roundUp) {
  const q = Math.trunc(tick / spacing);
  let t = q * spacing;
  if (roundUp && t < tick) t += spacing;
  if (!roundUp && t > tick) t -= spacing;
  return t;
}

/**
 * @param {object} o
 * @param {string} o.token   future launch token address (0x...)
 * @param {string} o.weth    WETH address (0x...)
 * @param {number} o.tokenDecimals
 * @param {number} o.fee     500 | 3000 | 10000
 * @param {number} o.priceWethPerToken  starting price, WETH per 1 whole token
 * @returns {{ sqrtPriceX96: string, tickLower: number, tickUpper: number, tokenIsToken0: boolean }}
 */
function computeLaunchParams({ token, weth, tokenDecimals = 18, quoteDecimals = 18, fee = 3000, priceWethPerToken }) {
  const spacing = TICK_SPACING[fee];
  if (!spacing) throw new Error(`unsupported fee tier ${fee}`);

  const tokenIsToken0 = BigInt(token) < BigInt(weth);

  const { num, den } = rawPriceFraction({ tokenIsToken0, tokenDecimals, quoteDecimals, priceWethPerToken });

  // sqrtPriceX96 = floor( sqrt(num/den) * 2^96 ) = floor( sqrt( (num << 192) / den ) )
  const sqrtPriceX96 = isqrt((num << 192n) / den);

  // Current tick = floor( ln(price_raw) / ln(1.0001) ).
  const priceFloat = Number(num) / Number(den);
  const currentTick = Math.floor(Math.log(priceFloat) / Math.log(1.0001));

  const maxUsable = usableTick(MAX_TICK, spacing, false);
  const minUsable = usableTick(MIN_TICK, spacing, true);

  let tickLower, tickUpper;
  if (tokenIsToken0) {
    // We hold token0 (the launch token). Position is 100% token0 when currentTick <= tickLower,
    // so put the whole range ABOVE the start price: sell TOKEN for WETH as price rises.
    tickLower = usableTick(currentTick, spacing, true);
    if (tickLower <= currentTick) tickLower += spacing;
    tickUpper = maxUsable;
  } else {
    // We hold token1 (the launch token). Position is 100% token1 when currentTick >= tickUpper,
    // so put the whole range BELOW the start price.
    tickUpper = usableTick(currentTick, spacing, false);
    if (tickUpper >= currentTick) tickUpper -= spacing;
    tickLower = minUsable;
  }

  if (tickLower >= tickUpper) {
    throw new Error("degenerate tick range; adjust priceWethPerToken or fee tier");
  }

  return {
    sqrtPriceX96: sqrtPriceX96.toString(),
    tickLower,
    tickUpper,
    tokenIsToken0,
  };
}

/**
 * Tick (pool orientation, unaligned) at which the token graduates — i.e. the tick corresponding
 * to `graduationPriceWethPerToken`. Compared live against the pool tick in LaunchLocker.
 */
function computeGraduationTick({ token, weth, tokenDecimals = 18, quoteDecimals = 18, graduationPriceWethPerToken }) {
  const tokenIsToken0 = BigInt(token) < BigInt(weth);
  const { num, den } = rawPriceFraction({ tokenIsToken0, tokenDecimals, quoteDecimals, priceWethPerToken: graduationPriceWethPerToken });
  const priceFloat = Number(num) / Number(den);
  return Math.floor(Math.log(priceFloat) / Math.log(1.0001));
}

module.exports = { computeLaunchParams, computeGraduationTick, isqrt, TICK_SPACING, MIN_TICK, MAX_TICK };
