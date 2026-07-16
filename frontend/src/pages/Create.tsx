import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { getContractAddress, parseUnits, parseEventLogs, type Address } from "viem";
import { CONTRACTS, STANDARD } from "../config";
import { factoryAbi } from "../abis";
import { computeLaunchParams, computeGraduationTick } from "../lib/launchParams";
import { IcBack } from "../components/icons";

export function Create() {
  const nav = useNavigate();
  const { isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState("");
  const [more, setMore] = useState(false);
  const [x, setX] = useState(""); const [tg, setTg] = useState(""); const [web, setWeb] = useState("");
  const [devBuy, setDevBuy] = useState("");
  const [status, setStatus] = useState("");

  const configured = CONTRACTS.factory !== "0x0000000000000000000000000000000000000000";

  async function launch() {
    setStatus("");
    if (!name.trim() || !symbol.trim()) { setStatus("name and ticker required"); return; }
    if (!configured || !publicClient) { setStatus("contracts not deployed yet (placeholder)"); return; }
    try {
      const nonce = await publicClient.getTransactionCount({ address: CONTRACTS.factory });
      const predicted = getContractAddress({ from: CONTRACTS.factory, nonce: BigInt(nonce) }) as Address;
      const p = computeLaunchParams({ token: predicted, weth: CONTRACTS.weth, tokenDecimals: STANDARD.decimals, fee: STANDARD.fee, priceWethPerToken: STANDARD.launchPriceWethPerToken });
      const graduationTick = computeGraduationTick({ token: predicted, weth: CONTRACTS.weth, tokenDecimals: STANDARD.decimals, graduationPriceWethPerToken: STANDARD.graduationPriceWethPerToken });
      setStatus("confirm in wallet…");
      const hash = await writeContractAsync({
        address: CONTRACTS.factory, abi: factoryAbi, functionName: "createLaunch",
        args: [{ name: name.trim(), symbol: symbol.trim().toUpperCase(), totalSupply: parseUnits(String(STANDARD.totalSupply), STANDARD.decimals), decimals: STANDARD.decimals, fee: STANDARD.fee, sqrtPriceX96: p.sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, graduationTick }],
      });
      setStatus("launching…");
      const rcpt = await publicClient.waitForTransactionReceipt({ hash });
      const logs = parseEventLogs({ abi: factoryAbi, eventName: "Launched", logs: rcpt.logs });
      const token = (logs[0] as any)?.args?.token as Address | undefined;
      if (token && image.trim()) localStorage.setItem(`launchpad:img:${token.toLowerCase()}`, image.trim());
      if (token) nav(`/coin/${token}`);
    } catch (e: any) { setStatus(e?.shortMessage ?? e?.message ?? String(e)); }
  }

  const ticker = symbol.trim().toUpperCase();
  return (
    <div style={{ maxWidth: 520, margin: "0 auto" }}>
      <div className="back" onClick={() => nav("/")}><IcBack /> create a new coin</div>

      <div className="card">
        <label className="field"><span>name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="doge classic" /></label>
        <label className="field"><span>ticker</span>
          <div className="amount"><span className="unit">$</span><input value={ticker} maxLength={11} onChange={(e) => setSymbol(e.target.value)} placeholder="DOGEC" /></div>
        </label>
        <label className="field"><span>image url (optional)</span><input className="input" value={image} onChange={(e) => setImage(e.target.value)} placeholder="https://…/logo.png" /></label>

        <div className="accent" style={{ fontSize: 13, cursor: "pointer", padding: "4px 0 6px" }} onClick={() => setMore(!more)}>
          show more options <span style={{ fontSize: 11 }}>{more ? "▴" : "▾"}</span>
        </div>
        {more && (
          <div>
            <label className="field"><span>x / twitter</span><input className="input" value={x} onChange={(e) => setX(e.target.value)} placeholder="@handle" /></label>
            <label className="field"><span>telegram</span><input className="input" value={tg} onChange={(e) => setTg(e.target.value)} placeholder="t.me/…" /></label>
            <label className="field"><span>website</span><input className="input" value={web} onChange={(e) => setWeb(e.target.value)} placeholder="https://…" /></label>
          </div>
        )}
        <div style={{ borderTop: "1px solid var(--border)", margin: "14px 0" }} />
        <label className="field"><span>buy a little of your own coin (optional)</span>
          <div className="amount"><input value={devBuy} onChange={(e) => setDevBuy(e.target.value)} placeholder="0.0" /><span className="unit">ETH</span></div>
        </label>

        <button className="cta" disabled={isPending} onClick={launch}>{isPending ? "launching…" : "launch coin"}</button>
        {status && <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>{status}</div>}
      </div>

      <div className="muted" style={{ fontSize: 12, margin: "10px 2px" }}>preview</div>
      <div className="coin-row" style={{ cursor: "default" }}>
        {image.trim()
          ? <img className="coin-tile avatar" src={image} alt="" style={{ borderRadius: 0 }} onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
          : <div className="coin-tile" style={{ border: "1px dashed var(--border-input)", background: "var(--surface-alt)" }} />}
        <div style={{ flex: 1 }}>
          <div className="dim" style={{ fontSize: 12, marginBottom: 3 }}>by you · just now</div>
          <div style={{ fontWeight: 700 }}>{name || "your coin"} <span className="dim" style={{ fontWeight: 400, fontSize: 13 }}>${ticker || "TICKER"}</span></div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>mcap $1.2K · 0 replies</div>
        </div>
      </div>
    </div>
  );
}
