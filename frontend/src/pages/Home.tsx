import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { COINS, makeEvent, type Coin } from "../lib/mock";
import { usd } from "../lib/format";
import { IcSearch } from "../components/icons";

function Tape() {
  const [items, setItems] = useState(() => [0, 1, 2, 3].map(makeEvent));
  const n = useRef(4);
  useEffect(() => {
    const t = setInterval(() => {
      setItems((prev) => [makeEvent(n.current++), ...prev].slice(0, 6));
    }, 2100);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="tape">
      {items.map((e) => (
        <span key={e.id} className={"chip " + e.kind}>
          <span className="dot" style={{ background: "currentColor" }} />
          {e.text}<span className="mc">mcap {e.mc}</span>
        </span>
      ))}
    </div>
  );
}

function CoinTile({ c, size }: { c: Coin; size: number }) {
  const bg = ["#c9436b", "#3a3f4b", "#e2b04a", "#4a8f6b", "#7a5cc0", "#c07a3a"][c.name.length % 6];
  return <div className="coin-tile" style={{ width: size, height: size, fontSize: size * 0.45, background: bg }}>{c.emoji}</div>;
}

export function Home() {
  const trending = COINS.filter((c) => c.trending);
  return (
    <>
      <Tape />
      <div className="h1" style={{ textAlign: "center", margin: "18px 0" }}>[ start a new coin ]</div>
      <div className="searchwrap">
        <input className="input" placeholder="search for token" />
        <button className="search-btn"><IcSearch /></button>
      </div>

      <div className="section-head"><span className="dot" style={{ background: "var(--accent)" }} /><span className="h2">now trending</span></div>
      <div className="trending">
        {trending.map((c) => (
          <Link key={c.address} to={`/coin/${c.address}`} className={"tcard" + (c.koth ? " koth" : "")}>
            <div className="row" style={{ marginBottom: 10 }}>
              <CoinTile c={c} size={48} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{c.name}</div>
                <div className="dim" style={{ fontSize: 12 }}>${c.symbol}</div>
              </div>
            </div>
            <div className="accent" style={{ fontWeight: 700 }}>{usd(c.mcap)} <span className="dim" style={{ fontWeight: 400 }}>· {c.replies} replies</span></div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>{c.desc}</div>
          </Link>
        ))}
      </div>

      <div className="section-head" style={{ marginTop: 22 }}><span className="h2">all coins</span></div>
      <div className="coin-list">
        {COINS.map((c) => (
          <Link key={c.address} to={`/coin/${c.address}`} className="coin-row">
            <CoinTile c={c} size={72} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="dim" style={{ fontSize: 12, marginBottom: 3 }}>by {c.creator} · {c.age}</div>
              <div style={{ fontWeight: 700 }}>{c.name} <span className="dim" style={{ fontWeight: 400, fontSize: 13 }}>${c.symbol}</span></div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>{c.desc}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="accent" style={{ fontWeight: 700 }}>{usd(c.mcap)}</div>
              <div className="dim" style={{ fontSize: 12 }}>{c.replies} replies</div>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
