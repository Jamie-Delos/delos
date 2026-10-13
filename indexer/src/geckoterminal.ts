// GeckoTerminal "Integration API Standards" v0.1 (Nov 2024) for the Delos bonding curve.
//
// GeckoTerminal already indexes the hooked Uniswap V4 pools a Delos coin graduates into (its own
// uniswap-v4-robinhood integration). These endpoints expose the CURVE phase as one virtual pair per
// coin, asset0 = the coin and asset1 = its quote asset, so GeckoTerminal can chart a coin from its
// first trade and attach the image and description it reads from /asset for integrated launchpads.
//
//   GET <prefix>/latest-block
//   GET <prefix>/asset?id=<token address>
//   GET <prefix>/pair?id=<coin address>
//   GET <prefix>/events?fromBlock=<n>&toBlock=<n>
//
// Amounts are decimalized strings, ids are checksummed addresses, "reserves" are the curve's pricing
// reserves after each trade (tokenReserve + virtualTokenOffset, virtualQuote), and graduation is
// reported as an "exit" that empties the pair. Pool-venue trades are left to GeckoTerminal's own V4
// indexing so nothing is counted twice. See docs/GECKOTERMINAL.md.
import { getAddress, formatUnits, isAddress, createPublicClient, http, defineChain } from "viem";
import type { FastifyInstance } from "fastify";

export type GtCfg = { chainId: number; rpcUrl: string; gtDexKey: string; gtMetadataUrl: string; gtMaxSpan: number; gtPrefix: string };
export type GtDeps = {
  prisma: any;
  cfg: GtCfg;
  ingestion: { lastBlock: string | null };
  getBlockTimestamp: (block: bigint) => Promise<number>;
  readErc20: (address: string) => Promise<{ name: string; symbol: string; decimals: number; totalSupply: bigint } | null>;
  fetchMetadata: (address: string) => Promise<Record<string, string> | null>;
};

const ERC20 = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

