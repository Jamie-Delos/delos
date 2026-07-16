import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { parseEther, type Address } from "viem";
import { CONTRACTS, DEFAULT_FEE } from "../config";
import { wethAbi, swapRouterAbi } from "../abis";
import { COINS, HOLDERS, THREAD } from "../lib/mock";
import { usd, price as fmtPrice, pct, short } from "../lib/format";
import { IcBack, IcCopy, IcTg } from "../components/icons";

function Chart() {
  const path = useMemo(() => {
    const pts: string[] = [];
    let y = 150;
    for (let i = 0; i <= 40; i++) {
      y += ((i * 37) % 23) - 11 - (i > 20 ? 2 : 0);
      y = Math.max(30, Math.min(180, y));
      pts.push(`${(i / 40) * 640},${y}`);
    }
    return pts;
  }, []);
  const line = "M" + path.join(" L");
  const area = `${line} L640,200 L0,200 Z`;
  return (
    <div className="chart">
      <svg viewBox="0 0 640 200" preserveAspectRatio="none" style={{ height: 200 }}>
        <defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#2dd4bf" stopOpacity="0.28" /><stop offset="1" stopColor="#2dd4bf" stopOpacity="0" /></linearGradient></defs>
        <path d={area} fill="url(#g)" />
        <path d={line} fill="none" stroke="#2dd4bf" strokeWidth="2.5" />
      </svg>
    </div>
  );
}

