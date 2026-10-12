// Lightweight on-chain "indexer": reads LaunchedV4 events from LaunchFactoryV4 (plus the legacy
// Launched/LaunchedV2 events when those factories are configured, so old testnet coins still show)
// and turns them into the board's coin list, newest first. When VITE_INDEXER_URL is set the deployed
// indexer serves the same list instead (fast, scales). No placeholder data: until the first read
// completes the pages show a loading state, and an empty chain shows an honest empty state.
import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { zeroAddress, type Address } from "viem";
import { CONTRACTS, CHAIN } from "../config";
import { factoryAbi, factoryV2Abi, factoryV4Abi, erc20Abi } from "../abis";
import { fetchCoins, indexerEnabled, type IndexerCoin } from "./indexer";
import type { CurveVenue } from "./curves";

export type LaunchedCoin = {
  address: Address;
  name: string;
  symbol: string;
  creator: Address;
  age: string; // "39m", "2h", "3d" — from the launch block's timestamp
  launchedAt: number; // unix seconds (0 when unknown)
  venue: CurveVenue; // "v4" for LaunchedV4 coins, "legacy" for the V3-era factories
  quote?: Address; // the pairing asset (V4 event / indexer)
  vault?: Address; // reflection rewards vault, when the launch has one
  reflectionBps?: number; // holder reflection (V4), when known
};

const FROM_BLOCK = BigInt(import.meta.env.VITE_FROM_BLOCK ?? 0); // set to the factory deploy block on mainnet
// The Robinhood Chain RPC caps one eth_getLogs query at 10,000,000 blocks and the factories' history already
// spans more than that, so a scan runs in fixed windows (oldest first) and concatenates the results.
const SCAN_WINDOW = 5_000_000n;
type BlockWindow = { fromBlock: bigint; toBlock: bigint };
function blockWindows(from: bigint, head: bigint): BlockWindow[] {
  const out: BlockWindow[] = [];
  for (let start = from; start <= head; start += SCAN_WINDOW) {
    const end = start + SCAN_WINDOW - 1n;
    out.push({ fromBlock: start, toBlock: end < head ? end : head });
  }
  return out;
}
const ago = (ts: number) => {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const isAddr = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && v.toLowerCase() !== zeroAddress;

// The indexer is adding V4 fields separately: read them defensively and treat anything unknown as legacy.
function indexerToCoin(c: IndexerCoin): LaunchedCoin {
  const created = Math.floor(new Date(c.createdAt).getTime() / 1000) || 0;
  // An indexer without V4 fields yet reports no venue/reflection: such coins are treated as legacy.
  const venue: CurveVenue = c.venue === "legacy" ? "legacy" : c.venue === "v4" || typeof c.reflectionBps === "number" ? "v4" : "legacy";
  return {
    address: c.address as Address, name: c.name || "Token", symbol: c.symbol || "TOKEN", creator: c.creator as Address, age: ago(created), launchedAt: created,
    venue, quote: isAddr(c.quote) ? c.quote : undefined, vault: isAddr(c.vault) ? c.vault : undefined,
    reflectionBps: typeof c.reflectionBps === "number" ? c.reflectionBps : undefined,
  };
}

// One shared read per page load: navigating Home → Market → Profile reuses the last result for a while
// instead of rescanning the chain each time.
let cache: { at: number; coins: LaunchedCoin[] } | null = null;
const CACHE_MS = 30_000;

export function useLaunches(enabled = true): { coins: LaunchedCoin[]; live: boolean; loading: boolean } {
  const publicClient = usePublicClient({ chainId: CHAIN.id });
  const fresh = cache && Date.now() - cache.at < CACHE_MS ? cache.coins : null;
  const [coins, setCoins] = useState<LaunchedCoin[]>(fresh ?? []);
  const [live, setLive] = useState(fresh != null);
  const [loading, setLoading] = useState(enabled && fresh == null);

  useEffect(() => {
    let cancelled = false;
    if (!enabled) { setLoading(false); return; }
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

    const v4Factories = [...new Set([CONTRACTS.factoryV4, CONTRACTS.factoryV4DevBuy].filter(a => a !== zeroAddress).map(a => a.toLowerCase()))] as Address[];
    const v1 = CONTRACTS.factory, v2 = CONTRACTS.factoryV2;
    if (!publicClient || (v4Factories.length === 0 && v1 === zeroAddress && v2 === zeroAddress)) { setLoading(false); return; }
    (async () => {
      try {
        // Launch events carry (token, creator, curve, …) — no pool at launch, since trading is on the
        // curve until graduation. Token + creator + block (+ the V4 vault/reflection/quote) are all the list needs.
        type Ev = { token: Address; creator: Address; block: bigint; venue: CurveVenue; quote?: Address; vault?: Address; reflectionBps?: number };
        const evs: Ev[] = [];
        const windows = blockWindows(FROM_BLOCK, await publicClient.getBlockNumber());
        const scan = async <T>(read: (w: BlockWindow) => Promise<T[]>): Promise<T[]> => {
          const out: T[] = [];
          for (const w of windows) out.push(...(await read(w)));
          return out;
        };
        for (const factory of v4Factories) {
          const logs = await scan((w) => publicClient.getContractEvents({ address: factory, abi: factoryV4Abi, eventName: "LaunchedV4", ...w }));
          for (const l of logs) if (l.args.token && l.args.creator) {
            evs.push({ token: l.args.token, creator: l.args.creator, block: l.blockNumber ?? 0n, venue: "v4", quote: l.args.quote, vault: isAddr(l.args.vault) ? l.args.vault : undefined, reflectionBps: Number(l.args.reflectionBps ?? 0) });
          }
        }
        if (v1 !== zeroAddress) {
          const logs = await scan((w) => publicClient.getContractEvents({ address: v1, abi: factoryAbi, eventName: "Launched", ...w }));
          for (const l of logs) if (l.args.token && l.args.creator) evs.push({ token: l.args.token, creator: l.args.creator, block: l.blockNumber ?? 0n, venue: "legacy" });
        }
        if (v2 !== zeroAddress) {
          const logs = await scan((w) => publicClient.getContractEvents({ address: v2, abi: factoryV2Abi, eventName: "LaunchedV2", ...w }));
          for (const l of logs) if (l.args.token && l.args.creator) evs.push({ token: l.args.token, creator: l.args.creator, block: l.blockNumber ?? 0n, venue: "legacy", vault: isAddr(l.args.vault) ? l.args.vault : undefined });
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
          return { address: e.token, name, symbol, creator: e.creator, age: ago(launchedAt), launchedAt, venue: e.venue, quote: e.quote, vault: e.vault, reflectionBps: e.reflectionBps };
        }));
        done(built);
      } catch {
        if (!cancelled) setLoading(false); // RPC trouble: honest empty state, never placeholder coins
      }
    })();
    return () => { cancelled = true; };
  }, [publicClient, enabled]);

  return { coins, live, loading };
}
