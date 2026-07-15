import { defineChain, type Address } from "viem";

// Chain + Uniswap addresses are env-driven so the same build points at Robinhood mainnet (default)
// or the testnet (our own Uniswap deploy) just by setting frontend/.env.
const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 4663);
const RPC_URL = import.meta.env.VITE_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const IS_TESTNET = CHAIN_ID === 46630;

// Robinhood Chain (Arbitrum Orbit L2, ETH gas). Not in viem/chains, so defined here.
export const CHAIN = defineChain({
  id: CHAIN_ID,
  name: IS_TESTNET ? "Robinhood Chain Testnet" : "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: IS_TESTNET ? "https://explorer.testnet.chain.robinhood.com" : "https://robinhoodchain.blockscout.com",
    },
  },
});

const zero = "0x0000000000000000000000000000000000000000" as Address;

export const CONTRACTS = {
  factory: (import.meta.env.VITE_FACTORY_ADDRESS ?? zero) as Address,
  locker: (import.meta.env.VITE_LOCKER_ADDRESS ?? zero) as Address,
  // Uniswap V3 — mainnet defaults (verified on-chain); override via .env for the testnet deploy.
  weth: (import.meta.env.VITE_WETH ?? "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73") as Address,
  swapRouter: (import.meta.env.VITE_SWAP_ROUTER ?? "0xCaf681a66D020601342297493863E78C959E5cb2") as Address,
};

export const DEFAULT_FEE = 10000; // 1% tier — the launch standard

// The protocol-fixed launch standard. Every token is identical; the creator only picks
// name / symbol / image. Calibrated so ~3.7 ETH of buys graduates the token (~$60k mcap band),
// leaving ~3.7 ETH of locked buy-side depth at graduation.
export const STANDARD = {
  decimals: 18,
  totalSupply: 1_000_000_000, // 1B
  fee: 10000, // 1%
  launchPriceWethPerToken: 1.2e-9, // ~1.2 ETH launch mcap
  graduationPriceWethPerToken: 2.0e-8, // ~20 ETH mcap, ~3.7 ETH bought to reach it
};
