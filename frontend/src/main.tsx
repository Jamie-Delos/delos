import React, { type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "./wagmi";
import { PRIVY_ENABLED } from "./config";
import { WalletsAuthProvider } from "./census";
import { App } from "./App";
import "./styles/base.css";
import "./styles/census-tokens.css";
import "./styles/census.css";
import "./styles/census-app.css";

const queryClient = new QueryClient();
const root = ReactDOM.createRoot(document.getElementById("root")!);

// Default: wallets only (EIP-6963 picker). With a Privy App ID set, Privy adds "Sign up" and runs
// "Connect wallet" through its modal; its SDK is a separate chunk fetched only in that case.
const WalletsOnlyTree = () => (
  <WagmiProvider config={wagmiConfig}>
    <QueryClientProvider client={queryClient}>
      <WalletsAuthProvider>
        <HashRouter>
          <App />
        </HashRouter>
      </WalletsAuthProvider>
    </QueryClientProvider>
  </WagmiProvider>
);

// Privy throws while mounting on a misconfiguration (bad App ID, non-HTTPS origin). Never let that blank
// the site: fall back to wallet-only connect and say why in the console.
class PrivyFallback extends React.Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { console.error("Privy failed to start; falling back to wallet-only connect", e); }
  render() { return this.state.failed ? <WalletsOnlyTree /> : this.props.children; }
}

if (PRIVY_ENABLED) {
  import("./privy")
    .then(({ PrivyRoot }) =>
      root.render(
        <React.StrictMode>
          <PrivyFallback>
            <PrivyRoot queryClient={queryClient}>
              <HashRouter>
                <App />
              </HashRouter>
            </PrivyRoot>
          </PrivyFallback>
        </React.StrictMode>,
      ),
    )
    .catch((e) => {
      console.error("Privy failed to load; falling back to wallet-only connect", e);
      root.render(<React.StrictMode><WalletsOnlyTree /></React.StrictMode>);
    });
} else {
  root.render(<React.StrictMode><WalletsOnlyTree /></React.StrictMode>);
}
