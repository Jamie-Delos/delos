import { useMemo, useState } from "react";
import { useLaunches } from "../lib/useLaunches";
import { useCurveStats } from "../lib/useCurveStats";
import { BoardRow, PendingPanel, EmptyPanel, NoMatchPanel, Icon, type DisplayCoin } from "../census";

// The Market: every company, sortable. Market cap, price and graduation are live from the curve; 24h and
// replies wait on the indexer, so their columns show "—" and are not sortable.
export function Advanced() {
  const { coins, loading } = useLaunches();
  const stats = useCurveStats(coins.map((c) => c.address));
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("marketCap");

  const list: DisplayCoin[] = useMemo(() => coins.map((c) => {
    const s = stats[c.address.toLowerCase()];
    return {
      address: c.address, name: c.name, symbol: c.symbol, anchor: s?.anchor ?? "ETH",
      marketCap: s?.mcapUsd ?? null, price: s?.priceUsd ?? null,
      graduation: s?.gradPct ?? 0, graduated: s?.graduated, reserve: s?.reserve ?? 0, graduationTarget: s?.graduationTarget,
    };
  }), [coins, stats]);

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    const r = list.filter((c) => c.name.toLowerCase().includes(query) || c.symbol.toLowerCase().includes(query));
    const val = (c: DisplayCoin) => (sort === "graduation" ? c.graduation : sort === "price" ? c.price : c.marketCap) ?? -1;
    return [...r].sort((a, b) => val(b) - val(a));
  }, [list, q, sort]);

  return (
    <>
      <div className="cx-pagehead">
        <h1 className="cx-h1 cx-pagehead__title">Market</h1>
        <p className="cx-sub cx-pagehead__sub">Every company, sortable. Market cap and graduation come straight from the curve.</p>
        <label className="cx-field cx-pagehead__aside">
          <Icon name="search" size={17} />
          <input placeholder="Filter by name or ticker" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter companies" />
        </label>
      </div>

      <div style={{ marginTop: 44 }}>
        {loading ? (
          <PendingPanel line="Loading companies" />
        ) : rows.length === 0 ? (
          q.trim() ? <NoMatchPanel query={q.trim()} /> : <EmptyPanel title="The market is empty" body="It fills as curves open." />
        ) : (
          <div className="cx-table">
            <div className="cx-row cx-row--head cx-grid-board">
              <span className="cx-col-head">Company</span>
              <span style={{ textAlign: "right" }}><button className="cx-colsort" style={{ marginRight: -10 }} aria-pressed={sort === "marketCap"} onClick={() => setSort("marketCap")}>Market cap</button></span>
              <span style={{ textAlign: "right" }}><button className="cx-colsort" style={{ marginRight: -10 }} aria-pressed={sort === "price"} onClick={() => setSort("price")}>Price</button></span>
              <span className="cx-col-head" style={{ textAlign: "right" }}>24h</span>
              <span><button className="cx-colsort" style={{ marginLeft: -10 }} aria-pressed={sort === "graduation"} onClick={() => setSort("graduation")}>Graduation</button></span>
              <span className="cx-col-head" style={{ textAlign: "right" }}>Replies</span>
            </div>
            {rows.map((r) => <BoardRow key={r.address} r={r} />)}
          </div>
        )}
      </div>
      {rows.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: "4px 16px", marginTop: 16 }}>
          <span className="cx-label">{rows.length} {rows.length === 1 ? "company" : "companies"}</span>
          <span className="cx-label">24h and replies appear once the indexer is connected</span>
        </div>
      )}
    </>
  );
}
