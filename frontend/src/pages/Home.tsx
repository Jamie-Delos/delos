import { useMemo, useState } from "react";
import { useLaunches } from "../lib/useLaunches";
import { useCurveStats } from "../lib/useCurveStats";
import { HomeRow, TrendingCard, PendingPanel, EmptyPanel, NoMatchPanel, Icon, type DisplayCoin } from "../census";

const SORTS = [
  { key: "new", label: "Newest" },
  { key: "marketCap", label: "Market cap" },
  { key: "graduation", label: "Graduation" },
];

export function Home() {
  const { coins, loading } = useLaunches();
  const stats = useCurveStats(coins.map((c) => c.address));
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("new");

  // Launches arrive newest-first; stats are live from the curve.
  const list: DisplayCoin[] = useMemo(() => coins.map((c) => {
    const s = stats[c.address.toLowerCase()];
    return {
      address: c.address, name: c.name, symbol: c.symbol,
      creator: c.creator, age: c.age, anchor: s?.anchor ?? "ETH",
      marketCap: s?.mcapUsd ?? null, price: s?.priceUsd ?? null,
      graduation: s?.gradPct ?? 0, graduated: s?.graduated, reserve: s?.reserve, graduationTarget: s?.graduationTarget, quoteAddress: s?.quoteAddress, anchorIsCoin: s?.anchorIsCoin,
    };
  }), [coins, stats]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let r = q ? list.filter((c) => c.name.toLowerCase().includes(q) || c.symbol.toLowerCase().includes(q)) : list;
    if (sort === "marketCap") r = [...r].sort((a, b) => (b.marketCap ?? -1) - (a.marketCap ?? -1));
    else if (sort === "graduation") r = [...r].sort((a, b) => (b.graduation ?? -1) - (a.graduation ?? -1));
    return r;
  }, [list, query, sort]);

  // The rail ranks by live market cap (newest first among unpriced coins); the King is the top coin, and
  // only when a real market cap backs the title.
  const trending = useMemo(() => (loading ? [] : [...list].sort((a, b) => (b.marketCap ?? -1) - (a.marketCap ?? -1)).slice(0, 6)), [list, loading]);
  const hasKing = trending[0]?.marketCap != null;

  return (
    <>
      <div className="cx-pagehead">
        <h1 className="cx-h1 cx-pagehead__title">Every company, on a curve.</h1>
        <p className="cx-sub cx-pagehead__sub">Trade on the curve from block one. At graduation, liquidity moves to a permanently locked pool. Anchored to ETH or HOOD.</p>
        <label className="cx-field cx-pagehead__aside">
          <Icon name="search" size={17} />
          <input placeholder="Search companies or tickers" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search companies" />
        </label>
      </div>

      {trending.length > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 11, margin: "68px 0 20px" }}>
            <span className="cx-pulse" /><span className="cx-section-title">Now trending</span>
          </div>
          <div className="cx-rail">
            {trending.map((c, i) => <TrendingCard key={c.address} c={c} king={i === 0 && hasKing} />)}
          </div>
        </>
      )}

      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "72px 0 4px", gap: 16, flexWrap: "wrap" }}>
        <div className="cx-section-title">All companies</div>
        <div style={{ display: "flex", gap: 22 }}>
          {SORTS.map((s) => (
            <button key={s.key} className="cx-sort" aria-pressed={sort === s.key} onClick={() => setSort(s.key)}>{s.label}</button>
          ))}
        </div>
      </div>
      {loading
        ? <PendingPanel line="Loading companies" />
        : filtered.length
          ? <div className="cx-table">{filtered.map((c) => <HomeRow key={c.address} c={c} />)}</div>
          : query.trim()
            ? <NoMatchPanel query={query.trim()} />
            : <EmptyPanel title="Nothing counted yet" body="The first company opens the market." />}
      {!loading && filtered.length > 0 && (
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
          <span className="cx-label">{filtered.length} {filtered.length === 1 ? "company" : "companies"}</span>
          <span className="cx-label">Replies appear once the indexer is connected</span>
        </div>
      )}
    </>
  );
}
