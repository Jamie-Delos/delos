// Optional Census indexer API client. When VITE_INDEXER_URL is set (i.e. once the indexer is deployed
// on the company server + Postgres), the app reads the board/coin/chart data from it — fast, and it
// scales to real volume. When it's NOT set, callers fall back to reading the chain directly in the
// browser (fine for testnet / low volume). Every call degrades to null on error so the UI never breaks.
import { INDEXER_URL } from "../config";

export type IndexerCoin = {
  address: string; name: string; symbol: string; decimals: number; totalSupply: string;
  creator: string; quote: string; quoteSymbol: string; vault: string | null; holdersBps: number; isV2: boolean;
  // V4 fields (the indexer is adding these separately; absent on an older indexer — read defensively).
  venue?: "v4" | "legacy" | string | null; reflectionBps?: number | null; poolId?: string | null;
  virtualQuote: string; tokenReserve: string; virtualTokenOffset: string; realQuote: string; graduationQuote: string;
  graduated: boolean; pool: string | null; progressBps: number;
  // USD fields are null when the indexer has no configured USD price for the quote asset (fail closed).
  priceQuote: number; priceUsd: number | null; marketCapUsd: number | null; volumeQuote: number; volumeUsd: number | null;
  tradeCount: number; createdBlock: string; createdAt: string; updatedAt: string;
};
export type IndexerTrade = {
  coin: string; trader: string; isBuy: boolean; amountIn: string; amountOut: string; fee: string;
  priceQuote: number; venue?: "curve" | "pool" | string; block: string; txHash: string; ts: string;
};

export const indexerEnabled = () => !!INDEXER_URL;

async function get<T>(path: string): Promise<T | null> {
  if (!INDEXER_URL) return null;
  try {
    const r = await fetch(`${INDEXER_URL}${path}`);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export const fetchCoins = (sort = "new", limit = 50) => get<{ coins: IndexerCoin[] }>(`/coins?sort=${sort}&limit=${limit}`);
export const fetchCoin = (address: string) => get<{ coin: IndexerCoin }>(`/coins/${address.toLowerCase()}`);
export const fetchTrades = (address: string, limit = 50) => get<{ trades: IndexerTrade[] }>(`/coins/${address.toLowerCase()}/trades?limit=${limit}`);
export const fetchChart = (address: string, limit = 500) => get<{ points: { t: string; priceQuote: number; priceUsd: number | null }[] }>(`/coins/${address.toLowerCase()}/chart?limit=${limit}`);

// WebSocket URL for live updates (new coins / trades / graduations), or null if the indexer isn't set.
export const indexerWsUrl = () => (INDEXER_URL ? INDEXER_URL.replace(/^http/, "ws") + "/ws" : null);
