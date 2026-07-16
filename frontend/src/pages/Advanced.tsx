import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { COINS, type Coin } from "../lib/mock";
import { usd, price as fmtPrice, pct } from "../lib/format";

// Full board — every coin, sortable. Placeholder rows (mock catalogue) until the indexer lands.
type Key = "mcap" | "price" | "change24" | "replies" | "grad";
const grad = (c: Coin) => (c.mcap % 100); // mock graduation %

export function Advanced() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Key>("mcap");
  const [dir, setDir] = useState<-1 | 1>(-1);
  const [trendOnly, setTrendOnly] = useState(false);

  // Duplicate the mock set so the board looks fuller.
  const base = useMemo(() => [...COINS, ...COINS.map((c, i) => ({ ...c, address: c.address + "b", name: c.name + " ii", mcap: Math.round(c.mcap * (0.3 + (i % 5) * 0.2)) }))], []);

  const rows = useMemo(() => {
    let r = base.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()) || c.symbol.toLowerCase().includes(q.toLowerCase()));
    if (trendOnly) r = r.filter((c) => c.trending);
    const val = (c: Coin) => (sort === "grad" ? grad(c) : (c[sort] as number));
    return [...r].sort((a, b) => (val(a) - val(b)) * dir);
  }, [base, q, sort, dir, trendOnly]);

  function th(key: Key, label: string, num = true) {
    const on = sort === key;
    return (
      <th className={num ? "num" : ""} onClick={() => { if (on) setDir((d) => (d === 1 ? -1 : 1)); else { setSort(key); setDir(-1); } }}>
        {label}{on ? (dir === -1 ? " ↓" : " ↑") : ""}
      </th>
    );
  }

  return (
    <>
      <div className="h1">advanced</div>
      <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>the full board. sortable. degen mode.</div>

      <div className="controls">
        <input className="input" placeholder="filter by name or ticker" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" value={sort} onChange={(e) => setSort(e.target.value as Key)}>
          <option value="mcap">sort: market cap</option>
          <option value="change24">sort: 24h</option>
          <option value="grad">sort: graduation</option>
          <option value="replies">sort: replies</option>
        </select>
        <button className={trendOnly ? "cta" : "btn2"} style={{ width: "auto" }} onClick={() => setTrendOnly((v) => !v)}>trending only</button>
      </div>

      <div className="board-wrap">
        <table className="board">
          <thead>
            <tr>
              <th style={{ cursor: "default" }}>coin</th>
              {th("mcap", "mcap")}
              {th("price", "price")}
              {th("change24", "24h")}
              {th("grad", "graduation")}
              {th("replies", "replies")}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.address} onClick={() => nav(`/coin/${c.address.replace(/b$/, "")}`)}>
                <td>
                  <div className="cc"><span className="em">{c.emoji}</span><div><div style={{ fontWeight: 600 }}>{c.name}</div><div className="dim" style={{ fontSize: 11.5 }}>${c.symbol}</div></div></div>
                </td>
                <td className="num accent" style={{ fontWeight: 600 }}>{usd(c.mcap)}</td>
                <td className="num mono">{fmtPrice(c.price)}</td>
                <td className="num" style={{ color: c.change24 >= 0 ? "var(--pos)" : "var(--neg)" }}>{pct(c.change24)}</td>
                <td className="num"><span className="minibar"><i style={{ width: grad(c) + "%" }} /></span> <span className="dim">{grad(c)}%</span></td>
                <td className="num dim">{c.replies}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
