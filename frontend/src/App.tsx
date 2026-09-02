import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { CONTRACTS } from "./config";
import { short } from "./lib/format";
import { IcHome, IcToken, IcAdvanced, IcProfile, IcMore, IcSearch, IcPlus } from "./components/icons";
import { Home } from "./pages/Home";
import { Launch } from "./pages/Launch";
import { Coin } from "./pages/Coin";
import { Profile } from "./pages/Profile";
import { Token } from "./pages/Token";
import { Advanced } from "./pages/Advanced";

function Wordmark() {
  return (
    <div className="wordmark">
      <span className="wm-mark"><i /></span>
      <span className="wm-text">robinpad</span>
    </div>
  );
}

function ConnectBtn({ mini }: { mini?: boolean }) {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const nav = useNavigate();
  if (!isConnected) {
    return <button className="btn2" onClick={() => connect({ connector: connectors[0] })}>log in</button>;
  }
  return (
    <button className="btn2" onClick={() => (mini ? disconnect() : nav("/profile"))} title="profile / disconnect">
      <span className="mono">{short(address)}</span>
    </button>
  );
}

export function App() {
  const notDeployed = CONTRACTS.factory === "0x0000000000000000000000000000000000000000";
  return (
    <div className="app">
      {/* desktop sidebar */}
      <aside className="sidebar">
        <Wordmark />
        <NavLink to="/" end className={({ isActive }) => "side-link" + (isActive ? " active" : "")}><IcHome /><span>home</span></NavLink>
        <NavLink to="/board" className={({ isActive }) => "side-link" + (isActive ? " active" : "")}><IcAdvanced /><span>board</span></NavLink>
        <NavLink to="/token" className={({ isActive }) => "side-link" + (isActive ? " active" : "")}><IcToken /><span>token</span><span className="soon">soon</span></NavLink>
        <NavLink to="/profile" className={({ isActive }) => "side-link" + (isActive ? " active" : "")}><IcProfile /><span>profile</span></NavLink>
        <span className="side-link disabled"><IcMore /><span>more</span></span>
        <NavLink to="/create" className="side-cta">create coin</NavLink>
        <div style={{ marginTop: "auto", paddingTop: 16 }}><ConnectBtn /></div>
      </aside>

      <div className="main">
        {/* mobile top bar */}
        <div className="topbar">
          <Wordmark />
          <div style={{ marginLeft: "auto" }}><ConnectBtn /></div>
        </div>

        <div className="content">
          {notDeployed && (
            <div className="banner">
              dev: contracts not set — launches/trades are placeholder. deploy then set <code>VITE_FACTORY_ADDRESS</code> / <code>VITE_LOCKER_ADDRESS</code>.
            </div>
          )}
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/token" element={<Token />} />
            <Route path="/board" element={<Advanced />} />
            <Route path="/create" element={<Launch />} />
            <Route path="/coin/:address" element={<Coin />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/profile/:address" element={<Profile />} />
          </Routes>
        </div>

        {/* mobile bottom tab bar */}
        <nav className="bottomnav">
          <NavLink to="/" end className={({ isActive }) => "tab" + (isActive ? " active" : "")}><IcHome /><span>home</span></NavLink>
          <NavLink to="/" className="tab"><IcSearch /><span>search</span></NavLink>
          <NavLink to="/create" className="tab"><span className="tab-center"><IcPlus /></span><span>create</span></NavLink>
          <NavLink to="/profile" className={({ isActive }) => "tab" + (isActive ? " active" : "")}><IcProfile /><span>profile</span></NavLink>
        </nav>
      </div>
    </div>
  );
}
