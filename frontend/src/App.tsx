import { Navigate, Route, Routes, useLocation, Link } from "react-router-dom";
import { AppShell, Tape, CensusConnect, Icon } from "./census";
import { Home } from "./pages/Home";
import { Launch } from "./pages/Launch";
import { Coin } from "./pages/Coin";
import { Profile } from "./pages/Profile";
import { Paper } from "./pages/Paper";
import { Advanced } from "./pages/Advanced";
import { Landing } from "./pages/Landing";

function activeKey(path: string) {
  if (path.startsWith("/board")) return "market";
  if (path.startsWith("/paper")) return "paper";
  if (path.startsWith("/profile")) return "profile";
  if (path.startsWith("/home")) return "companies";
  return "";
}

function TopBar({ path }: { path: string }) {
  const left = path.startsWith("/coin/") ? (
    <Link to="/board" className="cx-link-control" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <Icon name="back" size={15} /> Back to the board
    </Link>
  ) : path.startsWith("/home") ? (
    <Tape />
  ) : (
    <Link className="cx-wordmark cx-mobile-only" to="/home" style={{ fontSize: 18 }}>census.fund</Link>
  );
  return <>{left}<CensusConnect /></>;
}

export function App() {
  const loc = useLocation();
  // Designer's brand splash and the full-page launch wizard render bare (no app chrome).
  if (loc.pathname === "/") return <Landing />;
  if (loc.pathname === "/create") return <Launch />;
  return (
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
}
