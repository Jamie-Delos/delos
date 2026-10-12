import { useEffect, useState } from "react";
import { EXPLORER } from "../config";
import { fetchChart, fetchTrades, indexerEnabled, type IndexerTrade } from "../lib/indexer";
import "./market-chart.css";

type Point = { t: string; priceQuote: number; priceUsd: number | null };
type Period = "1H" | "1D" | "1W" | "RECENT";
type Candle = { t: number; open: number; high: number; low: number; close: number; count: number };

const PERIODS: Period[] = ["1H", "1D", "1W", "RECENT"];
const RANGE_MS: Record<Period, number> = { "1H": 3_600_000, "1D": 86_400_000, "1W": 604_800_000, RECENT: Infinity };
const BUCKET_MS: Record<Period, number> = { "1H": 60_000, "1D": 300_000, "1W": 3_600_000, RECENT: 86_400_000 };

function candlesFor(points: Point[], period: Period, now: number): Candle[] {
  const from = now - RANGE_MS[period];
  const byBucket = new Map<number, Candle>();
  for (const point of [...points].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))) {
    const at = Date.parse(point.t);
    const price = Number(point.priceQuote);
    if (!Number.isFinite(at) || at < from || !Number.isFinite(price) || price <= 0) continue;
    const bucket = Math.floor(at / BUCKET_MS[period]) * BUCKET_MS[period];
    const c = byBucket.get(bucket);
    if (c) {
      c.high = Math.max(c.high, price); c.low = Math.min(c.low, price); c.close = price; c.count++;
    } else {
      byBucket.set(bucket, { t: bucket, open: price, high: price, low: price, close: price, count: 1 });
    }
  }
  return [...byBucket.values()].slice(-120);
}

const priceLabel = (price: number) => price >= 1 ? price.toLocaleString(undefined, { maximumFractionDigits: 4 })
  : price >= 0.0001 ? price.toPrecision(4) : price.toExponential(3);

function quoteVolume(trade: IndexerTrade, decimals: number): string {
  try {
    const raw = trade.isBuy ? BigInt(trade.amountIn) : BigInt(trade.amountOut) + BigInt(trade.fee);
    return (Number(raw) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: 5 });
  } catch { return "—"; }
}

