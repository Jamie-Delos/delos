import { useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { getContractAddress, parseUnits, parseEventLogs, type Address } from "viem";
import { CONTRACTS, STANDARD } from "../config";
import { factoryAbi } from "../abis";
import { computeLaunchParams, computeGraduationTick } from "../lib/launchParams";

// One-click launch (pump.fun v1 style): the creator only picks name / symbol / image.
// Supply, curve, fee tier and graduation are all fixed by the protocol standard.
export function LaunchForm({ onLaunched }: { onLaunched?: () => void }) {
  const { isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [image, setImage] = useState("");
  const [status, setStatus] = useState<string>("");

  async function launch() {
    setStatus("");
    if (!publicClient) return;
    if (!name.trim() || !symbol.trim()) {
      setStatus("Name and symbol are required.");
      return;
    }
    try {
      // Predict the token address so the single-sided curve is oriented correctly.
      const nonce = await publicClient.getTransactionCount({ address: CONTRACTS.factory });
      const predicted = getContractAddress({ from: CONTRACTS.factory, nonce: BigInt(nonce) });

      const params = computeLaunchParams({
        token: predicted as Address,
        weth: CONTRACTS.weth,
        tokenDecimals: STANDARD.decimals,
        fee: STANDARD.fee,
        priceWethPerToken: STANDARD.launchPriceWethPerToken,
      });
      const graduationTick = computeGraduationTick({
        token: predicted as Address,
        weth: CONTRACTS.weth,
        tokenDecimals: STANDARD.decimals,
        graduationPriceWethPerToken: STANDARD.graduationPriceWethPerToken,
      });

      setStatus("Confirm in wallet…");
      const hash = await writeContractAsync({
        address: CONTRACTS.factory,
        abi: factoryAbi,
        functionName: "createLaunch",
        args: [{
          name: name.trim(),
          symbol: symbol.trim().toUpperCase(),
          totalSupply: parseUnits(String(STANDARD.totalSupply), STANDARD.decimals),
          decimals: STANDARD.decimals,
          fee: STANDARD.fee,
          sqrtPriceX96: params.sqrtPriceX96,
          tickLower: params.tickLower,
          tickUpper: params.tickUpper,
          graduationTick,
        }],
      });
      setStatus("Launching…");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // Stash the image against the real token address so Explore can show it (MVP: local only).
      const logs = parseEventLogs({ abi: factoryAbi, eventName: "Launched", logs: receipt.logs });
      const token = (logs[0] as any)?.args?.token as Address | undefined;
      if (token && image.trim()) {
        localStorage.setItem(`launchpad:img:${token.toLowerCase()}`, image.trim());
      }

      setStatus("Launched! 🎉");
      setName(""); setSymbol(""); setImage("");
      onLaunched?.();
    } catch (e: any) {
      setStatus(`Error: ${e?.shortMessage ?? e?.message ?? String(e)}`);
    }
  }

  return (
    <div className="card">
      <h2>Launch a coin</h2>
      <p className="muted">
        One click. Live on a locked Uniswap pool from the first block — price rises as people buy,
        liquidity is locked forever, you earn 100% of fees until graduation.
      </p>

      <label>Name<input value={name} placeholder="Doge Classic" onChange={(e) => setName(e.target.value)} /></label>
      <label>Symbol<input value={symbol} placeholder="DOGEC" maxLength={11} onChange={(e) => setSymbol(e.target.value)} /></label>
      <label>Image URL (optional)<input value={image} placeholder="https://…/logo.png" onChange={(e) => setImage(e.target.value)} /></label>

      {image.trim() && <img className="preview-img" src={image} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />}

      <button className="btn primary" disabled={!isConnected || isPending} onClick={launch}>
        {isConnected ? (isPending ? "Launching…" : "Launch 🚀") : "Connect wallet first"}
      </button>
      {status && <p className="status">{status}</p>}

      <p className="muted fine">
        Fixed for every coin: 1,000,000,000 supply · 1% fee · graduates ~$60k mcap (≈3.7 ETH) · no presale · no team allocation
      </p>
    </div>
  );
}
