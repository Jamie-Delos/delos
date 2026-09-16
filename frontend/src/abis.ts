import { parseAbi } from "viem";

// LaunchFactory (Prima) — deploys a fixed-supply ERC-20 and seeds the WHOLE supply into the CensusCurve
// bonding curve. There is NO DEX pool at launch: trading is on the curve (`poolFee` is only the tier for
// the pool the curve mints on graduation). `quote` = the anchor asset (WETH default, or e.g. HOOD).
// The 2-arg overload still exists on-chain for legacy callers; the app always calls this 4-arg form,
// passing an empty `exemptBuyers` (no launch-bundle anti-snipe exemptions).
export const factoryAbi = parseAbi([
  "function createLaunch((string name,string symbol,uint256 totalSupply,uint8 decimals,uint24 poolFee,uint256 virtualQuote,uint256 graduationQuote) p, bytes32 salt, address quote, address[] exemptBuyers) returns (address token)",
  "event Launched(address indexed token,address indexed creator,address curve,uint256 virtualQuote,uint256 graduationQuote)",
]);

// LaunchFactoryV2 (Maxima) — same curve launch plus a per-token DividendVault: basket of tokenised stocks
// + bps weights (sum 10000) + per-stock swap route, a CREATE2 salt (bytes32(0) = plain deploy), and the
// holders' share of the creator-side fee (holdersBps). `quote` is the curve's anchor AND the vault's
// fee asset. The 5-arg overload still exists on-chain for legacy callers; the app always calls this form.
export const factoryV2Abi = parseAbi([
  "function createLaunch((string name,string symbol,uint256 totalSupply,uint8 decimals,uint24 poolFee,uint256 virtualQuote,uint256 graduationQuote) p, address[] basket, uint16[] weights, bytes[] paths, bytes32 salt, address quote, uint16 holdersBps, address[] exemptBuyers) returns (address token,address vault)",
  "event LaunchedV2(address indexed token,address indexed creator,address curve,address vault,uint16 holdersBps)",
]);

// CensusCurve — the un-dodgeable bonding-curve venue every coin trades on until it graduates. buy/sell
// trade against the curve (fee per FEE_BPS, split per PROTOCOL_BPS on-chain). `curves(coin)` is the
// per-coin state tuple; quoteBuy/quoteSell are the fee-net readouts; graduationProgress is 0..10000 bps.
export const censusCurveAbi = parseAbi([
  "function buy(address coin,uint256 quoteIn,uint256 minTokensOut) returns (uint256 tokensOut)",
  "function buyWithETH(address coin,uint256 minTokensOut) payable returns (uint256 tokensOut)",
  "function sell(address coin,uint256 tokensIn,uint256 minQuoteOut) returns (uint256 quoteOut)",
  "function sellForETH(address coin,uint256 tokensIn,uint256 minQuoteOut) returns (uint256 quoteOut)",
  "function curves(address coin) view returns (address quote,address creator,address vault,uint16 holdersBps,uint24 poolFee,uint256 virtualQuote,uint256 tokenReserve,uint256 realQuote,uint256 graduationQuote,bool graduated,bool exists)",
  "function quoteBuy(address coin,uint256 quoteIn) view returns (uint256 tokensOut)",
  "function quoteSell(address coin,uint256 tokensIn) view returns (uint256 quoteOut)",
  "function graduationProgress(address coin) view returns (uint256)",
]);

// LaunchLocker — the permanently locked pool positions. Reserved for the creator-rewards "Collect" flow,
// which opens once the indexer can attribute positions to coins.
export const lockerAbi = parseAbi([
  "function collectFees(uint256 tokenId) returns (uint256 amount0,uint256 amount1)",
  "function locks(uint256 tokenId) view returns (address creator,address token0,address token1,bool exists)",
]);

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
]);

// Minimal Uniswap V3 reads: the factory's pool lookup (a graduated coin's pool) and a pool's spot price —
// used to price anchors from their USDG pools and to quote graduated coins. See lib/anchors.ts, lib/pool.ts.
export const v3FactoryAbi = parseAbi([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)",
]);
export const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

export const wethAbi = parseAbi([
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);

// SwapRouter02 (Robinhood Chain): exactInputSingle without a deadline field.
export const swapRouterAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

// DividendVault (Maxima) — the per-coin rewards vault: its stock basket, what a holder can withdraw
// right now, and the one-call claim. Fees arrive in the coin's anchor and sit in the vault until the
// operator's distribute() swaps them into the basket.
export const vaultAbi = parseAbi([
  "function token() view returns (address)",
  "function quote() view returns (address)",
  "function basketLength() view returns (uint256)",
  "function basket(uint256) view returns (address)",
  "function weights(uint256) view returns (uint16)",
  "function withdrawableOf(address holder,address stock) view returns (uint256)",
  "function claim()",
]);