export function MarketChart({ address, symbol, quoteSymbol, quoteDecimals }: {
  address: string; symbol: string; quoteSymbol: string; quoteDecimals: number;
}) {
  const [period, setPeriod] = useState<Period>("1D");
  const [points, setPoints] = useState<Point[]>([]);
  const [trades, setTrades] = useState<IndexerTrade[]>([]);
  const [asOf, setAsOf] = useState(Date.now());
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    let active = true;
    if (!indexerEnabled()) { setState("unavailable"); return; }
    setPoints([]); setTrades([]); setState("loading");
    const refresh = async () => {
      const [chart, feed] = await Promise.all([fetchChart(address, 2000), fetchTrades(address, 100)]);
      if (!active) return;
      if (!chart || !feed) { setState("unavailable"); return; }
      setPoints(chart.points); setTrades(feed.trades); setAsOf(Date.now()); setState("ready");
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [address]);

  const candles = candlesFor(points, period, asOf);
  const low = candles.length ? Math.min(...candles.map(c => c.low)) : 0;
  const high = candles.length ? Math.max(...candles.map(c => c.high)) : 1;
  const spread = Math.max(high - low, high * 0.02, 1e-12);
  const floor = Math.max(0, low - spread * 0.08);
  const ceiling = high + spread * 0.08;
  const left = 70, right = 980, top = 16, bottom = 270;
  const y = (p: number) => bottom - ((p - floor) / (ceiling - floor)) * (bottom - top);
  const step = (right - left) / Math.max(candles.length, 1);
  const bodyWidth = Math.max(2, Math.min(11, step * 0.65));
  const firstClose = candles[0]?.open ?? null;
  const lastClose = candles[candles.length - 1]?.close ?? null;
  const change = firstClose && lastClose ? ((lastClose / firstClose) - 1) * 100 : null;
  const buyCount = trades.filter(t => t.isBuy).length;
  const sellCount = trades.length - buyCount;

  return <section className="delos-market" aria-label={`${symbol} price and trades`}>
    <div className="delos-market__header">
      <div>
        <strong>{symbol || "Token"} / {quoteSymbol}</strong>
        <span>Recorded curve and pool trades · quote asset per token</span>
        {lastClose != null && <div className="delos-market__last">{priceLabel(lastClose)} {quoteSymbol}
          {change != null && <small className={change >= 0 ? "delos-market__buy" : "delos-market__sell"}>{change >= 0 ? "+" : ""}{change.toFixed(2)}%</small>}
        </div>}
      </div>
      <div className="delos-market__windows" aria-label="Chart period">
        {PERIODS.map(w => <button key={w} type="button" aria-pressed={period === w} onClick={() => setPeriod(w)}>{w}</button>)}
      </div>
    </div>
    {state === "loading" ? <div className="delos-market__empty">Loading indexed trades…</div>
      : state === "unavailable" ? <div className="delos-market__empty">Live chart unavailable. Configure and connect the Delos indexer to show verified prices and trades.</div>
      : candles.length === 0 ? <div className="delos-market__empty">No recorded trades in this period. Try RECENT after the first buy or sell.</div>
      : <div className="delos-market__plot">
        <svg viewBox="0 0 1000 305" role="img" aria-label={`${period} OHLC chart of ${candles.length} candles, drawn from the latest indexed trades`}>
          {[0, 1, 2, 3, 4].map(i => {
            const value = floor + (ceiling - floor) * (4 - i) / 4;
            const lineY = top + (bottom - top) * i / 4;
            return <g key={i}><line x1={left} x2={right} y1={lineY} y2={lineY} className="delos-market__grid" />
              <text x={left - 9} y={lineY + 4} textAnchor="end" className="delos-market__axis">{priceLabel(value)}</text></g>;
          })}
          {candles.map((c, i) => {
            const x = left + step * (i + 0.5);
            const rising = c.close >= c.open;
            const bodyTop = Math.min(y(c.open), y(c.close));
            const bodyHeight = Math.max(2, Math.abs(y(c.open) - y(c.close)));
            return <g key={c.t} className={rising ? "delos-market__up" : "delos-market__down"}>
              <title>{`${new Date(c.t).toLocaleString()} | O ${priceLabel(c.open)} H ${priceLabel(c.high)} L ${priceLabel(c.low)} C ${priceLabel(c.close)} ${quoteSymbol} | ${c.count} trades`}</title>
              <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} />
              <rect x={x - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} />
            </g>;
          })}
          {lastClose != null && <line x1={left} x2={right} y1={y(lastClose)} y2={y(lastClose)} className="delos-market__last-line" />}
          {[0, 0.5, 1].map(f => {
            const c = candles[Math.round((candles.length - 1) * f)];
            return <text key={f} x={left + (right - left) * f} y={296} textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"} className="delos-market__axis">{new Date(c.t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</text>;
          })}
        </svg>
      </div>}
    <div className="delos-market__feed-head"><div><strong>Latest buys and sells</strong><span>{state === "ready" ? `Last ${trades.length} trades · ${buyCount} buys · ${sellCount} sells` : ""}</span></div><span>{state === "ready" ? `Updated ${new Date(asOf).toLocaleTimeString()}` : ""}</span></div>
    {state === "ready" && trades.length > 0 ? <div className="delos-market__table-wrap"><table className="delos-market__table">
      <thead><tr><th>Time</th><th>Side</th><th>Value</th><th>Price</th><th>Trader</th><th>Tx</th></tr></thead>
      <tbody>{trades.slice(0, 30).map((t, i) => <tr key={`${t.txHash}-${i}`}>
        <td>{new Date(t.ts).toLocaleTimeString()}</td>
        <td className={t.isBuy ? "delos-market__buy" : "delos-market__sell"}>{t.isBuy ? "Buy" : "Sell"}</td>
        <td>{quoteVolume(t, quoteDecimals)} {quoteSymbol}{t.venue ? ` · ${t.venue}` : ""}</td>
        <td>{Number.isFinite(t.priceQuote) && t.priceQuote > 0 ? priceLabel(t.priceQuote) : "—"}</td>
        <td title={t.trader}>{t.trader.slice(0, 6)}…{t.trader.slice(-4)}</td>
        <td>{EXPLORER && /^0x[0-9a-f]{64}$/i.test(t.txHash) ? <a href={`${EXPLORER}/tx/${t.txHash}`} target="_blank" rel="noreferrer">View</a> : "—"}</td>
      </tr>)}</tbody>
    </table></div> : state === "ready" ? <div className="delos-market__empty delos-market__empty--small">No buys or sells indexed yet.</div> : null}
  </section>;
}
