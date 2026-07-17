import { defineChain, type Address } from "viem";

// Chain + Uniswap addresses are env-driven so one build can target Robinhood Chain (default) or
// Arc (Circle L1, USDC gas) just by setting frontend/.env.
const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 4663);
const RPC_URL = import.meta.env.VITE_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";

const IS_ARC = CHAIN_ID === 5042002;
const IS_ROBINHOOD_TESTNET = CHAIN_ID === 46630;

// Native/quote symbol: USDC on Arc, ETH on the Robinhood chains. Overridable via env.
const QUOTE_SYMBOL = import.meta.env.VITE_QUOTE_SYMBOL ?? (IS_ARC ? "USDC" : "ETH");

const CHAIN_META: Record<number, { name: string; explorer: string }> = {
  4663: { name: "Robinhood Chain", explorer: "https://robinhoodchain.blockscout.com" },
  46630: { name: "Robinhood Chain Testnet", explorer: "https://explorer.testnet.chain.robinhood.com" },
  5042002: { name: "Arc Testnet", explorer: "https://testnet.arcscan.app" },
};
const meta = CHAIN_META[CHAIN_ID] ?? { name: "Chain " + CHAIN_ID, explorer: "" };

export const CHAIN = defineChain({
  id: CHAIN_ID,
  name: meta.name,
  nativeCurrency: { name: QUOTE_SYMBOL, symbol: QUOTE_SYMBOL, decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: meta.explorer ? { default: { name: "Explorer", url: meta.explorer } } : undefined,
});

const zero = "0x0000000000000000000000000000000000000000" as Address;

export const CONTRACTS = {
  factory: (import.meta.env.VITE_FACTORY_ADDRESS ?? zero) as Address,
  locker: (import.meta.env.VITE_LOCKER_ADDRESS ?? zero) as Address,
  // Quote asset (the "WETH" side of every pool). Robinhood WETH by default; Arc = WUSDC via .env.
  weth: (import.meta.env.VITE_WETH ?? "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73") as Address,
  swapRouter: (import.meta.env.VITE_SWAP_ROUTER ?? "0xCaf681a66D020601342297493863E78C959E5cb2") as Address,
};

export const DEFAULT_FEE = 10000; // 1% tier — the launch standard

// Quote symbol for UI unit labels, and whether the DEX router's exactInputSingle takes a deadline
// (Arc's UNITFLOW V3 is a v1-style SwapRouter that does; Robinhood's SwapRouter02 does not).
export const QUOTE = QUOTE_SYMBOL;
export const SWAP_HAS_DEADLINE = (import.meta.env.VITE_SWAP_DEADLINE ?? (IS_ARC ? "1" : "0")) === "1";

// Launch economics. On ETH-quoted chains the quote is ~$3000; on Arc it's USDC (~$1), so the same
// ~$3.6k→$60k mcap band needs ~3000× the price constants. Overridable via env.
const arcDefaults = { launch: 3.6e-6, grad: 6.0e-5 };
const ethDefaults = { launch: 1.2e-9, grad: 2.0e-8 };
const d = IS_ARC ? arcDefaults : ethDefaults;

export const STANDARD = {
  decimals: 18,
  quoteDecimals: Number(import.meta.env.VITE_QUOTE_DECIMALS ?? 18),
  totalSupply: 1_000_000_000, // 1B
  fee: 10000, // 1%
  launchPriceWethPerToken: Number(import.meta.env.VITE_LAUNCH_PRICE ?? d.launch),
  graduationPriceWethPerToken: Number(import.meta.env.VITE_GRAD_PRICE ?? d.grad),
};

void IS_ROBINHOOD_TESTNET; // (kept for clarity; explorer handled via CHAIN_META)
