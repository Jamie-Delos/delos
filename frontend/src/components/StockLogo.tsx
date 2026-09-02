import { useState } from "react";

// Deterministic pleasant colour from a ticker, for the fallback badge.
function hue(t: string) {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 360;
  return h;
}

export function StockLogo({ ticker, size = 26 }: { ticker: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="tkr-badge" style={{ width: size, height: size, fontSize: size * 0.36, background: `hsl(${hue(ticker)} 55% 42%)` }}>
        {ticker.slice(0, 2)}
      </span>
    );
  }
  // Public stock-logo image; falls back to the colored badge if it 404s.
  return (
    <img
      className="tkr-logo"
      style={{ width: size, height: size }}
      src={`https://financialmodelingprep.com/image-stock/${ticker}.png`}
      alt={ticker}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
