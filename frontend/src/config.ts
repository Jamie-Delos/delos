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

// Census V4 contracts (from .env) plus the chain's Uniswap pieces. New launches run on the V4 stack:
// LaunchFactoryV4 -> CensusCurveV4 (curve trading) -> the canonical hooked Uniswap V4 pool, traded through
// CensusV4Router. The legacy V3-era addresses are optional and only light up old testnet coins.
export const CONTRACTS = {
  // --- V4 product (required for a release; see release-check.cjs) ---
  factoryV4: addr(import.meta.env.VITE_FACTORY_V4_ADDRESS), // LaunchFactoryV4 — every new launch (Prima and Maxima); CREATE2 deployer for the …c0de grind
  curveV4: addr(import.meta.env.VITE_CURVE_V4_ADDRESS), // CensusCurveV4 — the bonding-curve venue until graduation
  v4Router: addr(import.meta.env.VITE_V4_ROUTER), // CensusV4Router — post-graduation trades in the hooked pool
  v4Hook: addr(import.meta.env.VITE_V4_HOOK), // CensusV4Hook — charges the fee in the canonical pool (part of the PoolKey)
  poolManager: addr(import.meta.env.VITE_POOL_MANAGER), // Uniswap V4 PoolManager
  stateView: addr(import.meta.env.VITE_STATE_VIEW), // Uniswap V4 StateView — getSlot0(poolId) spot reads
  v4Quoter: addr(import.meta.env.VITE_V4_QUOTER), // Uniswap V4Quoter — impact-aware "you receive" for pool trades
  // --- legacy V3-era product (optional: old testnet coins only) ---
  factory: addr(import.meta.env.VITE_FACTORY_ADDRESS), // LaunchFactory — legacy Prima
  factoryV2: addr(import.meta.env.VITE_FACTORY_V2_ADDRESS), // LaunchFactoryV2 — legacy Maxima
  locker: addr(import.meta.env.VITE_LOCKER_ADDRESS), // LaunchLocker — legacy locked V3 positions
  curve: addr(import.meta.env.VITE_CURVE_ADDRESS), // CensusCurve — legacy curve (V3 graduation)
  quoter: addr(import.meta.env.VITE_QUOTER, zeroAddress), // Uniswap V3 QuoterV2 — legacy pool quotes only
  // Chain-gated like v3Factory/ethPricePool below (CX-H3): a non-mainnet build with these env vars unset
  // must NOT silently fall back to mainnet WETH/router. Off-mainnet it's zeroAddress (a loud failure)
  // until VITE_WETH/VITE_SWAP_ROUTER are set to that chain's addresses (see uniswap.<net>.json).
  weth: addr(import.meta.env.VITE_WETH, IS_MAINNET ? "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" : zeroAddress),
  swapRouter: addr(import.meta.env.VITE_SWAP_ROUTER, IS_MAINNET ? "0xCaf681a66D020601342297493863E78C959E5cb2" : zeroAddress), // SwapRouter02 (legacy V3 pools)
  v3Factory: addr(import.meta.env.VITE_V3_FACTORY, IS_MAINNET ? "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" : zeroAddress),
  ethPricePool: addr(import.meta.env.VITE_ETH_PRICE_POOL, IS_MAINNET ? "0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca" : zeroAddress), // WETH/USDG 0.01% (V3 — anchor USD pricing)
};

// Every coin graduates into the canonical hooked Uniswap V4 pool (fee 0, tickSpacing 60, hooks = the
// Census hook); the trade fee is charged by the hook, not by a Uniswap tier. release-check.cjs keys on this.
export const GRADUATION_VENUE = "v4" as const;
export const V4_POOL_FEE = 0;
export const V4_TICK_SPACING = 60;
// Legacy V3-era coins graduated into a 1% Uniswap V3 pool. Only used to READ those old pools (price);
// never presented as a fee and never a venue for new launches.
export const LEGACY_V3_POOL_FEE = 10000;

// Optional: the deployed Census indexer API. When set, the board/coin pages read from it (fast, scales)
// instead of scanning the chain in the browser. Empty => on-chain fallback.
export const INDEXER_URL = (import.meta.env.VITE_INDEXER_URL ?? "").replace(/\/$/, "");

// Initial virtual quote reserve V0 (in ETH terms) for a new coin's curve, converted to the anchor asset
// at launch (lib/anchors.ts curveLaunchParams). With the PF-style offset the starting FDV is a little
// below V0: V0·S/(S+X), about 1.39 ETH for the standard 4 ETH target. Name kept for history.
export const START_FDV_ETH = 1.5;

// Base trade fee, mirrored from CensusCurveV4.FEE_BPS (also the hook's base fee after graduation) for
// labels and estimates — the contract is the source of truth. A launch may add a holder reflection of
// 1-4% ON TOP (REFLECTION_OPTIONS), frozen at launch. The split is not surfaced to traders; creators see
// it spelled out in the launch wizard's fee tooltip (feeSplit below).
export const TRADE_FEE_BPS = 200;
export const TRADE_FEE_LABEL = `${TRADE_FEE_BPS / 100}%`;
export const REFLECTION_OPTIONS = [0, 100, 200, 300, 400] as const;
export const MAX_REWARD_BASKET = 3; // CensusRewardVault.MAX_BASKET

// Mainnet rehearsal build: a side deployment pointed at a throwaway contract stack, with a tiny graduation
// target so a full launch -> fill -> auto-graduation -> pool run costs cents. Production never sets
// VITE_REHEARSAL_GRADUATION_ETH, so the option (and the on-screen banner) cannot appear there.
export const REHEARSAL_GRADUATION_ETH = Number(import.meta.env.VITE_REHEARSAL_GRADUATION_ETH ?? 0) || 0;
export const REHEARSAL = REHEARSAL_GRADUATION_ETH > 0;
export const pctLabel = (bps: number) => `${+(bps / 100).toFixed(2)}%`;
// "Fee 3%" plus its breakdown ("2% base + 1% holder reflection") when a reflection applies.
export const feeBreakdown = (reflectionBps: number) =>
  reflectionBps > 0 ? `${TRADE_FEE_LABEL} base + ${pctLabel(reflectionBps)} holder reflection` : `${TRADE_FEE_LABEL} base`;

// How the base fee is shared between Census and the creator, mirrored from CensusCurveV4.CURVE_PROTOCOL_BPS
// (while on the curve) and the hook's split in CensusFeeMath.calculate (after graduation). The holder
// reflection is never split: all of it goes to holders through the launch's reward vault. Spelled out to
// creators in the launch wizard's fee tooltip (FeeSplitTip) — the contracts remain the source of truth.
export const CURVE_PROTOCOL_SHARE_BPS = 9000; // Census 90% / creator 10% while on the curve
export const POOL_PROTOCOL_SHARE_BPS = 3000; // Census 30% / creator 70% in the canonical pool
export type FeePhase = { phase: string; censusShare: number; census: number; creator: number }; // censusShare: bps of the base fee; census/creator: bps of the trade
const feePhase = (phase: string, censusShare: number): FeePhase => {
  const census = Math.round((TRADE_FEE_BPS * censusShare) / 10000);
  return { phase, censusShare, census, creator: TRADE_FEE_BPS - census };
};
export const feeSplit = (reflectionBps: number) => ({
  base: TRADE_FEE_BPS,
  reflection: reflectionBps,
  total: TRADE_FEE_BPS + reflectionBps,
  phases: [feePhase("While on the curve", CURVE_PROTOCOL_SHARE_BPS), feePhase("In the pool, after graduation", POOL_PROTOCOL_SHARE_BPS)],
});

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