export function Coin() {
  const { address } = useParams();
  const nav = useNavigate();
  const { address: me, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const coin = COINS.find((c) => c.address.toLowerCase() === (address || "").toLowerCase())
    ?? { address: address || "", emoji: "🪙", name: "Token", symbol: "TOKEN", creator: "0x000000", age: "just now", mcap: 1200, price: 0.0000012, change24: 0, replies: 0, desc: "" };

  const [buy, setBuy] = useState(true);
  const [amount, setAmount] = useState("0.1");
  const [tf, setTf] = useState("1h");
  const [status, setStatus] = useState("");

  const configured = CONTRACTS.factory !== "0x0000000000000000000000000000000000000000";

  async function trade() {
    setStatus("");
    if (!configured || !publicClient || !me) { setStatus("trading is placeholder until contracts are live"); return; }
    if (!buy) { setStatus("sell coming soon"); return; }
    try {
      const amountIn = parseEther(amount || "0");
      setStatus("wrapping…");
      let h = await writeContractAsync({ address: CONTRACTS.weth, abi: wethAbi, functionName: "deposit", value: amountIn });
      await publicClient.waitForTransactionReceipt({ hash: h });
      setStatus("approving…");
      h = await writeContractAsync({ address: CONTRACTS.weth, abi: wethAbi, functionName: "approve", args: [CONTRACTS.swapRouter, amountIn] });
      await publicClient.waitForTransactionReceipt({ hash: h });
      setStatus("trading…");
      h = await writeContractAsync({ address: CONTRACTS.swapRouter, abi: swapRouterAbi, functionName: "exactInputSingle", args: [{ tokenIn: CONTRACTS.weth, tokenOut: coin.address as Address, fee: DEFAULT_FEE, recipient: me, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
      await publicClient.waitForTransactionReceipt({ hash: h });
      setStatus("bought ✓");
    } catch (e: any) { setStatus(e?.shortMessage ?? e?.message ?? String(e)); }
  }

  return (
    <>
      <div className="back" onClick={() => nav("/")}><IcBack /> back to board</div>
      <div className="coin-detail">
        <div>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div className="coin-tile" style={{ background: "#e2b04a" }}>{coin.emoji}</div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{coin.name} <span className="dim" style={{ fontWeight: 400, fontSize: 15 }}>{coin.symbol}</span></div>
              {coin.trending && <span className="pill gold" style={{ marginTop: 6 }}>🔥 trending</span>}
              <div className="dim" style={{ fontSize: 12.5, marginTop: 8 }}>created by <span className="accent">{coin.creator}</span> · {coin.age}</div>
              <div className="row" style={{ marginTop: 8, gap: 8 }}>
                <span className="pill mono">{short(coin.address)} <IcCopy /></span>
                <span className="pill"><IcTg /></span>
              </div>
            </div>
          </div>

          <div className="stats">
            <div className="stat"><div className="k">market cap</div><div className="v accent">{usd(coin.mcap)}</div></div>
            <div className="stat"><div className="k">price</div><div className="v">{fmtPrice(coin.price)}</div></div>
            <div className="stat"><div className="k">24h</div><div className="v" style={{ color: coin.change24 >= 0 ? "var(--pos)" : "var(--neg)" }}>{pct(coin.change24)}</div></div>
            <div className="stat"><div className="k">holders</div><div className="v">{218}</div></div>
          </div>

          <div className="row" style={{ justifyContent: "space-between", margin: "8px 0" }}>
            <div className="tf">{["1m", "5m", "1h", "1d"].map((t) => <button key={t} className={tf === t ? "on" : ""} onClick={() => setTf(t)}>{t}</button>)}</div>
            <span className="dim" style={{ fontSize: 12 }}>price in USD</span>
          </div>
          <Chart />

          <div className="card" style={{ marginTop: 16 }}>
            <div className="row" style={{ justifyContent: "space-between" }}><span className="h2">graduation</span><span className="accent" style={{ fontWeight: 700 }}>42%</span></div>
            <div className="gradtrack"><div className="gradfill" style={{ width: "42%" }} /></div>
            <div className="dim" style={{ fontSize: 12 }}>1.55 ETH of ~3.7 ETH bought · graduates at ~$60k mcap</div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="h2" style={{ marginBottom: 10 }}>holders</div>
            {HOLDERS.map((h) => (
              <div className="holder" key={h.label}>
                <span className="swatch" style={{ background: h.color }} />
                <span style={{ flex: 1 }}>{h.label} {h.dev && <span className="pill neg" style={{ marginLeft: 6 }}>dev</span>}</span>
                <span className="mono dim">{h.pct}%</span>
              </div>
            ))}
          </div>

          <div className="fees" style={{ marginTop: 16 }}>
            <div style={{ marginBottom: 8 }}>you've earned <b className="accent">0.0000 ETH</b> in swap fees</div>
            <button className="btn2" onClick={() => setStatus(configured ? "collecting…" : "placeholder")}>collect fees</button>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="h2" style={{ marginBottom: 8 }}>thread</div>
            <div className="row"><input className="input" placeholder="post a reply" /><button className="btn2">post</button></div>
            {THREAD.map((c, i) => (
              <div className="comment" key={i}>
                <div className="avatar" style={{ width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>{c.avatar}</div>
                <div>
                  <div style={{ fontSize: 13 }}><b>{c.name}</b> {c.dev && <span className="badge-dev">dev</span>} <span className="dim">· {c.age}</span></div>
                  <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>{c.body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* trade panel (sticky column on desktop) */}
        <div className="card" style={{ position: "sticky", top: 16 }}>
          <div className="seg">
            <button className={buy ? "on" : ""} onClick={() => setBuy(true)}>buy</button>
            <button className={!buy ? "on" : ""} onClick={() => setBuy(false)}>sell</button>
          </div>
          <div className="amount" style={{ marginTop: 12 }}>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} />
            <span className="unit">{buy ? "ETH" : coin.symbol}</span>
          </div>
          <div className="quick">{["0.01", "0.1", "0.5", "1"].map((q) => <button key={q} onClick={() => setAmount(q)}>{q}</button>)}</div>
          <div className="row" style={{ justifyContent: "space-between", margin: "4px 0 12px" }}><span className="dim" style={{ fontSize: 12 }}>slippage</span><span className="mono dim" style={{ fontSize: 12 }}>2%</span></div>
          <button className="cta" onClick={trade} disabled={!isConnected}>{isConnected ? "place trade" : "log in to trade"}</button>
          <div className="dim" style={{ textAlign: "center", fontSize: 12, marginTop: 8 }}>1% fee</div>
          {status && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{status}</div>}
        </div>
      </div>
    </>
  );
}
