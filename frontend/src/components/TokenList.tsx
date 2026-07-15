import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { formatUnits, parseEther, type Address } from "viem";
import { CONTRACTS, DEFAULT_FEE } from "../config";
import { factoryAbi, lockerAbi, erc20Abi, wethAbi, swapRouterAbi } from "../abis";

interface Launch {
  token: Address;
  creator: Address;
  pool: Address;
  tokenId: bigint;
}

export function TokenList({ refreshKey }: { refreshKey: number }) {
  const publicClient = usePublicClient();
  const [launches, setLaunches] = useState<Launch[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!publicClient) return;
    (async () => {
      try {
        const logs = await publicClient.getLogs({
          address: CONTRACTS.factory,
          event: factoryAbi[1] as any, // Launched
          fromBlock: 0n,
          toBlock: "latest",
        });
        const parsed = logs
          .map((l: any) => ({
            token: l.args.token as Address,
            creator: l.args.creator as Address,
            pool: l.args.pool as Address,
            tokenId: l.args.tokenId as bigint,
          }))
          .reverse();
        setLaunches(parsed);
      } catch (e: any) {
        setError(e?.shortMessage ?? e?.message ?? "Could not load launches");
      }
    })();
  }, [publicClient, refreshKey]);

  return (
    <div className="card">
      <h2>Launched tokens</h2>
      {error && <p className="status">Error: {error}</p>}
      {!error && launches.length === 0 && <p className="muted">No launches yet. Be the first!</p>}
      <div className="tokens">
        {launches.map((l) => <TokenCard key={l.token} launch={l} />)}
      </div>
    </div>
  );
}

function TokenCard({ launch }: { launch: Launch }) {
  const { data: symbol } = useReadContract({ address: launch.token, abi: erc20Abi, functionName: "symbol" });
  const { data: name } = useReadContract({ address: launch.token, abi: erc20Abi, functionName: "name" });
  const image = typeof localStorage !== "undefined" ? localStorage.getItem(`launchpad:img:${launch.token.toLowerCase()}`) : null;

  return (
    <div className="token">
      <div className="token-head">
        {image && <img className="token-img" src={image} alt="" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />}
        <strong>{(name as string) ?? "…"}</strong>
        <span className="ticker">{(symbol as string) ?? ""}</span>
      </div>
      <div className="mono small">{launch.token}</div>
      <div className="row">
        <Buy token={launch.token} />
        <Claim tokenId={launch.tokenId} />
      </div>
    </div>
  );
}

function Buy({ token }: { token: Address }) {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [eth, setEth] = useState("0.01");
  const [status, setStatus] = useState("");

  async function buy() {
    if (!publicClient || !address) return;
    try {
      const amountIn = parseEther(eth);
      setStatus("Wrapping ETH…");
      let hash = await writeContractAsync({
        address: CONTRACTS.weth, abi: wethAbi, functionName: "deposit", value: amountIn,
      });
      await publicClient.waitForTransactionReceipt({ hash });

      setStatus("Approving…");
      hash = await writeContractAsync({
        address: CONTRACTS.weth, abi: wethAbi, functionName: "approve",
        args: [CONTRACTS.swapRouter, amountIn],
      });
      await publicClient.waitForTransactionReceipt({ hash });

      setStatus("Swapping…");
      hash = await writeContractAsync({
        address: CONTRACTS.swapRouter, abi: swapRouterAbi, functionName: "exactInputSingle",
        args: [{
          tokenIn: CONTRACTS.weth, tokenOut: token, fee: DEFAULT_FEE, recipient: address,
          amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
        }],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setStatus("Bought ✓");
    } catch (e: any) {
      setStatus(`Error: ${e?.shortMessage ?? e?.message ?? String(e)}`);
    }
  }

  return (
    <div className="action">
      <input value={eth} onChange={(e) => setEth(e.target.value)} className="tiny" /> ETH
      <button className="btn small" disabled={!isConnected} onClick={buy}>Buy</button>
      {status && <span className="status small">{status}</span>}
    </div>
  );
}

function Claim({ tokenId }: { tokenId: bigint }) {
  const { isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [status, setStatus] = useState("");

  async function claim() {
    if (!publicClient) return;
    try {
      setStatus("Claiming…");
      const hash = await writeContractAsync({
        address: CONTRACTS.locker, abi: lockerAbi, functionName: "collectFees", args: [tokenId],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setStatus("Fees sent ✓");
    } catch (e: any) {
      setStatus(`Error: ${e?.shortMessage ?? e?.message ?? String(e)}`);
    }
  }

  return (
    <div className="action">
      <button className="btn small ghost" disabled={!isConnected} onClick={claim}>Collect fees</button>
      {status && <span className="status small">{status}</span>}
    </div>
  );
}
