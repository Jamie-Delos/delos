import { parseAbi } from "viem";

// LaunchFactoryV4 — every new launch (Prima and Maxima alike). Deploys a fixed-supply ERC-20 (CREATE2,
// …de105 salt bound to the creator) and seeds the WHOLE supply into CensusCurveV4. Optional holder
// reflection (`reflectionBps` 0 or 100..400, ON TOP of the 2% base fee) creates a CensusRewardVault with a
// 1-3 asset basket of QUOTED assets only: the quote asset (path 0x) and/or tokenised stocks that are
// allow-listed on CensusCurveV4 (`allowedRewardAsset`), reached by a V3 path from the quote. The launch
// token is never a reward; any other asset reverts `AssetNotAllowed`. No pool tier: the V4 pool key is fixed.
export const factoryV4Abi = parseAbi([
  "function createLaunch((string name,string symbol,uint256 totalSupply,uint8 decimals,uint256 virtualQuote,uint256 graduationQuote) p, address[] basket, uint16[] weights, bytes[] paths, bytes32 salt, address quote, uint16 reflectionBps, address[] exemptBuyers) returns (address token,address vault)",
  "function createLaunchWithDevBuy((string name,string symbol,uint256 totalSupply,uint8 decimals,uint256 virtualQuote,uint256 graduationQuote) p, address[] basket, uint16[] weights, bytes[] paths, bytes32 salt, address quote, uint16 reflectionBps, address[] exemptBuyers, uint256 devBuyQuoteIn, uint256 devBuyMinTokensOut) payable returns (address token,address vault)",
  "event LaunchedV4(address indexed token,address indexed creator,address curve,address vault,uint16 reflectionBps,address quote)",
  "event DevBought(address indexed token,address indexed creator,address quote,uint256 quoteSpent,uint256 tokensReceived,uint256 quoteRefunded)",
  "error AssetNotAllowed(address asset)",
  "error QuoteNotSupported()",
  "error NotConfigured()",
  "error NotFactory()",
  "error BadParams()",
  "error BadBasket()",
]);

// CensusCurveV4 — the bonding-curve venue every coin trades on until it graduates into the canonical
// hooked V4 pool. Trade calls keep the V3-era shape (buy/buyWithETH/sell/sellForETH + quotes).
// `curves(coin)` is the per-coin state tuple; buyFeeBps includes reflection + the 3-second launch-window
// penalty for THIS buyer, sellFeeBps is base + reflection; poolIds(coin) is the graduated pool's id.
// `allowedRewardAsset(asset)` is the on-chain allow-list of tokenised stocks a reward basket may hold
// (the quote asset is always allowed; the launch token never is) — the wizard offers only those.
export const censusCurveV4Abi = parseAbi([
  "function allowedRewardAsset(address asset) view returns (bool)",
  "function buyFeeBps(address coin,address buyer) view returns (uint256)",
  "function sellFeeBps(address coin) view returns (uint256)",
  "function currentSnipeTaxBps(address coin,address buyer) view returns (uint256)",
  "function launchedAt(address coin) view returns (uint256)",
  "function quoteBuy(address coin,uint256 quoteIn) view returns (uint256 tokensOut)",
  "function quoteBuyFor(address coin,uint256 quoteIn,address buyer) view returns (uint256)",
  "function quoteSell(address coin,uint256 tokensIn) view returns (uint256 quoteOut)",
  "function maxQuoteIn(address coin) view returns (uint256)",
  "function maxQuoteInFor(address coin,address buyer) view returns (uint256)",
  "function virtualTokenOffset(address coin) view returns (uint256)",
  "function graduationProgress(address coin) view returns (uint256)",
  "function isGraduated(address coin) view returns (bool)",
  "function poolIds(address coin) view returns (bytes32)",
  "function buy(address coin,uint256 quoteIn,uint256 minTokensOut) returns (uint256 tokensOut)",
  "function buyWithETH(address coin,uint256 minTokensOut) payable returns (uint256 tokensOut)",
  "function sell(address coin,uint256 tokensIn,uint256 minQuoteOut) returns (uint256 quoteOut)",
  "function sellForETH(address coin,uint256 tokensIn,uint256 minEthOut) returns (uint256 ethOut)",
  "function curves(address coin) view returns (address quote,address creator,address vault,uint16 reflectionBps,uint256 virtualQuote,uint256 tokenReserve,uint256 realQuote,uint256 graduationQuote,bool graduated,bool exists)",
  "event Traded(address indexed coin,address indexed trader,bool isBuy,uint256 amountIn,uint256 amountOut,uint256 fee)",
  "event Graduated(address indexed coin,bytes32 indexed poolId,uint256 tokensIn,uint256 quoteIn,uint128 liquidity)",
  "event RewardAssetAllowed(address indexed asset,bool allowed)",
]);

