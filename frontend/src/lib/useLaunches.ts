// Lightweight on-chain "indexer": reads Launched (Prima) + LaunchedV2 (Maxima) events straight from the
// factories and turns them into the board's coin list, newest first. When VITE_INDEXER_URL is set the
// deployed indexer serves the same list instead (fast, scales). No placeholder data: until the first
// read completes the pages show a loading state, and an empty chain shows an honest empty state.
import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { zeroAddress, type Address } from "viem";
import { CONTRACTS } from "../config";
import { factoryAbi, factoryV2Abi, erc20Abi } from "../abis";
import { fetchCoins, indexerEnabled, type IndexerCoin } from "./indexer";

export type LaunchedCoin = {
  address: Address;
  name: string;
  symbol: string;
  creator: Address;
  age: string; // "39m", "2h", "3d" — from the launch block's timestamp
  launchedAt: number; // unix seconds (0 when unknown)
};

const FROM_BLOCK = BigInt(import.meta.env.VITE_FROM_BLOCK ?? 0); // set to the factory deploy block on mainnet
const ago = (ts: number) => {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

function indexerToCoin(c: IndexerCoin): LaunchedCoin {
  const created = Math.floor(new Date(c.createdAt).getTime() / 1000) || 0;
  return { address: c.address as Address, name: c.name || "Token", symbol: c.symbol || "TOKEN", creator: c.creator as Address, age: ago(created), launchedAt: created };
}

// One shared read per page load: navigating Home → Market → Profile reuses the last result for a while
// instead of rescanning the chain each time.
let cache: { at: number; coins: LaunchedCoin[] } | null = null;
const CACHE_MS = 30_000;

export function useLaunches(): { coins: LaunchedCoin[]; live: boolean; loading: boolean } {
  const publicClient = usePublicClient();
  const fresh = cache && Date.now() - cache.at < CACHE_MS ? cache.coins : null;
  const [coins, setCoins] = useState<LaunchedCoin[]>(fresh ?? []);
  const [live, setLive] = useState(fresh != null);
  const [loading, setLoading] = useState(fresh == null);

  useEffect(() => {
    let cancelled = false;
    if (fresh) return;
    const done = (list: LaunchedCoin[]) => {
      cache = { at: Date.now(), coins: list };
      if (!cancelled) { setCoins(list); setLive(true); setLoading(false); }
    };

    if (indexerEnabled()) {
      (async () => {
        try {
          const res = await fetchCoins("new", 100);
          if (res) done(res.coins.map(indexerToCoin));
          else if (!cancelled) setLoading(false);
        } catch { if (!cancelled) setLoading(false); }
      })();
      return () => { cancelled = true; };
    }

    const v1 = CONTRACTS.factory, v2 = CONTRACTS.factoryV2;
    if (!publicClient || (v1 === zeroAddress && v2 === zeroAddress)) { setLoading(false); return; }
    (async () => {
      try {
        // Launch events carry (token, creator, curve, …) — no pool at launch, since trading is on the
        // CensusCurve until graduation. Token + creator + block are all the list needs.
        const evs: { token: Address; creator: Address; block: bigint }[] = [];
        if (v1 !== zeroAddress) {
          const logs = await publicClient.getContractEvents({ address: v1, abi: factoryAbi, eventName: "Launched", fromBlock: FROM_BLOCK });
          for (const l of logs) if (l.args.token && l.args.creator) evs.push({ token: l.args.token, creator: l.args.creator, block: l.blockNumber ?? 0n });
        }
        if (v2 !== zeroAddress) {
          const logs = await publicClient.getContractEvents({ address: v2, abi: factoryV2Abi, eventName: "LaunchedV2", fromBlock: FROM_BLOCK });
          for (const l of logs) if (l.args.token && l.args.creator) evs.push({ token: l.args.token, creator: l.args.creator, block: l.blockNumber ?? 0n });
        }
        evs.sort((a, b) => Number(b.block - a.block)); // newest first

        const times = new Map<bigint, number>();
        await Promise.all([...new Set(evs.map((e) => e.block))].map(async (b) => {
          try { times.set(b, Number((await publicClient.getBlock({ blockNumber: b })).timestamp)); } catch { times.set(b, 0); }
        }));

        const built = await Promise.all(evs.map(async (e): Promise<LaunchedCoin> => {
          let name = "Token", symbol = "TOKEN";
          try {
            [name, symbol] = await Promise.all([
              publicClient.readContract({ address: e.token, abi: erc20Abi, functionName: "name" }),
              publicClient.readContract({ address: e.token, abi: erc20Abi, functionName: "symbol" }),
            ]);
          } catch { /* leave defaults */ }
          const launchedAt = times.get(e.block) ?? 0;
          return { address: e.token, name, symbol, creator: e.creator, age: ago(launchedAt), launchedAt };
        }));
        done(built);
      } catch {
        if (!cancelled) setLoading(false); // RPC trouble: honest empty state, never placeholder coins
      }
    })();
    return () => { cancelled = true; };
  }, [publicClient]);

  return { coins, live, loading };
}
