import { defineChain, zeroAddress, type Address } from "viem";

// Chain + contract addresses are env-driven (frontend/.env), so one build targets Robinhood Chain
// mainnet (4663, the default) or its testnet (46630).
const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 4663);
const RPC_URL = import.meta.env.VITE_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
export const IS_MAINNET = CHAIN_ID === 4663;

const CHAIN_META: Record<number, { name: string; explorer: string }> = {
  4663: { name: "Robinhood Chain", explorer: "https://robinhoodchain.blockscout.com" },
  46630: { name: "Robinhood Chain Testnet", explorer: "https://explorer.testnet.chain.robinhood.com" },
};
const meta = CHAIN_META[CHAIN_ID] ?? { name: "Chain " + CHAIN_ID, explorer: "" };

export const CHAIN = defineChain({
  id: CHAIN_ID,
  name: meta.name,
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: meta.explorer ? { default: { name: "Explorer", url: meta.explorer } } : undefined,
});
export const EXPLORER = meta.explorer;

const addr = (v: string | undefined, fallback: Address = zeroAddress): Address =>
  v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : fallback;

// Census contracts (from .env) plus the chain's Uniswap V3 pieces. The V3 factory and the WETH/USDG
// pool that prices ETH are mainnet facts; testnet has neither, so they stay zero there unless set.
export const CONTRACTS = {
  factory: addr(import.meta.env.VITE_FACTORY_ADDRESS), // LaunchFactory — Prima
  factoryV2: addr(import.meta.env.VITE_FACTORY_V2_ADDRESS), // LaunchFactoryV2 — Maxima (curve + stock-basket vault)
  locker: addr(import.meta.env.VITE_LOCKER_ADDRESS), // LaunchLocker — holds every graduated pool position forever
  curve: addr(import.meta.env.VITE_CURVE_ADDRESS), // CensusCurve — the bonding-curve venue every coin trades on
  weth: addr(import.meta.env.VITE_WETH, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  swapRouter: addr(import.meta.env.VITE_SWAP_ROUTER, "0xCaf681a66D020601342297493863E78C959E5cb2"), // SwapRouter02
  v3Factory: addr(import.meta.env.VITE_V3_FACTORY, IS_MAINNET ? "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" : zeroAddress),
  ethPricePool: addr(import.meta.env.VITE_ETH_PRICE_POOL, IS_MAINNET ? "0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca" : zeroAddress), // WETH/USDG 0.01%
};

export const DEFAULT_FEE = 10000; // 1% tier — the pool every coin graduates into

// Optional: the deployed Census indexer API. When set, the board/coin pages read from it (fast, scales)
// instead of scanning the chain in the browser. Empty => on-chain fallback.
export const INDEXER_URL = (import.meta.env.VITE_INDEXER_URL ?? "").replace(/\/$/, "");

// Starting FDV (in ETH terms) baked into a new coin's curve: the curve's virtual quote reserve V0 is this,
// converted to the anchor asset (see lib/anchors.ts curveLaunchParams).
export const START_FDV_ETH = 1.5;

// Trade fee, mirrored from CensusCurve.FEE_BPS for labels and estimates — the contract is the source of
// truth. How the fee is split is deliberately not surfaced in the UI.
export const TRADE_FEE_BPS = 200;
export const TRADE_FEE_LABEL = `${TRADE_FEE_BPS / 100}%`;

export const STANDARD = {
  decimals: 18,
  totalSupply: 1_000_000_000, // 1B, every coin
};
