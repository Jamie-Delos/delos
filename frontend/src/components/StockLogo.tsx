import { useState } from "react";

// Deterministic pleasant colour from a label, for the fallback badge.
function hue(t: string) {
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) % 360;
  return h;
}

// A real asset image (token / stock / company logo) on a clean rounded tile, with a coloured
// initials badge fallback when the image is missing or 404s. Used for anchors (ETH, HOOD) and the
// tokenised-stock dividend basket so the anchors flow shows real logos, not letter tiles.
export function AssetLogo({
  src, label, size = 30, radius = "var(--census-radius-tile)",
}: { src?: string; label: string; size?: number; radius?: number | string }) {
  const [failed, setFailed] = useState(false);
  const base = { width: size, height: size, borderRadius: radius, flex: "none" as const };
  if (failed || !src) {
    return (
      <span style={{ ...base, display: "grid", placeItems: "center", fontWeight: 700, fontSize: Math.max(9, size * 0.34), color: "#0c130f", background: `hsl(${hue(label)} 55% 58%)` }}>
        {label.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return (
    <img
      style={{ ...base, objectFit: "contain", background: "#fff", padding: Math.round(size * 0.1), boxSizing: "border-box" }}
      src={src}
      alt={label}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

// Public company/stock logo by ticker; falls back to the coloured badge if it 404s.
export function StockLogo({ ticker, size = 26 }: { ticker: string; size?: number }) {
  return <AssetLogo src={`https://financialmodelingprep.com/image-stock/${ticker}.png`} label={ticker} size={size} />;
}
