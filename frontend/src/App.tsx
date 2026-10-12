import { Component, Suspense, lazy, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, Link } from "react-router-dom";
import { AppShell, Tape, CensusConnect, Icon, WalletPicker, PendingPanel } from "./census";
import { Landing } from "./pages/Landing"; // eager: the "/" splash is the first paint

// CX-S1: code-split the heavy inner pages so the initial load (splash → home) doesn't ship Coin/Launch/
// Advanced/Profile/Paper. Named exports, so map each to a default for React.lazy.
const Home = lazy(() => import("./pages/Home").then((m) => ({ default: m.Home })));
const Launch = lazy(() => import("./pages/Launch").then((m) => ({ default: m.Launch })));
const Coin = lazy(() => import("./pages/Coin").then((m) => ({ default: m.Coin })));
const Profile = lazy(() => import("./pages/Profile").then((m) => ({ default: m.Profile })));
const Paper = lazy(() => import("./pages/Paper").then((m) => ({ default: m.Paper })));
const Advanced = lazy(() => import("./pages/Advanced").then((m) => ({ default: m.Advanced })));

// A lazy chunk can fail to load on a flaky network; offer a reload rather than a blank screen.
class ChunkBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="cx-panel cx-empty">
        <div className="cx-empty__title">Couldn't load this page</div>
        <div className="cx-empty__body">A part of the app failed to download. Check your connection and reload.</div>
        <button className="cx-cta" style={{ marginTop: 26 }} onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}

function activeKey(path: string) {
  if (path.startsWith("/board")) return "market";
  if (path.startsWith("/paper")) return "paper";
  if (path.startsWith("/profile")) return "profile";
  if (path.startsWith("/home")) return "companies";
  return "";
}

// "Back" from a coin page returns to wherever the user came from (Companies, Market, Profile…); a coin
// opened from a shared link (no history in this tab) goes to the market.
function BackLink() {
  const nav = useNavigate();
  const loc = useLocation();
  const hasHistory = loc.key !== "default";
  return (
    <button className="cx-link-control" onClick={() => (hasHistory ? nav(-1) : nav("/board"))} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <Icon name="back" size={15} /> {hasHistory ? "Back" : "Back to the market"}
    </button>
  );
}

function TopBar({ path }: { path: string }) {
  const left = path.startsWith("/coin/") ? (
    <BackLink />
  ) : path.startsWith("/home") ? (
    <Tape />
  ) : (
    <Link className="cx-wordmark cx-mobile-only" to="/" style={{ fontSize: 18 }}>Delos</Link>
  );
  return <>{left}<CensusConnect /></>;
}

export function App() {
  const loc = useLocation();
  // The brand splash and the full-page launch wizard (/create, /create/<step>) render bare (no app chrome).
  const page = loc.pathname === "/" ? (
    <Landing />
  ) : loc.pathname === "/create" || loc.pathname.startsWith("/create/") ? (
    <Launch />
  ) : (
    <AppShell active={activeKey(loc.pathname)} topbar={<TopBar path={loc.pathname} />}>
      <Routes>
        <Route path="/home" element={<Home />} />
        <Route path="/paper" element={<Paper />} />
        <Route path="/board" element={<Advanced />} />
        <Route path="/coin/:address" element={<Coin />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/profile/:address" element={<Profile />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </AppShell>
  );
  // The wallet picker is one host for every "Connect wallet" in the app, including the bare pages.
  // Suspense covers the lazy inner pages (Landing is eager); the boundary handles a failed chunk fetch.
  return <><ChunkBoundary><Suspense fallback={<PendingPanel line="Loading…" />}>{page}</Suspense></ChunkBoundary><WalletPicker /></>;
}
