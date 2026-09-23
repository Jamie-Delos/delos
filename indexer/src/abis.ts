import { parseAbi } from "viem";

// CensusCurve events the indexer ingests + views it reads for reconciliation.
export const curveAbi = parseAbi([
  "event Registered(address indexed coin, address quote, address creator, address vault, uint16 holdersBps, uint256 virtualQuote, uint256 graduationQuote)", // legacy deployments
  "event Registered(address indexed coin, address quote, address creator, address vault, uint16 holdersBps, uint256 virtualQuote, uint256 graduationQuote, uint256 virtualTokenOffset)",
  "event Traded(address indexed coin, address indexed trader, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 fee)",
  "event Graduated(address indexed coin, address pool, uint256 tokenId, uint256 tokensIn, uint256 quoteIn)",
  "function curves(address) view returns (address quote,address creator,address vault,uint16 holdersBps,uint24 poolFee,uint256 virtualQuote,uint256 tokenReserve,uint256 realQuote,uint256 graduationQuote,bool graduated,bool exists)",
  "function graduationProgress(address) view returns (uint256)",
]);

// V4 product: CensusCurveV4 (contracts/contracts/v4/CensusCurveV4.sol). Registered/Traded share the
// PF topics; FeeAllocated splits each trade's fee; Graduated identifies the canonical V4 pool by id.
export const curveV4Abi = parseAbi([
  "event Registered(address indexed coin, address quote, address creator, address vault, uint16 reflectionBps, uint256 virtualQuote, uint256 graduationQuote, uint256 virtualTokenOffset)",
  "event Traded(address indexed coin, address indexed trader, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 fee)",
  "event FeeAllocated(address indexed coin, bool isBuy, uint256 protocolFee, uint256 creatorFee, uint256 holderFee, uint256 penalty)",
  "event Graduated(address indexed coin, bytes32 indexed poolId, uint256 tokensIn, uint256 quoteIn, uint128 liquidity)",
  "function curves(address) view returns (address quote,address creator,address vault,uint16 reflectionBps,uint256 virtualQuote,uint256 tokenReserve,uint256 realQuote,uint256 graduationQuote,bool graduated,bool exists)",
  "function poolIds(address) view returns (bytes32)",
  "function graduationProgress(address) view returns (uint256)",
]);

// Uniswap V4 PoolManager swap (deltas are the swapper's: negative = paid into the pool).
export const poolManagerAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);

// CensusV4Hook: one FeeAccrued per swap on a Census pool; FeesClaimed when accrued fees are pushed.
export const hookAbi = parseAbi([
  "event FeeAccrued(bytes32 indexed poolId, bool buy, uint256 quoteVolume, uint256 protocolFee, uint256 creatorFee, uint256 holderFee)",
  "event FeesClaimed(address indexed asset, address indexed recipient, uint256 amount)",
  "event PoolRegistered(bytes32 indexed poolId, address quote, address creator, address rewards, uint16 reflectionBps)",
]);

// CensusRewardVault (per V4 launch): same Distributed/Claimed topics as the V3 DividendVault.
export const rewardVaultAbi = parseAbi([
  "event Distributed(uint256 quoteSpent)",
  "event Claimed(address indexed holder, address indexed asset, uint256 amount)",
]);

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);