// Production wiring: block timestamps and unknown ERC-20s from the RPC, images/descriptions from the
// site's /api/metadata (the same store the coin pages read). Tests inject their own.
export function defaultGtDeps(base: { prisma: any; cfg: GtCfg; ingestion: { lastBlock: string | null } }): GtDeps {
  let client: any = null;
  const rpc = () => (client ??= createPublicClient({
    chain: defineChain({ id: base.cfg.chainId, name: `chain-${base.cfg.chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [base.cfg.rpcUrl] } } }),
    transport: http(base.cfg.rpcUrl),
  }));
  return {
    ...base,
    getBlockTimestamp: async (block) => Number((await rpc().getBlock({ blockNumber: block })).timestamp),
    readErc20: async (address) => {
      try {
        const a = address as `0x${string}`;
        const [name, symbol, decimals, totalSupply] = await Promise.all([
          rpc().readContract({ address: a, abi: ERC20, functionName: "name" }),
          rpc().readContract({ address: a, abi: ERC20, functionName: "symbol" }),
          rpc().readContract({ address: a, abi: ERC20, functionName: "decimals" }),
          rpc().readContract({ address: a, abi: ERC20, functionName: "totalSupply" }),
        ]);
        return { name: String(name), symbol: String(symbol), decimals: Number(decimals), totalSupply: BigInt(totalSupply as bigint) };
      } catch {
        return null;
      }
    },
    fetchMetadata: async (address) => {
      if (!base.cfg.gtMetadataUrl) return null;
      try {
        const r = await fetch(`${base.cfg.gtMetadataUrl}/api/metadata?address=${address}`, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) return null;
        const j: any = await r.json();
        const m = j?.metadata;
        if (!m || typeof m !== "object") return null;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(m)) if (typeof v === "string" && v) out[k] = v;
        return out;
      } catch {
        return null;
      }
    },
  };
}

const dec = (v: string | bigint | null | undefined, decimals: number): string => {
  try { return formatUnits(BigInt(v ?? 0), decimals); } catch { return "0"; }
};
const checksum = (a: string): string => { try { return getAddress(a); } catch { return a; } };
const unix = (d: Date | string | number): number => Math.floor(new Date(d).getTime() / 1000);
const parseBlock = (v: unknown): number | null => (typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : null);
const inRange = (b: unknown, from: number, to: number) => { const n = Number(b); return Number.isFinite(n) && n >= from && n <= to; };

// Price of asset0 in asset1 from the post-trade reserves, with 30 extra digits of precision so very
// small prices keep their significant figures (the spec reads up to 50 decimals).
function priceFromReserves(r0: string, r1: string, d0: number, d1: number, fallback: number): string {
  try {
    const a0 = BigInt(r0), a1 = BigInt(r1);
    if (a0 > 0n && a1 > 0n) return formatUnits((a1 * 10n ** BigInt(d0 + 30)) / a0, d1 + 30);
  } catch { /* fall through */ }
  return fallback > 0 ? fallback.toString() : "";
}

export function registerGeckoTerminalRoutes(app: FastifyInstance, deps: GtDeps) {
  const P = deps.cfg.gtPrefix || "/geckoterminal";
  const route = { config: { rateLimit: { max: 1200, timeWindow: "1 minute" } } };
  const err = (reply: any, code: number, error: string) => reply.code(code).send({ error });

  const blockTs = new Map<string, number>();
  async function blockTimestamp(block: bigint): Promise<number> {
    const k = block.toString();
    const hit = blockTs.get(k);
    if (hit != null) return hit;
    const ts = await deps.getBlockTimestamp(block);
    if (blockTs.size > 512) blockTs.delete(blockTs.keys().next().value as string);
    blockTs.set(k, ts);
    return ts;
  }
  const metaCache = new Map<string, { at: number; value: Record<string, string> | null }>();
  async function metadataFor(address: string) {
    const hit = metaCache.get(address);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
    const value = await deps.fetchMetadata(address);
    metaCache.set(address, { at: Date.now(), value });
    return value;
  }
  const erc20Cache = new Map<string, { at: number; value: Awaited<ReturnType<GtDeps["readErc20"]>> }>();
  async function erc20For(address: string) {
    const hit = erc20Cache.get(address);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
    const value = await deps.readErc20(address);
    erc20Cache.set(address, { at: Date.now(), value });
    return value;
  }

  app.get(`${P}/latest-block`, route, async (_req, reply) => {
    const last = deps.ingestion.lastBlock;
    if (!last) return err(reply, 503, "the indexer has not finished a block yet");
    const block = BigInt(last);
    try {
      return { block: { blockNumber: Number(block), blockTimestamp: await blockTimestamp(block) } };
    } catch {
      return err(reply, 503, "block timestamp unavailable");
    }
  });

  app.get(`${P}/asset`, route, async (req, reply) => {
    const id = String((req.query as any)?.id ?? "");
    if (!isAddress(id)) return err(reply, 400, "id must be a token address");
    const lower = id.toLowerCase();
    const coin = await deps.prisma.coin.findUnique({ where: { address: lower } });
    if (coin) {
      const meta = await metadataFor(lower);
      const metadata: Record<string, string> = { product: String(coin.product ?? "v4"), creator: checksum(coin.creator ?? "") };
      if (meta?.image) metadata.imageUrl = meta.image;
      const description = meta?.description || meta?.thesis;
      if (description) metadata.description = description;
      if (deps.cfg.gtMetadataUrl) metadata.website = `${deps.cfg.gtMetadataUrl}/#/coin/${lower}`;
      return {
        asset: {
          id: checksum(coin.address), name: coin.name || "Token", symbol: coin.symbol || "TOKEN", decimals: Number(coin.decimals ?? 18),
          totalSupply: dec(coin.totalSupply, Number(coin.decimals ?? 18)), metadata,
        },
      };
    }
    const t = await erc20For(lower);
    if (!t) return err(reply, 404, "unknown asset");
    return { asset: { id: checksum(lower), name: t.name || "Token", symbol: t.symbol || "TOKEN", decimals: t.decimals, totalSupply: dec(t.totalSupply, t.decimals) } };
  });

  app.get(`${P}/pair`, route, async (req, reply) => {
    const id = String((req.query as any)?.id ?? "");
    if (!isAddress(id)) return err(reply, 400, "id must be a coin address");
    const coin = await deps.prisma.coin.findUnique({ where: { address: id.toLowerCase() } });
    if (!coin) return err(reply, 404, "unknown pair");
    const pair: Record<string, unknown> = {
      id: checksum(coin.address), dexKey: deps.cfg.gtDexKey, asset0Id: checksum(coin.address), asset1Id: checksum(coin.quote),
      createdAtBlockNumber: Number(coin.createdBlock ?? 0), createdAtBlockTimestamp: unix(coin.createdAt ?? 0),
      feeBps: 200 + (coin.product === "v4" ? Number(coin.reflectionBps ?? 0) : 0),
      metadata: { product: String(coin.product ?? "v4"), graduationQuote: dec(coin.graduationQuote, Number(coin.quoteDecimals ?? 18)) },
    };
    if (coin.createdTxHash) pair.createdAtTxnId = coin.createdTxHash;
    if (isAddress(coin.creator ?? "")) pair.creator = checksum(coin.creator);
    return { pair };
  });

  app.get(`${P}/events`, route, async (req, reply) => {
    const q = (req.query as any) ?? {};
    const from = parseBlock(q.fromBlock), to = parseBlock(q.toBlock);
    if (from == null || to == null) return err(reply, 400, "fromBlock and toBlock must be non-negative integers");
    if (to < from) return err(reply, 400, "toBlock must be greater than or equal to fromBlock");
    if (to - from + 1 > deps.cfg.gtMaxSpan) return err(reply, 400, `at most ${deps.cfg.gtMaxSpan} blocks per request`);
    const range = { gte: BigInt(from), lte: BigInt(to) };

    const trades: any[] = (await deps.prisma.trade.findMany({
      where: { block: range, venue: "curve" },
      orderBy: [{ block: "asc" }, { txIndex: "asc" }, { logIndex: "asc" }],
    })).filter((t: any) => (t.venue ?? "curve") === "curve" && inRange(t.block, from, to));
    const addresses = [...new Set(trades.map((t: any) => String(t.coinAddress)))];
    const coins: any[] = await deps.prisma.coin.findMany({ where: { OR: [{ address: { in: addresses } }, { graduatedBlock: range }] } });
    const coinMap = new Map<string, any>(coins.map((c: any) => [String(c.address), c]));
    const graduations = coins.filter((c: any) => c.graduatedBlock != null && inRange(c.graduatedBlock, from, to));

    const events: any[] = [];
    for (const t of trades) {
      const c = coinMap.get(String(t.coinAddress));
      if (!c) continue;
      const d0 = Number(c.decimals ?? 18), d1 = Number(c.quoteDecimals ?? 18);
      const r0 = t.reserve0After ?? (BigInt(c.tokenReserve ?? 0) + BigInt(c.virtualTokenOffset ?? 0)).toString();
      const r1 = t.reserve1After ?? String(c.virtualQuote ?? "0");
      const priceNative = priceFromReserves(r0, r1, d0, d1, Number(t.priceQuote ?? 0));
      if (!priceNative) continue; // a zero price would halt GeckoTerminal's indexer; never emit one
      const base = {
        block: { blockNumber: Number(t.block), blockTimestamp: unix(t.ts) },
        eventType: "swap", txnId: String(t.txHash), txnIndex: Number(t.txIndex ?? 0), eventIndex: Number(t.logIndex ?? 0),
        maker: checksum(String(t.trader)), pairId: checksum(String(c.address)), priceNative,
        reserves: { asset0: dec(r0, d0), asset1: dec(r1, d1) },
      };
      // Buys: the curve receives quote (fee taken from it first) and pays out coin. Sells: the curve
      // receives coin and pays out quote net of the fee taken on the way out.
      events.push(t.isBuy
        ? { ...base, asset1In: dec(t.amountIn, d1), asset0Out: dec(t.amountOut, d0), metadata: { fees1In: dec(t.fee, d1) } }
        : { ...base, asset0In: dec(t.amountIn, d0), asset1Out: dec(t.amountOut, d1), metadata: { fees1Out: dec(t.fee, d1) } });
    }
    for (const c of graduations) {
      const d0 = Number(c.decimals ?? 18), d1 = Number(c.quoteDecimals ?? 18);
      const own: any[] = (await deps.prisma.trade.findMany({ where: { coinAddress: c.address, venue: "curve" }, orderBy: [{ block: "desc" }, { logIndex: "desc" }], take: 1 }))
        .filter((t: any) => (t.venue ?? "curve") === "curve")
        .sort((a: any, b: any) => Number(b.block - a.block) || Number(b.logIndex) - Number(a.logIndex));
      const last = own[0];
      const r0 = last?.reserve0After ?? (BigInt(c.tokenReserve ?? 0) + BigInt(c.virtualTokenOffset ?? 0)).toString();
      const r1 = last?.reserve1After ?? String(c.virtualQuote ?? "0");
      const blockNumber = Number(c.graduatedBlock);
      let blockTimestampValue: number;
      try { blockTimestampValue = c.graduatedAt ? unix(c.graduatedAt) : await blockTimestamp(BigInt(blockNumber)); } catch { continue; }
      events.push({
        block: { blockNumber, blockTimestamp: blockTimestampValue },
        eventType: "exit", txnId: String(c.graduatedTxHash ?? ""), txnIndex: Number(c.graduatedTxIndex ?? 0), eventIndex: Number(c.graduatedLogIndex ?? 0),
        maker: checksum(String(c.creator ?? "")), pairId: checksum(String(c.address)),
        amount0: dec(r0, d0), amount1: dec(r1, d1), reserves: { asset0: "0", asset1: "0" },
        metadata: { reason: "graduated", ...(c.poolId ? { poolId: String(c.poolId) } : {}), ...(c.pool ? { pool: checksum(String(c.pool)) } : {}) },
      });
    }
    events.sort((a, b) => a.block.blockNumber - b.block.blockNumber || a.txnIndex - b.txnIndex || a.eventIndex - b.eventIndex);
    return { events };
  });
}
