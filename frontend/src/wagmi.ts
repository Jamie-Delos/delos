import { createConfig, http, type CreateConnectorFn } from "wagmi";
import { injected } from "wagmi/connectors";
import { CHAIN } from "./config";

// Wallets: every installed extension announces itself via EIP-6963 (wagmi's multi-provider discovery is
// on by default), and the generic `injected()` covers whatever owns window.ethereum. The explicit
// MetaMask and Phantom targets make those two detectable even where an in-app browser doesn't announce
// (Phantom's provider lives at window.phantom.ethereum). useWalletConnect dedupes by provider object, so
// a wallet found both ways is listed once.
// Typed as a plain array so the registered config type also fits the Privy config (privy.tsx), whose
// connectors are driven by Privy rather than listed here.
const connectors: CreateConnectorFn[] = [injected(), injected({ target: "metaMask" }), injected({ target: "phantom" })];

export const wagmiConfig = createConfig({
  chains: [CHAIN],
  connectors,
  transports: {
    [CHAIN.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
