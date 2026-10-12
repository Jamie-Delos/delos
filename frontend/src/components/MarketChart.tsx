import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { EXPLORER } from "../config";
import { fetchCandles, fetchTrades, indexerEnabled, type IndexedCandle, type IndexerTrade } from "../lib/indexer";
import "./market-chart.css";

const RESOLUTIONS = [["1m", 60], ["5m", 300], ["15m", 900], ["1h", 3600], ["4h", 14400], ["1d", 86400]] as const;
const priceLabel = (p: number) => p >= 1 ? p.toLocaleString(undefined, { maximumFractionDigits: 4 }) : p >= .0001 ? p.toPrecision(4) : p.toExponential(3);
const volume = (raw: string, decimals: number) => Number(raw) / 10 ** decimals;
function average(rows: IndexedCandle[], length: number): (number | null)[] {
  let sum = 0;
  return rows.map((c, i) => { sum += c.close; if (i >= length) sum -= rows[i - length].close; return i >= length - 1 ? sum / length : null; });
}
function quoteVolume(trade: IndexerTrade, decimals: number): string {
  try { return volume(trade.isBuy ? trade.amountIn : (BigInt(trade.amountOut) + BigInt(trade.fee)).toString(), decimals).toLocaleString(undefined, { maximumFractionDigits: 5 }); }
  catch { return "—"; }
}

