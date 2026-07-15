import { useState } from "react";
import { Wallet } from "./components/Wallet";
import { LaunchForm } from "./components/LaunchForm";
import { TokenList } from "./components/TokenList";
import { CONTRACTS } from "./config";

export function App() {
  const [tab, setTab] = useState<"launch" | "explore">("launch");
  const [refreshKey, setRefreshKey] = useState(0);

  const notDeployed = CONTRACTS.factory === "0x0000000000000000000000000000000000000000";

  return (
    <div className="app">
      <header>
        <div className="brand">Launch<span>pad</span></div>
        <nav>
          <button className={tab === "launch" ? "tab on" : "tab"} onClick={() => setTab("launch")}>Launch</button>
          <button className={tab === "explore" ? "tab on" : "tab"} onClick={() => setTab("explore")}>Explore</button>
        </nav>
        <Wallet />
      </header>

      {notDeployed && (
        <div className="banner">
          Contracts not configured. Deploy with <code>contracts/scripts/deploy.js</code>, then set
          <code>VITE_FACTORY_ADDRESS</code> / <code>VITE_LOCKER_ADDRESS</code> in <code>frontend/.env</code>.
        </div>
      )}

      <main>
        {tab === "launch"
          ? <LaunchForm onLaunched={() => { setRefreshKey((k) => k + 1); setTab("explore"); }} />
          : <TokenList refreshKey={refreshKey} />}
      </main>

      <footer className="muted">
        Single-sided Uniswap V3 · price rises as people buy · liquidity locked forever · testnet
      </footer>
    </div>
  );
}
