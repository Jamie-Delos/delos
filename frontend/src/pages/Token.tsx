import { usd } from "../lib/format";

// Placeholder ecosystem-token page. $ROBIN is the launchpad's own coin: every graduated coin routes
// 20% of its trading fees into buying and burning $ROBIN. Numbers are mock until the indexer lands.
const BURNS = [
  { amt: "12,400", from: "BULLKO", age: "2h" },
  { amt: "8,910", from: "BASEDD", age: "5h" },
  { amt: "31,200", from: "rasmr", age: "9h" },
  { amt: "4,050", from: "GIGA", age: "14h" },
  { amt: "19,880", from: "MONITOR", age: "1d" },
];

export function Token() {
  return (
    <>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <span className="wm-mark" style={{ width: 44, height: 44 }}><i style={{ width: 18, height: 18 }} /></span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>robinpad <span className="dim" style={{ fontWeight: 400, fontSize: 15 }}>$ROBIN</span></div>
          <div className="muted" style={{ fontSize: 13, marginTop: 6, maxWidth: 560 }}>
            the launchpad's coin. every coin that graduates routes 20% of its trading fees into buying and burning $ROBIN — forever.
          </div>
        </div>
        <button className="cta" style={{ width: "auto" }}>buy $ROBIN</button>
      </div>

      <div className="stats">
        <div className="stat"><div className="k">price</div><div className="v">$0.0042</div></div>
        <div className="stat"><div className="k">market cap</div><div className="v accent">{usd(4_200_000)}</div></div>
        <div className="stat"><div className="k">holders</div><div className="v">1,204</div></div>
        <div className="stat"><div className="k">total burned 🔥</div><div className="v" style={{ color: "var(--gold)" }}>8.3M</div></div>
      </div>

      <div className="section-head" style={{ marginTop: 8 }}><span className="h2">the flywheel</span></div>
      <div className="flow">
        <div className="flow-step"><div className="n">1 · trade</div><div>every buy/sell on a graduated coin pays a 1% fee</div></div>
        <span className="flow-arrow">→</span>
        <div className="flow-step"><div className="n">2 · buyback</div><div>20% of that fee auto-buys $ROBIN on the open market</div></div>
        <span className="flow-arrow">→</span>
        <div className="flow-step"><div className="n">3 · burn</div><div>the $ROBIN is sent to the dead address — supply only shrinks</div></div>
      </div>

      <div className="fees" style={{ marginTop: 16 }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
          <span>supply burned</span><span className="accent" style={{ fontWeight: 700 }}>8.3M / 1.00B (0.83%)</span>
        </div>
        <div className="gradtrack"><div className="gradfill" style={{ width: "8%", background: "var(--gold)" }} /></div>
        <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>fees recycled this week: <b className="accent">4.19 ETH</b> · treasury awaiting buyback: <b className="accent">0.42 ETH</b></div>
      </div>

      <div className="section-head" style={{ marginTop: 22 }}><span className="h2">protocol</span></div>
      <div className="stats">
        <div className="stat"><div className="k">tvl (locked liquidity)</div><div className="v accent">{usd(5_240_000)}</div></div>
        <div className="stat"><div className="k">24h volume</div><div className="v">{usd(930_000)}</div></div>
        <div className="stat"><div className="k">coins launched</div><div className="v">3,182</div></div>
        <div className="stat"><div className="k">fees → burned (all time)</div><div className="v" style={{ color: "var(--gold)" }}>61.7 ETH</div></div>
      </div>

      <div className="section-head" style={{ marginTop: 22 }}><span className="h2">recent burns 🔥</span></div>
      <div className="card" style={{ padding: 0 }}>
        {BURNS.map((b, i) => (
          <div key={i} className="row" style={{ justifyContent: "space-between", padding: "12px 14px", borderBottom: i < BURNS.length - 1 ? "1px solid var(--border-subtle)" : "none" }}>
            <span>burned <b style={{ color: "var(--gold)" }}>{b.amt} $ROBIN</b></span>
            <span className="dim" style={{ fontSize: 12.5 }}>from ${b.from} fees · {b.age}</span>
          </div>
        ))}
      </div>
    </>
  );
}
