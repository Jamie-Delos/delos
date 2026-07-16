import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAccount } from "wagmi";
import { COINS } from "../lib/mock";
import { usd, pct, short } from "../lib/format";

export function Profile() {
  const { address: param } = useParams();
  const { address: me } = useAccount();
  const addr = param || me || "0xbullrunner000000000000000000000000000000";
  const [tab, setTab] = useState<"created" | "held" | "replies">("created");

  const created = COINS.slice(0, 3);
  const held = COINS.slice(2, 6);

  return (
    <>
      <div className="row" style={{ alignItems: "flex-start", gap: 14 }}>
        <div className="coin-tile" style={{ background: "#4a8f6b" }}>🐮</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 21, fontWeight: 700 }}>bullrunner</div>
          <div className="mono dim" style={{ fontSize: 13, marginTop: 4 }}>{short(addr)}</div>
          <div className="dim" style={{ fontSize: 12.5, marginTop: 4 }}>joined 2d ago · on Robinhood Chain</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn2">edit</button>
          <button className="btn2">share</button>
        </div>
      </div>

      <div className="stats">
        <div className="stat"><div className="k">coins created</div><div className="v">3</div></div>
        <div className="stat"><div className="k">wallet balance</div><div className="v">1.84 ETH</div></div>
        <div className="stat"><div className="k">fees earned</div><div className="v accent">0.21 ETH</div></div>
        <div className="stat"><div className="k">best coin</div><div className="v">Bullko</div></div>
      </div>

      <div className="tabs">
        <button className={tab === "created" ? "on" : ""} onClick={() => setTab("created")}>created</button>
        <button className={tab === "held" ? "on" : ""} onClick={() => setTab("held")}>held</button>
        <button className={tab === "replies" ? "on" : ""} onClick={() => setTab("replies")}>replies</button>
      </div>

      <div className="coin-list">
        {tab === "created" && created.map((c) => (
          <Link key={c.address} to={`/coin/${c.address}`} className="coin-row">
            <div className="coin-tile" style={{ width: 56, height: 56, fontSize: 26, background: "#c9436b" }}>{c.emoji}</div>
            <div style={{ flex: 1 }}><div style={{ fontWeight: 700 }}>{c.name}</div><div className="dim" style={{ fontSize: 12.5, marginTop: 3 }}>{usd(c.mcap)} · {c.age}</div></div>
            <div className="accent" style={{ fontSize: 13 }}>fees 0.0{c.replies % 9} ETH</div>
          </Link>
        ))}
        {tab === "held" && held.map((c) => (
          <Link key={c.address} to={`/coin/${c.address}`} className="coin-row">
            <div className="coin-tile" style={{ width: 44, height: 44, fontSize: 22, background: "#7a5cc0" }}>{c.emoji}</div>
            <div style={{ flex: 1 }}><div style={{ fontWeight: 700 }}>{c.name}</div><div className="dim" style={{ fontSize: 12.5, marginTop: 3 }}>{(c.mcap / 5000).toFixed(0)}K {c.symbol}</div></div>
            <div style={{ textAlign: "right" }}><div>{usd(c.mcap / 90)}</div><div style={{ fontSize: 12, color: c.change24 >= 0 ? "var(--pos)" : "var(--neg)" }}>{pct(c.change24)}</div></div>
          </Link>
        ))}
        {tab === "replies" && (
          <div className="card"><div className="dim" style={{ fontSize: 12.5, marginBottom: 6 }}>on <Link className="accent" to={`/coin/${COINS[0].address}`}>Bullko</Link> · 38m</div><div className="muted" style={{ fontSize: 13 }}>liquidity locked forever ser. wagmi 🐮</div></div>
        )}
      </div>
    </>
  );
}
