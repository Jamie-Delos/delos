// Lightweight on-chain "indexer": reads Launched (Prima) + LaunchedV2 (Maxima) events straight from the
// factories and turns them into the board's coin list, newest first. Falls back to the mock catalogue when
// no factory is configured (preview) or nothing has launched yet. Price/mcap are left at 0 for now (needs
// pool reads / a real indexer at scale) — the board shows "new" for those.
import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { type Address } from "viem";
import { CONTRACTS } from "../config";
import { factoryAbi, factoryV2Abi, erc20Abi } from "../abis";
import { COINS, type Coin } from "./mock";
import { short } from "./format";
import { fetchCoins, indexerEnabled, type IndexerCoin } from "./indexer";

const ZERO = "0x0000000000000000000000000000000000000000";
const FROM_BLOCK = BigInt(import.meta.env.VITE_FROM_BLOCK ?? 0); // set to the factory deploy block on mainnet
const EMOJI = ["🪙", "🚀", "🔥", "💎", "🐸", "🌙", "⚡", "🦍", "🧪", "🎯", "🛸", "🍀"];
const emojiFor = (addr: string) => EMOJI[Number(BigInt(addr) % BigInt(EMOJI.length))];
const ago = (ts: number) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

// Map an indexer coin onto the board's Coin shape (mcap/price already computed server-side).
function indexerToCoin(c: IndexerCoin, i: number): Coin {
  const created = Math.floor(new Date(c.createdAt).getTime() / 1000) || 0;
  return {
    address: c.address, emoji: emojiFor(c.address), name: c.name || "Token", symbol: c.symbol || "TOKEN",
    creator: short(c.creator as `0x${string}`), creatorAddress: c.creator, age: ago(created),
    mcap: c.marketCapUsd || 0, price: c.priceUsd || c.priceQuote || 0, change24: 0, replies: 0, desc: "",
    trending: i < 4, koth: i === 0,
  };
}

export function useLaunches(): { coins: Coin[]; live: boolean; loading: boolean } {
  const publicClient = usePublicClient();
  const [coins, setCoins] = useState<Coin[]>(COINS);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Prefer the indexer when configured (VITE_INDEXER_URL): fast, scales, no chain scanning in the
    // browser. Falls through to reading the chain directly when it isn't set.
    if (indexerEnabled()) {
      (async () => {
        setLoading(true);
        try {
          const res = await fetchCoins("new", 100);
          if (!cancelled && res && res.coins.length) {
            setCoins(res.coins.map((c, i) => indexerToCoin(c, i)));
            setLive(true);
          }
        } catch { /* keep the mock catalogue */ }
        finally { if (!cancelled) setLoading(false); }
      })();
      return () => { cancelled = true; };
    }

    const v1 = CONTRACTS.factory, v2 = CONTRACTS.factoryV2;
    if (!publicClient || (v1 === ZERO && v2 === ZERO)) return; // preview: keep the mock catalogue
    (async () => {
      setLoading(true);
      try {
        // New curve-model events carry (token, creator, curve, …) — no pool at launch, since trading is
        // on the CensusCurve until graduation. We only need token + creator to build the board list.
        const evs: { token: Address; creator: Address; block: bigint }[] = [];
        if (v1 !== ZERO) {
          const logs = await publicClient.getContractEvents({ address: v1, abi: factoryAbi, eventName: "Launched", fromBlock: FROM_BLOCK });
          for (const l of logs) evs.push({ token: (l as any).args.token, creator: (l as any).args.creator, block: l.blockNumber ?? 0n });
        }
        if (v2 !== ZERO) {
          const logs = await publicClient.getContractEvents({ address: v2, abi: factoryV2Abi, eventName: "LaunchedV2", fromBlock: FROM_BLOCK });
          for (const l of logs) evs.push({ token: (l as any).args.token, creator: (l as any).args.creator, block: l.blockNumber ?? 0n });
        }
        if (evs.length === 0) return; // nothing launched yet — keep the mock catalogue
        evs.sort((a, b) => Number(b.block - a.block)); // newest first

        const times = new Map<bigint, number>();
        await Promise.all([...new Set(evs.map((e) => e.block))].map(async (b) => {
          try { times.set(b, Number((await publicClient.getBlock({ blockNumber: b })).timestamp)); } catch { times.set(b, 0); }
        }));

        const built = await Promise.all(evs.map(async (e) => {
          let name = "Token", symbol = "TOKEN";
          try {
            [name, symbol] = await Promise.all([
              publicClient.readContract({ address: e.token, abi: erc20Abi, functionName: "name" }) as Promise<string>,
              publicClient.readContract({ address: e.token, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
            ]);
          } catch { /* leave defaults */ }
          return {
            address: e.token, emoji: emojiFor(e.token), name, symbol,
            creator: short(e.creator), creatorAddress: e.creator, age: ago(times.get(e.block) ?? 0),
            mcap: 0, price: 0, change24: 0, replies: 0, desc: "",
          } as Coin;
        }));

        if (!cancelled) {
          setCoins(built.map((c, i) => ({ ...c, trending: i < 4, koth: i === 0 })));
          setLive(true);
        }
      } catch { /* any RPC issue: silently keep the mock catalogue */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [publicClient]);

  return { coins, live, loading };
}
