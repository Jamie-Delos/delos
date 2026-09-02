import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { getContractAddress, parseUnits, parseEventLogs, type Address } from "viem";
import { CONTRACTS, STANDARD, QUOTE } from "../config";
import { factoryAbi } from "../abis";
import { computeLaunchParams, computeGraduationTick } from "../lib/launchParams";
import { STOCKS, type Stock } from "../lib/mock";
import { IcBack } from "../components/icons";

type Tier = "v1" | "v2" | "v3";

const BASE_ASSETS = [
  { ticker: "ETH", name: "Ethereum", color: "#627eea" },
  { ticker: "HOOD", name: "Robinhood", color: "#00c805" },
];
const ALL_ASSETS = [...BASE_ASSETS, ...STOCKS];

function Dot({ color }: { color: string }) {
  return <span className="tkr" style={{ background: color }} />;
}

function AssetSelect({ value, onChange }: { value: string; onChange: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const sel = ALL_ASSETS.find((a) => a.ticker === value) ?? ALL_ASSETS[0];
  return (
    <div className="assetsel">
      <button type="button" className="assetsel-btn" onClick={() => setOpen((o) => !o)}>
        <Dot color={sel.color} /> <b>{sel.ticker}</b> <span className="chev">▾</span>
      </button>
      {open && (
        <div className="assetsel-menu">
          {ALL_ASSETS.map((a) => (
            <div key={a.ticker} className="assetsel-row" onClick={() => { onChange(a.ticker); setOpen(false); }}>
              <Dot color={a.color} /> <b>{a.ticker}</b> <span className="co">{a.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Launch() {
  const nav = useNavigate();
  const { isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();

  const [tier, setTier] = useState<Tier>("v1");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState("");
  const [paired, setPaired] = useState("ETH");
  const [status, setStatus] = useState("");

  // v2 basket
  const [basket, setBasket] = useState<Stock[]>([STOCKS[1], STOCKS[8]]); // TSLA + COST
  const [picking, setPicking] = useState(false);
  const weight = basket.length ? Math.round(100 / basket.length) : 0;
  const addStock = (s: Stock) => { if (basket.length < 4 && !basket.find((b) => b.ticker === s.ticker)) setBasket([...basket, s]); setPicking(false); };
  const rmStock = (t: string) => setBasket(basket.filter((b) => b.ticker !== t));

  // v3 hook lab
  const [buyTax, setBuyTax] = useState(1);
  const [sellTax, setSellTax] = useState(3);
  const [split, setSplit] = useState({ creator: 50, dividend: 30, burn: 20 });
  const [hooks, setHooks] = useState({ antiSnipe: true, maxWallet: false, swapRewards: false });

  const configured = CONTRACTS.factory !== "0x0000000000000000000000000000000000000000";

  async function launch() {
    setStatus("");
    if (!name.trim() || !symbol.trim()) { setStatus("name and ticker required"); return; }
    if (tier !== "v1") { setStatus(`${tier} submit wires to ${tier === "v2" ? "LaunchFactoryV2 (dividend vault)" : "the V4 hook"} — devnet-proven, testnet next`); return; }
    if (!configured || !publicClient) { setStatus("contracts not deployed yet (preview)"); return; }
    try {
      const nonce = await publicClient.getTransactionCount({ address: CONTRACTS.factory });
      const predicted = getContractAddress({ from: CONTRACTS.factory, nonce: BigInt(nonce) }) as Address;
      const p = computeLaunchParams({ token: predicted, weth: CONTRACTS.weth, tokenDecimals: STANDARD.decimals, quoteDecimals: STANDARD.quoteDecimals, fee: STANDARD.fee, priceWethPerToken: STANDARD.launchPriceWethPerToken });
      const graduationTick = computeGraduationTick({ token: predicted, weth: CONTRACTS.weth, tokenDecimals: STANDARD.decimals, quoteDecimals: STANDARD.quoteDecimals, graduationPriceWethPerToken: STANDARD.graduationPriceWethPerToken });
      setStatus("confirm in wallet…");
      const hash = await writeContractAsync({
        address: CONTRACTS.factory, abi: factoryAbi, functionName: "createLaunch",
        args: [{ name: name.trim(), symbol: symbol.trim().toUpperCase(), totalSupply: parseUnits(String(STANDARD.totalSupply), STANDARD.decimals), decimals: STANDARD.decimals, fee: STANDARD.fee, sqrtPriceX96: p.sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, graduationTick }],
      });
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      const logs = parseEventLogs({ abi: factoryAbi, eventName: "Launched", logs: rc.logs });
      const token = (logs[0] as any)?.args?.token as Address | undefined;
      if (token) nav(`/coin/${token}`);
    } catch (e: any) { setStatus(e?.shortMessage ?? e?.message ?? String(e)); }
  }

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div className="back" onClick={() => nav("/")}><IcBack /> launch a token</div>
        <div className="tiers">
          {(["v1", "v2", "v3"] as Tier[]).map((t) => (
            <button key={t} className={tier === t ? "on" : ""} onClick={() => setTier(t)}>{t}</button>
          ))}
        </div>
      </div>

      <div className="launch-grid">
        <div className="card">
          <div className="tier-tag">
            {tier === "v1" ? "BASE · pair with anything" : tier === "v2" ? "DIVIDEND · pays holders a stock basket" : "HOOK LAB · custom taxes & V4 hooks"}
          </div>
          <div className="row" style={{ gap: 12 }}>
            <label className="field" style={{ flex: 1 }}><span>name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Iron Man" /></label>
            <label className="field" style={{ flex: 1 }}><span>ticker</span><input className="input" value={symbol.toUpperCase()} maxLength={11} onChange={(e) => setSymbol(e.target.value)} placeholder="IRON" /></label>
          </div>
          <label className="field"><span>image url (optional)</span><input className="input" value={image} onChange={(e) => setImage(e.target.value)} placeholder="https://…/logo.png" /></label>

          <label className="field"><span>paired asset</span></label>
          <AssetSelect value={paired} onChange={setPaired} />
          {tier === "v1" && <div className="hint">pair against ETH, HOOD, or any tokenized stock. graduates once the curve fills.</div>}

          {/* ---- v2: dividend basket ---- */}
          {tier === "v2" && (
            <div style={{ marginTop: 18 }}>
              <label className="field"><span>dividend basket — fees buy these & pay holders</span></label>
              {basket.map((s) => (
                <div className="basket-row" key={s.ticker}>
                  <Dot color={s.color} /> <b>{s.ticker}</b> <span className="co dim" style={{ fontSize: 12 }}>{s.name}</span>
                  <span className="wt">{weight}%</span>
                  <button className="rm" onClick={() => rmStock(s.ticker)}>×</button>
                </div>
              ))}
              {basket.length < 4 && (
                <div style={{ position: "relative" }}>
                  <button className="btn2" style={{ marginTop: 10 }} onClick={() => setPicking((p) => !p)}>+ add stock ({basket.length}/4)</button>
                  {picking && (
                    <div className="assetsel-menu" style={{ position: "absolute", width: 260 }}>
                      {STOCKS.filter((s) => !basket.find((b) => b.ticker === s.ticker)).map((s) => (
                        <div key={s.ticker} className="assetsel-row" onClick={() => addStock(s)}><Dot color={s.color} /> <b>{s.ticker}</b> <span className="co">{s.name}</span></div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="hint">post-graduation fees are swapped into the basket and claimable by holders, pro-rata. e.g. {basket.map((b) => `${weight}% ${b.ticker}`).join(" · ")}.</div>
            </div>
          )}

          {/* ---- v3: hook lab ---- */}
          {tier === "v3" && (
            <div style={{ marginTop: 18 }}>
              <div className="sld">
                <label>buy tax <b>{buyTax}%</b></label>
                <input type="range" min={0} max={10} step={0.5} value={buyTax} onChange={(e) => setBuyTax(+e.target.value)} />
              </div>
              <div className="sld">
                <label>sell tax <b>{sellTax}%</b></label>
                <input type="range" min={0} max={10} step={0.5} value={sellTax} onChange={(e) => setSellTax(+e.target.value)} />
              </div>
              <label className="field"><span>tax split</span></label>
              <div className="row" style={{ gap: 10 }}>
                {(["creator", "dividend", "burn"] as const).map((k) => (
                  <label key={k} className="field" style={{ flex: 1 }}><span>{k} %</span>
                    <input className="input" type="number" value={(split as any)[k]} onChange={(e) => setSplit({ ...split, [k]: +e.target.value })} /></label>
                ))}
              </div>
              <div className="hint" style={{ color: split.creator + split.dividend + split.burn === 100 ? "var(--text-dim)" : "var(--neg)" }}>
                split must total 100% (now {split.creator + split.dividend + split.burn}%). asymmetric buy/sell taxes need a Uniswap V4 hook.
              </div>

              <label className="field" style={{ marginTop: 14 }}><span>hooks</span></label>
              <div className="hooks">
                {([
                  ["antiSnipe", "anti-snipe window", "99% tax for the first 3s so bots can't front-run the launch"],
                  ["maxWallet", "max-wallet cap", "limit any wallet to a % of supply for the first N blocks"],
                  ["swapRewards", "every swap feeds rewards", "route a slice of each trade into a staking/points pool"],
                ] as const).map(([k, t, d]) => (
                  <div key={k} className={"hook" + ((hooks as any)[k] ? " on" : "")} onClick={() => setHooks({ ...hooks, [k]: !(hooks as any)[k] })}>
                    <span className="box" />
                    <div><div className="t">{t}</div><div className="d">{d}</div></div>
                  </div>
                ))}
              </div>
              <div className="hint">v3 compiles your choices into a custom V4 hook attached to the pool at launch.</div>
            </div>
          )}

          <button className="cta" style={{ marginTop: 20 }} disabled={isPending} onClick={launch}>{isPending ? "launching…" : "launch token"}</button>
          {status && <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>{status}</div>}
        </div>

        {/* ---- preview ---- */}
        <div>
          <div className="muted" style={{ fontSize: 12, margin: "0 2px 8px" }}>your token</div>
          <div className="pv">
            <div className="row" style={{ marginBottom: 12 }}>
              {image.trim() ? <img className="coin-tile" style={{ width: 44, height: 44 }} src={image} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
                : <div className="coin-tile" style={{ width: 44, height: 44, background: "var(--surface-alt)" }} />}
              <div><div style={{ fontWeight: 700 }}>{name || "Your token"}</div><div className="dim" style={{ fontSize: 12 }}>{symbol ? "$" + symbol.toUpperCase() : "ticker"}</div></div>
            </div>
            <div className="row2"><span className="k">tier</span><span className="v accent">{tier.toUpperCase()}</span></div>
            <div className="row2"><span className="k">paired with</span><span className="v">{paired}</span></div>
            <div className="row2"><span className="k">launch fee</span><span className="v">0.0005 {QUOTE}</span></div>
            <div className="row2"><span className="k">trade fee</span><span className="v">1.00%</span></div>
            {tier === "v2" && <div className="row2"><span className="k">dividends</span><span className="v" style={{ maxWidth: 190, textAlign: "right" }}>{basket.map((b) => `${weight}% ${b.ticker}`).join(" · ")}</span></div>}
            {tier === "v3" && <><div className="row2"><span className="k">buy / sell tax</span><span className="v">{buyTax}% / {sellTax}%</span></div>
              <div className="row2"><span className="k">tax split</span><span className="v">{split.creator}/{split.dividend}/{split.burn}</span></div>
              <div className="row2"><span className="k">hooks</span><span className="v">{Object.entries(hooks).filter(([, on]) => on).length || "none"}</span></div></>}
            <div className="row2"><span className="k">launch window</span><span className="v">{hooks.antiSnipe || tier !== "v3" ? "99% snipe tax, 3s" : "off"}</span></div>
            <div className="row2"><span className="k">graduation</span><span className="v">~$60k mcap</span></div>
            <div className="row2"><span className="k">liquidity</span><span className="v accent">locked forever</span></div>
          </div>
        </div>
      </div>
    </>
  );
}
