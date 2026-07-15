import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { CHAIN } from "./config";

export const wagmiConfig = createConfig({
  chains: [CHAIN],
  connectors: [injected()],
  transports: {
    [CHAIN.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
