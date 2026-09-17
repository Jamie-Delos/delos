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

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
]);
