import { useState } from "react";

// Clean coin / company avatar for the designer package: the coin's real image when it has one,
// otherwise a serif lettermark on the chrome tile — the same treatment as the launch wizard's preview.
// Replaces the emoji-on-random-colour tiles left over from the quick-and-dirty v1.
export function CoinAvatar({
  name, symbol, image, size = 48, radius = "var(--census-radius-card)",
}: { name?: string; symbol?: string; image?: string; size?: number; radius?: number | string }) {
  const [failed, setFailed] = useState(false);
  const src = image && image.trim();
  const box = { width: size, height: size, borderRadius: radius, flex: "none" as const };
  if (src && !failed) {
    return (
      <img
        style={{ ...box, objectFit: "cover", background: "var(--census-chrome-tile)" }}
        src={src}
        alt={name || symbol || ""}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  const letter = ((name || symbol || "C").trim()[0] || "C").toUpperCase();
  return (
    <div style={{ ...box, display: "grid", placeItems: "center", background: "var(--census-chrome-tile)", color: "#0c130f", fontFamily: "var(--census-font-serif)", fontWeight: 600, fontSize: Math.round(size * 0.44), lineHeight: 1 }}>
      {letter}
    </div>
  );
}