export function MarketChart({ address, symbol, quoteSymbol, quoteDecimals }: { address: string; symbol: string; quoteSymbol: string; quoteDecimals: number }) {
  const [resolution, setResolution] = useState(300);
  const [pageTo, setPageTo] = useState<Date | null>(null);
  const [visibleCount, setVisibleCount] = useState(100);
  const [showSma20, setShowSma20] = useState(true);
  const [showSma50, setShowSma50] = useState(false);
  const [candles, setCandles] = useState<IndexedCandle[]>([]);
  const [trades, setTrades] = useState<IndexerTrade[]>([]);
  const [hover, setHover] = useState<number | null>(null);
  const [asOf, setAsOf] = useState(Date.now());
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  useEffect(() => {
    let active = true;
    if (!indexerEnabled()) { setState("unavailable"); return; }
    setCandles([]); setHover(null); setState("loading");
    const refresh = async () => {
      const to = pageTo ?? new Date(), from = new Date(to.getTime() - resolution * 1000 * 500);
      const [chart, feed] = await Promise.all([fetchCandles(address, resolution, from, to), fetchTrades(address, 100)]);
      if (!active) return;
      if (!chart || !feed) { setState("unavailable"); return; }
      setCandles(chart.candles); setTrades(feed.trades); setAsOf(Date.now()); setState("ready");
    };
    void refresh();
    const timer = pageTo ? undefined : window.setInterval(() => { void refresh(); }, 15_000);
    return () => { active = false; if (timer) window.clearInterval(timer); };
  }, [address, resolution, pageTo]);

  const visible = useMemo(() => candles.slice(-visibleCount), [candles, visibleCount]);
  const averages20 = useMemo(() => average(candles, 20).slice(-visibleCount), [candles, visibleCount]);
  const averages50 = useMemo(() => average(candles, 50).slice(-visibleCount), [candles, visibleCount]);
  const current = hover == null ? visible[visible.length - 1] : visible[hover];
  const first = visible[0], last = visible[visible.length - 1];
  const change = first && last ? (last.close / first.open - 1) * 100 : null;
  const buyCount = trades.filter((t) => t.isBuy).length, sellCount = trades.length - buyCount;
  const lo = visible.length ? Math.min(...visible.map((c) => c.low)) : 0;
  const hi = visible.length ? Math.max(...visible.map((c) => c.high)) : 1;
  const pad = Math.max((hi - lo) * .07, hi * .002, 1e-12);
  const floor = Math.max(0, lo - pad), ceiling = hi + pad;
  const left = 85, right = 975, top = 25, bottom = 335;
  const y = (p: number) => bottom - ((p - floor) / (ceiling - floor)) * (bottom - top);
  const step = (right - left) / Math.max(visible.length, 1), x = (i: number) => left + step * (i + .5);
  const bodyWidth = Math.max(2, Math.min(16, step * .65));
  const maxVolume = Math.max(...visible.map((c) => volume(c.volumeRaw, quoteDecimals)), 1e-12);
  const linePath = (values: (number | null)[]) => values.map((value, i) => value == null ? "" : `${i === 0 || values[i - 1] == null ? "M" : "L"}${x(i).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const onMove = (e: MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect(), cursor = (e.clientX - rect.left) / rect.width * 1000;
    setHover(cursor >= left && cursor <= right ? Math.max(0, Math.min(visible.length - 1, Math.floor((cursor - left) / step))) : null);
  };

  return <section className="delos-market" aria-label={`${symbol} candlestick chart and trades`}>
    <div className="delos-market__header"><div><strong>{symbol || "Token"} / {quoteSymbol}</strong>
      <span>OHLCV from indexed curve and canonical-pool trades · no synthetic candles</span>
      {current && <div className="delos-market__last">{priceLabel(current.close)} {quoteSymbol}
        {change != null && <small className={change >= 0 ? "delos-market__buy" : "delos-market__sell"}>{change >= 0 ? "+" : ""}{change.toFixed(2)}%</small>}</div>}
    </div><div className="delos-market__windows" aria-label="Candle interval">
      {RESOLUTIONS.map(([label, seconds]) => <button key={label} type="button" aria-pressed={resolution === seconds} onClick={() => { setResolution(seconds); setPageTo(null); setHover(null); }}>{label}</button>)}
    </div></div>
    <div className="delos-market__toolbar"><div><button type="button" aria-pressed={showSma20} onClick={() => setShowSma20(!showSma20)}>SMA 20</button>
      <button type="button" aria-pressed={showSma50} onClick={() => setShowSma50(!showSma50)}>SMA 50</button></div>
      <div><button type="button" onClick={() => setVisibleCount(Math.max(30, Math.round(visibleCount / 1.5)))} aria-label="Zoom in">＋</button>
        <button type="button" onClick={() => setVisibleCount(Math.min(500, Math.round(visibleCount * 1.5)))} aria-label="Zoom out">－</button>
        <button type="button" disabled={!first || state !== "ready"} onClick={() => setPageTo(new Date(Date.parse(first.t) - 1))}>Older</button>
        <button type="button" disabled={!pageTo} onClick={() => setPageTo(null)}>Latest</button></div></div>
    {state === "loading" ? <div className="delos-market__empty">Loading indexed trades…</div>
      : state === "unavailable" ? <div className="delos-market__empty">Live chart unavailable. Connect the Delos indexer to show verified candles and trades.</div>
      : visible.length === 0 ? <div className="delos-market__empty">No trades in this window. Try a longer interval or a newer window.</div>
      : <div className="delos-market__plot"><div className="delos-market__ohlcv">{current && <><span>{new Date(current.t).toLocaleString()}</span>
        <span>O <b>{priceLabel(current.open)}</b></span><span>H <b>{priceLabel(current.high)}</b></span>
        <span>L <b>{priceLabel(current.low)}</b></span><span>C <b>{priceLabel(current.close)}</b></span>
        <span>Vol <b>{volume(current.volumeRaw, quoteDecimals).toLocaleString(undefined, { maximumFractionDigits: 4 })} {quoteSymbol}</b></span></>}</div>
        <svg viewBox="0 0 1000 485" role="img" aria-label={`${RESOLUTIONS.find(([, s]) => s === resolution)?.[0]} OHLCV chart, ${visible.length} real candles`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {[0, 1, 2, 3, 4].map((i) => { const yy = top + (bottom - top) * i / 4; return <g key={i}><line x1={left} x2={right} y1={yy} y2={yy} className="delos-market__grid" />
            <text x={left - 8} y={yy + 4} textAnchor="end" className="delos-market__axis">{priceLabel(floor + (ceiling - floor) * (4 - i) / 4)}</text></g>; })}
          {visible.map((c, i) => { const rising = c.close >= c.open, bodyTop = Math.min(y(c.open), y(c.close)); const vol = volume(c.volumeRaw, quoteDecimals) / maxVolume; return <g key={c.t} className={rising ? "delos-market__up" : "delos-market__down"}>
            <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} />
            <rect x={x(i) - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={Math.max(2, Math.abs(y(c.open) - y(c.close)))} />
            <rect x={x(i) - bodyWidth / 2} y={440 - vol * 65} width={bodyWidth} height={Math.max(1, vol * 65)} opacity=".55" /></g>; })}
          {showSma20 && <path d={linePath(averages20)} className="delos-market__sma20" />}
          {showSma50 && <path d={linePath(averages50)} className="delos-market__sma50" />}
          {last && <line x1={left} x2={right} y1={y(last.close)} y2={y(last.close)} className="delos-market__last-line" />}
          {hover != null && visible[hover] && <g className="delos-market__crosshair"><line x1={x(hover)} x2={x(hover)} y1={top} y2={440} /><line x1={left} x2={right} y1={y(visible[hover].close)} y2={y(visible[hover].close)} /></g>}
          <text x={left - 8} y={410} textAnchor="end" className="delos-market__axis">Volume</text>
          {[0, .5, 1].map((f) => { const c = visible[Math.round((visible.length - 1) * f)]; return <text key={f} x={left + (right - left) * f} y={470} textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"} className="delos-market__axis">
            {new Date(c.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</text>; })}
        </svg><p className="delos-market__source">Hover for OHLCV · volume in {quoteSymbol} · {pageTo ? "historical window" : `updates every 15s · ${new Date(asOf).toLocaleTimeString()}`}</p></div>}
    <div className="delos-market__feed-head"><div><strong>Latest buys and sells</strong><span>{state === "ready" ? `Last ${trades.length} trades · ${buyCount} buys · ${sellCount} sells` : ""}</span></div><span>{state === "ready" ? `Updated ${new Date(asOf).toLocaleTimeString()}` : ""}</span></div>
    {state === "ready" && trades.length > 0 ? <div className="delos-market__table-wrap"><table className="delos-market__table"><thead><tr><th>Time</th><th>Side</th><th>Value</th><th>Price</th><th>Trader</th><th>Tx</th></tr></thead>
      <tbody>{trades.slice(0, 30).map((t, i) => <tr key={`${t.txHash}-${i}`}><td>{new Date(t.ts).toLocaleTimeString()}</td>
        <td className={t.isBuy ? "delos-market__buy" : "delos-market__sell"}>{t.isBuy ? "Buy" : "Sell"}</td>
        <td>{quoteVolume(t, quoteDecimals)} {quoteSymbol}{t.venue ? ` · ${t.venue}` : ""}</td>
        <td>{Number.isFinite(t.priceQuote) && t.priceQuote > 0 ? priceLabel(t.priceQuote) : "—"}</td>
        <td title={t.trader}>{t.trader.slice(0, 6)}…{t.trader.slice(-4)}</td>
        <td>{EXPLORER && /^0x[0-9a-f]{64}$/i.test(t.txHash) ? <a href={`${EXPLORER}/tx/${t.txHash}`} target="_blank" rel="noreferrer">View</a> : "—"}</td></tr>)}</tbody></table></div>
      : state === "ready" ? <div className="delos-market__empty delos-market__empty--small">No buys or sells indexed yet.</div> : null}
  </section>;
}