// CensusV4Router — post-graduation trades in the canonical hooked pool. ERC20 exact-input only (wrap
// ETH to WETH first). PoolKey = sorted(coin, quote), fee 0, tickSpacing 60, hooks = the Census hook.
export const v4RouterAbi = parseAbi([
  "function swapExactInput(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,bool zeroForOne,uint256 amountIn,uint256 minOut,uint160 sqrtPriceLimitX96,address recipient,uint256 deadline) request) returns (uint256 amountOut)",
  "event Swap(address indexed payer,address indexed recipient,address input,address output,uint256 amountIn,uint256 amountOut)",
]);

// CensusV4Hook — the pool's fee policy (base + reflection, creator, rewards vault) and the fees it holds
// for each beneficiary until claimed.
export const v4HookAbi = parseAbi([
  "function policies(bytes32 poolId) view returns (address quote,address creator,address rewards,uint16 reflectionBps,uint64 launchedAt)",
  "function claimable(address asset,address recipient) view returns (uint256)",
  "function claimFor(address asset,address recipient)",
]);

// Uniswap V4 StateView — the canonical pool's spot (there is no TWAP in V4: label it as spot).
export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);

// Uniswap V4Quoter — simulates the swap (hook included, so the fee is in the number) and returns the
// real, price-impact-aware output. Declared `view` locally so viem can eth_call it; on-chain it is
// non-view (it reverts internally to unwind the simulation), which eth_call runs fine.
export const v4QuoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "view",
    inputs: [
      {
        type: "tuple",
        name: "params",
        components: [
          {
            type: "tuple",
            name: "poolKey",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

// ---- legacy V3-era contracts (optional; old testnet coins only) ----

// LaunchFactory (legacy Prima). `poolFee` was the Uniswap V3 tier the curve minted on graduation.
export const factoryAbi = parseAbi([
  "function createLaunch((string name,string symbol,uint256 totalSupply,uint8 decimals,uint24 poolFee,uint256 virtualQuote,uint256 graduationQuote) p, bytes32 salt, address quote, address[] exemptBuyers) returns (address token)",
  "event Launched(address indexed token,address indexed creator,address curve,uint256 virtualQuote,uint256 graduationQuote)",
]);

// LaunchFactoryV2 (legacy Maxima) — curve launch plus a DividendVault with a stock basket and holdersBps.
export const factoryV2Abi = parseAbi([
  "function createLaunch((string name,string symbol,uint256 totalSupply,uint8 decimals,uint24 poolFee,uint256 virtualQuote,uint256 graduationQuote) p, address[] basket, uint16[] weights, bytes[] paths, bytes32 salt, address quote, uint16 holdersBps, address[] exemptBuyers) returns (address token,address vault)",
  "event LaunchedV2(address indexed token,address indexed creator,address curve,address vault,uint16 holdersBps)",
]);

// CensusCurve (legacy) — the V3-era curve. Trade calls share the V4 shape (censusCurveV4Abi works against
// it); only `curves(coin)` differs (holdersBps + poolFee in the tuple), read via lib/curves.ts.
export const legacyCurveAbi = parseAbi([
  "function buyFeeBps(address coin,address buyer) view returns (uint256)",
  "function currentSnipeTaxBps(address coin,address buyer) view returns (uint256)",
  "function launchedAt(address coin) view returns (uint256)",
  "function quoteBuyFor(address coin,uint256 quoteIn,address buyer) view returns (uint256)",
  "function maxQuoteInFor(address coin,address buyer) view returns (uint256)",
  "function virtualTokenOffset(address coin) view returns (uint256)",
  "function maxQuoteIn(address coin) view returns (uint256)",
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
// Uniswap V3 QuoterV2 — simulates a swap and returns the real output INCLUDING price impact (unlike a
// spot read). Declared `view` locally so viem can eth_call it; on-chain it is non-view (it reverts to
// unwind the simulated swap), which eth_call runs fine. Used to quote/bound direct-pool trades.
export const quoterV2Abi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "view",
    inputs: [
      {
        type: "tuple",
        name: "params",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  // Price oracle: a TWAP from tickCumulatives, so price/mcap/trade-bounds don't rely on a one-block spot.
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives,uint160[] secondsPerLiquidityCumulativeX128s)",
]);

export const wethAbi = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);

// SwapRouter02 (Robinhood Chain): exactInputSingle without a deadline field.
export const swapRouterAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
]);

// CensusRewardVault (per V4 launch with reflection; the legacy DividendVault shares this surface) — the
// basket (assets + bps weights), what a holder can withdraw right now per asset, the quote fees waiting
// to be distributed, and the one-call claim.
export const vaultAbi = parseAbi([
  "function token() view returns (address)",
  "function quote() view returns (address)",
  "function basketLength() view returns (uint256)",
  "function basket(uint256) view returns (address)",
  "function weights(uint256) view returns (uint16)",
  "function withdrawableOf(address holder,address asset) view returns (uint256)",
  "function availableQuote() view returns (uint256)",
  "function reserved(address asset) view returns (uint256)",
  "function claim()",
]);
