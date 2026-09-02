// $ROBIN ecosystem page — not live yet. Placeholder "coming soon" with a teaser of the flywheel.
export function Token() {
  return (
    <div style={{ maxWidth: 560, margin: "56px auto 0", textAlign: "center" }}>
      <span className="wm-mark" style={{ width: 56, height: 56, margin: "0 auto" }}><i style={{ width: 22, height: 22 }} /></span>
      <div className="tier-tag" style={{ marginTop: 18 }}>COMING SOON</div>
      <h1 style={{ margin: "6px 0" }}>$ROBIN</h1>
      <p className="muted" style={{ maxWidth: 440, margin: "10px auto 22px", fontSize: 14 }}>
        the launchpad's own coin. every coin that graduates routes a slice of its fees into buying and
        burning $ROBIN — a flywheel that rewards the whole board. not live yet.
      </p>
      <div className="flow" style={{ maxWidth: 520, margin: "0 auto", textAlign: "left" }}>
        <div className="flow-step"><div className="n">1 · trade</div><div>every graduated coin pays a 1% fee</div></div>
        <span className="flow-arrow">→</span>
        <div className="flow-step"><div className="n">2 · buyback</div><div>a slice auto-buys $ROBIN</div></div>
        <span className="flow-arrow">→</span>
        <div className="flow-step"><div className="n">3 · burn</div><div>supply only shrinks</div></div>
      </div>
    </div>
  );
}
