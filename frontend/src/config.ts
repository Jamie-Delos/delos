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
  // Uniswap V3 QuoterV2 — gives a real, price-impact-aware output for a direct-pool trade so the trade
  // estimate + minimum-out aren't derived from an impact-free spot (which reverts normal trades on a
  // shallow pool). No default: the Robinhood Chain QuoterV2 must be verified on-chain and set here via
  // VITE_QUOTER (mainnet gate). Until set, the pool path falls back to the estimate + user slippage.
  quoter: addr(import.meta.env.VITE_QUOTER, zeroAddress),
};

export const DEFAULT_FEE = 10000; // 1% tier — the pool every coin graduates into

// Optional: the deployed Census indexer API. When set, the board/coin pages read from it (fast, scales)
// instead of scanning the chain in the browser. Empty => on-chain fallback.
export const INDEXER_URL = (import.meta.env.VITE_INDEXER_URL ?? "").replace(/\/$/, "");

// Initial virtual quote reserve V0 (in ETH terms) for a new coin's curve, converted to the anchor asset
// at launch (lib/anchors.ts curveLaunchParams). With the PF-style offset the starting FDV is a little
// below V0: V0·S/(S+X), about 1.39 ETH for the standard 4 ETH target. Name kept for history.
export const START_FDV_ETH = 1.5;

// Trade fee, mirrored from CensusCurve.FEE_BPS for labels and estimates — the contract is the source of
// truth. How the fee is split is deliberately not surfaced in the UI.
export const TRADE_FEE_BPS = 200;
export const TRADE_FEE_LABEL = `${TRADE_FEE_BPS / 100}%`;

// Privy: email/social sign-up with an embedded wallet, next to "Connect wallet". Unset App ID => wallets
// only, and the Privy SDK is never loaded. The login methods must match what's enabled in the Privy
// dashboard. A Client ID selects a per-environment app client (e.g. one that allows localhost).
export const PRIVY_APP_ID = (import.meta.env.VITE_PRIVY_APP_ID ?? "").trim();
export const PRIVY_CLIENT_ID = (import.meta.env.VITE_PRIVY_CLIENT_ID ?? "").trim() || undefined;
// Privy App IDs are exactly 25 characters; anything else would crash its provider, so treat it as unset.
export const PRIVY_ENABLED = PRIVY_APP_ID.length === 25;
if (PRIVY_APP_ID && !PRIVY_ENABLED) console.warn("VITE_PRIVY_APP_ID is set but is not a 25-character Privy App ID; sign-up stays off.");
export const PRIVY_LOGIN_METHODS = (import.meta.env.VITE_PRIVY_LOGIN_METHODS ?? "email")
  .split(",").map((s) => s.trim()).filter(Boolean);

export const STANDARD = {
  decimals: 18,
  totalSupply: 1_000_000_000, // 1B, every coin
};
