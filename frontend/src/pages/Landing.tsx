import { Link, useNavigate } from "react-router-dom";
import { CensusConnect } from "../census";

// "Companies" flips to "Memes" every 3s (6s cycle), reduced-motion safe — all in census.css.
function FlipWord({ front = "Companies", back = "Memes" }) {
  return (
    <span className="census-flip">
      <span className="census-flip__inner">
        <span className="census-flip__front">{front}</span>
        <span className="census-flip__back" aria-hidden="true">{back}</span>
      </span>
    </span>
  );
}

// Same order and labels as the app's sidebar, so the two navs read as one.
const NAV = [["Companies", "/home"], ["Market", "/board"], ["Protocol", "/paper"]] as const;

// Brand-first splash from the designer handoff. Chrome wordmark asset, the Companies↔Memes flip, one
// lime CTA into the app.
export function Landing() {
  const nav = useNavigate();
  return (
    <div className="census-landing census-body census-body--landing">
      <nav className="census-landing__nav">
        <span style={{ fontFamily: "var(--census-font-serif)", fontWeight: 600, fontSize: 20, color: "var(--census-silver)" }}>Delos</span>
        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 15 }}>
          {NAV.map(([label, to], i) => (
            <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 14 }}>
              <Link to={to} style={{ color: "var(--census-text-secondary)" }}>{label}</Link>
              {i < NAV.length - 1 && <span style={{ color: "var(--census-text-muted)", fontSize: 11 }}>·</span>}
            </span>
          ))}
        </div>
        {/* Grid cell is 1fr and grid items default to justify-self:stretch — without this the bordered
            connect button balloons to fill the whole column. Pin it to the right at content width. */}
        <div style={{ justifySelf: "end" }}><CensusConnect /></div>
      </nav>

      <main className="census-landing__hero">
        <span className="delos-wordmark census-rise">Delos<span className="census-dot">.</span></span>
        <h1 className="census-landing__h1 census-rise" style={{ animationDelay: "0.25s" }}>
          <FlipWord /> become <span className="census-dot">markets.</span>
        </h1>
        <p className="census-landing__sub census-rise" style={{ animationDelay: "0.38s" }}>
          An early public market for ambitious internet companies.
        </p>
        <button
          className="census-cta census-rise"
          style={{ marginTop: "clamp(26px,4.5vh,44px)", animationDelay: "0.5s" }}
          onClick={() => nav("/home")}
        >
          Enter the market <span className="census-cta__arrow" aria-hidden="true">→</span>
        </button>
        <Link className="delos-test-button census-rise" to="/create" style={{ animationDelay: "0.6s" }}>TEST LAUNCH · FROM 0.05 ETH</Link>
        <span className="delos-test-note">Team test target. Mainnet launches and trades use real funds.</span>
      </main>

      <footer className="census-landing__footer">
        <span className="census-mono">Delos team test · graduation from 0.05 ETH</span>
      </footer>
    </div>
  );
}
