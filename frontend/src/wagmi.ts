import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { CHAIN } from "./config";

// Wallets: every installed extension announces itself via EIP-6963 (wagmi's multi-provider discovery is
// on by default), and the generic `injected()` covers whatever owns window.ethereum. The explicit
// MetaMask and Phantom targets make those two detectable even where an in-app browser doesn't announce
// (Phantom's provider lives at window.phantom.ethereum). useWalletConnect dedupes by provider object, so
// a wallet found both ways is listed once.
export const wagmiConfig = createConfig({
  chains: [CHAIN],
  connectors: [injected(), injected({ target: "metaMask" }), injected({ target: "phantom" })],
  transports: {
    [CHAIN.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
