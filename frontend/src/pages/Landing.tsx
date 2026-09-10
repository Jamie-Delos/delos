import { useNavigate } from "react-router-dom";
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

// Brand-first splash from the designer handoff (Fullweb2). Chrome wordmark asset, the Companies↔Memes
// flip, one lime CTA into the app.
export function Landing() {
  const nav = useNavigate();
  return (
    <div className="census-landing census-body census-body--landing">
      <nav className="census-landing__nav">
        <button onClick={() => nav("/")} style={{ fontFamily: "var(--census-font-serif)", fontWeight: 600, fontSize: 20, color: "var(--census-silver)", background: "none", border: 0, cursor: "pointer", padding: 0 }}>census.fund</button>
        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 15 }}>
          {([["Market", "/board"], ["Companies", "/home"], ["Census Paper", "/paper"]] as const).map(([label, to], i, all) => (
            <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 14 }}>
              <a href={`#${to}`} style={{ color: "var(--census-text-secondary)" }}>{label}</a>
              {i < all.length - 1 && <span style={{ color: "var(--census-text-muted)", fontSize: 11 }}>·</span>}
            </span>
          ))}
        </div>
        {/* Grid cell is 1fr and grid items default to justify-self:stretch — without this the bordered
            connect button balloons to fill the whole column. Pin it to the right at content width. */}
        <div style={{ justifySelf: "end" }}><CensusConnect /></div>
      </nav>

      <main className="census-landing__hero">
        <img className="census-wordmark census-rise" src="/census-logo.svg" alt="Census" />
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
      </main>

      <footer className="census-landing__footer">
        <span className="census-mono">Crack the <span className="census-dot">c0de</span>.</span>
      </footer>
    </div>
  );
}
