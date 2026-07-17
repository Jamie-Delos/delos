import { parseAbi } from "viem";

export const factoryAbi = parseAbi([
  "function createLaunch((string name,string symbol,uint256 totalSupply,uint8 decimals,uint24 fee,uint160 sqrtPriceX96,int24 tickLower,int24 tickUpper,int24 graduationTick) p) returns (address token,address pool,uint256 tokenId)",
  "event Launched(address indexed token,address indexed creator,address pool,uint256 tokenId,uint128 liquidity)",
]);

export const lockerAbi = parseAbi([
  "function collectFees(uint256 tokenId) returns (uint256 amount0,uint256 amount1)",
  "function locks(uint256 tokenId) view returns (address creator,address token0,address token1,bool exists)",
]);

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);

export const wethAbi = parseAbi([
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);

// SwapRouter02 (Robinhood): exactInputSingle without a deadline.
export const swapRouterAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

// SwapRouter v1 (Arc UNITFLOW): exactInputSingle WITH a deadline field.
export const swapRouterV1Abi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
