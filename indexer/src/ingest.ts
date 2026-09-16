import { createPublicClient, http, defineChain, parseAbiItem, getAddress, type PublicClient } from "viem";
import { cfg } from "./config.js";
import { erc20Abi } from "./abis.js";
import { prisma } from "./db.js";
import { publish, type Update } from "./bus.js";
import type { Prisma } from "@prisma/client";
import { ingestion } from "./status.js";

const chain = defineChain({
  id: cfg.chainId,
  name: `chain-${cfg.chainId}`,
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [cfg.rpcUrl] } },
});
const client: PublicClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });

const REGISTERED = parseAbiItem(
  "event Registered(address indexed coin, address quote, address creator, address vault, uint16 holdersBps, uint256 virtualQuote, uint256 graduationQuote)",
);
const TRADED = parseAbiItem(
  "event Traded(address indexed coin, address indexed trader, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 fee)",
);
const GRADUATED = parseAbiItem(
  "event Graduated(address indexed coin, address pool, uint256 tokenId, uint256 tokensIn, uint256 quoteIn)",
);
const EVENTS = [REGISTERED, TRADED, GRADUATED] as const;

// Post-graduation coverage: the coin's own locked pool (swaps) and its DividendVault (rewards).
const POOL_SWAP = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);
const VAULT_DISTRIBUTED = parseAbiItem("event Distributed(uint256 quoteSpent)");
const VAULT_CLAIMED = parseAbiItem("event Claimed(address indexed holder, address indexed stock, uint256 amount)");
const VAULT_CONVERTED = parseAbiItem("event LaunchFeesConverted(uint256 tokenIn, uint256 quoteOut)");
const EXT_EVENTS = [POOL_SWAP, VAULT_DISTRIBUTED, VAULT_CLAIMED, VAULT_CONVERTED] as const;

const CURSOR_ID = "curve"; // One chain/curve per database; deployment identity is checked on startup.
type Db = Prisma.TransactionClient;
type Notify = (u: Update) => void;
const lc = (a: string) => a.toLowerCase();

// ---- block-timestamp cache ----
const tsCache = new Map<string, Date>();
async function blockTime(blockNumber: bigint): Promise<Date> {
  const k = blockNumber.toString();
  const hit = tsCache.get(k);
  if (hit) return hit;
  const b = await client.getBlock({ blockNumber });
  const d = new Date(Number(b.timestamp) * 1000);
  tsCache.set(k, d);
  if (tsCache.size > 5000) tsCache.clear();
  return d;
}

// ---- derived fields ----
function derive(coin: {
  virtualQuote: string; tokenReserve: string; realQuote: string; graduationQuote: string;
  decimals: number; quote: string; totalSupply: string;
}) {
  const vq = Number(coin.virtualQuote);
  const tr = Number(coin.tokenReserve);
  const decFactor = 10 ** (coin.decimals - 18); // quote assets (WETH/HOOD) are 18-dec
  const priceQuote = tr > 0 ? (vq / tr) * decFactor : 0; // quote per token (human)
  const quoteUsd = lc(coin.quote) === cfg.weth ? cfg.ethUsd : 0; // HOOD/other: needs its own feed (TODO)
  const priceUsd = priceQuote * quoteUsd;
  const supplyHuman = Number(coin.totalSupply) / 10 ** coin.decimals;
  const marketCapUsd = priceUsd * supplyHuman;
  const gq = BigInt(coin.graduationQuote || "0");
  const rq = BigInt(coin.realQuote || "0");
  const progressBps = gq > 0n ? Number((rq >= gq ? 10000n : (rq * 10000n) / gq)) : 0;
  return { priceQuote, priceUsd, marketCapUsd, progressBps };
}

// ---- handlers ----
async function onRegistered(log: any, db: Db, notify: Notify) {
  const coin = lc(log.args.coin as string);
  const quote = lc(log.args.quote as string);
  const vault = lc(log.args.vault as string);
  const isV2 = vault !== "0x0000000000000000000000000000000000000000";

  const [n, s, tokenDecimals, ts] = await Promise.all([
    client.readContract({ address: coin as `0x${string}`, abi: erc20Abi, functionName: "name", blockNumber: log.blockNumber }),
    client.readContract({ address: coin as `0x${string}`, abi: erc20Abi, functionName: "symbol", blockNumber: log.blockNumber }),
    client.readContract({ address: coin as `0x${string}`, abi: erc20Abi, functionName: "decimals", blockNumber: log.blockNumber }),
    client.readContract({ address: coin as `0x${string}`, abi: erc20Abi, functionName: "totalSupply", blockNumber: log.blockNumber }),
  ]);
  const name = n as string, symbol = s as string, decimals = Number(tokenDecimals), totalSupply = (ts as bigint).toString();

  // Meme pairs are quoted in another Census coin: show its symbol and flag it for the UI.
  const quoteCoin = await db.coin.findUnique({ where: { address: quote } });
  const quoteSymbol = quote === cfg.weth ? "ETH" : quoteCoin?.symbol ?? quote;
  const base = {
    name, symbol, decimals, totalSupply,
    creator: lc(log.args.creator as string),
    quote, quoteSymbol, quoteIsCoin: !!quoteCoin,
    vault: isV2 ? vault : null,
    holdersBps: Number(log.args.holdersBps),
    isV2,
    virtualQuote: (log.args.virtualQuote as bigint).toString(),
    tokenReserve: totalSupply, // whole supply seeds the curve
    realQuote: "0",
    graduationQuote: (log.args.graduationQuote as bigint).toString(),
    graduated: false,
    createdBlock: log.blockNumber as bigint,
    createdAt: await blockTime(log.blockNumber),
  };
  const d = derive(base);
  const row = await db.coin.upsert({
    where: { address: coin },
    create: { address: coin, ...base, ...d },
    update: { ...base, ...d },
  });
  notify({ type: "coin", data: serializeCoin(row) });
}

async function onTraded(log: any, db: Db, notify: Notify) {
  const coin = lc(log.args.coin as string);
  const c = await db.coin.findUnique({ where: { address: coin } });
  if (!c) throw new Error(`Missing registration for ${coin}; refusing to skip trade`);
  const existing = await db.trade.findUnique({ where: { txHash_logIndex: { txHash: log.transactionHash, logIndex: Number(log.logIndex) } } });
  if (existing) return;

  const isBuy = Boolean(log.args.isBuy);
  const amountIn = log.args.amountIn as bigint;
  const amountOut = log.args.amountOut as bigint;
  const fee = log.args.fee as bigint;

  let vq = BigInt(c.virtualQuote), tr = BigInt(c.tokenReserve), rq = BigInt(c.realQuote);
  let grossQuote: bigint, tokenSide: bigint;
  if (isBuy) {
    const netIn = amountIn - fee;         // quote that walks the curve
    tr -= amountOut; vq += netIn; rq += netIn;
    grossQuote = amountIn; tokenSide = amountOut;
  } else {
    const gross = amountOut + fee;         // gross quote proceeds
    tr += amountIn; vq -= gross; rq -= gross;
    grossQuote = gross; tokenSide = amountIn;
  }
  const decFactor = 10 ** (c.decimals - 18);
  const tradePrice = Number(tokenSide) > 0 ? (Number(grossQuote) / Number(tokenSide)) * decFactor : 0;
  const volAdd = Number(grossQuote) / 10 ** 18;
  const ts = await blockTime(log.blockNumber as bigint);

  await db.trade.upsert({
    where: { txHash_logIndex: { txHash: log.transactionHash as string, logIndex: Number(log.logIndex) } },
    create: {
      coinAddress: coin, trader: lc(log.args.trader as string), isBuy,
      amountIn: amountIn.toString(), amountOut: amountOut.toString(), fee: fee.toString(),
      priceQuote: tradePrice, block: log.blockNumber as bigint, txHash: log.transactionHash as string,
      logIndex: Number(log.logIndex), ts,
    },
    update: {},
  });

  const merged = { ...c, virtualQuote: vq.toString(), tokenReserve: tr.toString(), realQuote: rq.toString() };
  const d = derive(merged);
  const row = await db.coin.update({
    where: { address: coin },
    data: {
      virtualQuote: vq.toString(), tokenReserve: tr.toString(), realQuote: rq.toString(),
      ...d, volumeQuote: c.volumeQuote + volAdd, volumeUsd: c.volumeUsd + volAdd * (d.priceUsd > 0 && d.priceQuote > 0 ? d.priceUsd / d.priceQuote : 0),
      tradeCount: c.tradeCount + 1,
    },
  });
  await db.pricePoint.create({ data: { coinAddress: coin, priceQuote: tradePrice, priceUsd: d.priceUsd, block: log.blockNumber as bigint, ts } });
  notify({ type: "trade", data: { coin, trader: lc(log.args.trader as string), isBuy, amountIn: amountIn.toString(), amountOut: amountOut.toString(), fee: fee.toString(), priceQuote: tradePrice, ts } });
  notify({ type: "coin", data: serializeCoin(row) });
}

async function onGraduated(log: any, db: Db, notify: Notify) {
  const coin = lc(log.args.coin as string);
  const row = await db.coin.update({
    where: { address: coin },
    data: { graduated: true, pool: lc(log.args.pool as string), progressBps: 10000 },
  });
  notify({ type: "graduate", data: serializeCoin(row) });
}

// ---- post-graduation handlers ----
async function onPoolSwap(log: any, coinAddress: string, db: Db, notify: Notify) {
  const c = await db.coin.findUnique({ where: { address: coinAddress } });
  if (!c) throw new Error(`Missing registration for pool coin ${coinAddress}`);
  const tokenIsToken0 = BigInt(c.address) < BigInt(c.quote);
  const a0 = log.args.amount0 as bigint; // pool perspective: positive = paid INTO the pool
  const a1 = log.args.amount1 as bigint;
  const quoteDelta = tokenIsToken0 ? a1 : a0;
  const tokenDelta = tokenIsToken0 ? a0 : a1;
  if (quoteDelta === 0n && tokenDelta === 0n) return;
  const isBuy = quoteDelta > 0n; // quote in, tokens out
  const amountIn = isBuy ? quoteDelta : tokenDelta;
  const amountOut = isBuy ? -tokenDelta : -quoteDelta;

  // Spot price from the pool's sqrtPriceX96 (token1 per token0), oriented to quote-per-token.
  const s = Number(log.args.sqrtPriceX96 as bigint) / 2 ** 96;
  const p01 = s * s;
  const priceRaw = tokenIsToken0 ? p01 : p01 > 0 ? 1 / p01 : 0;
  const priceQuote = priceRaw * 10 ** (c.decimals - 18);
  const volAdd = Number(quoteDelta < 0n ? -quoteDelta : quoteDelta) / 10 ** 18;
  const ts = await blockTime(log.blockNumber as bigint);

  await db.trade.upsert({
    where: { txHash_logIndex: { txHash: log.transactionHash as string, logIndex: Number(log.logIndex) } },
    create: {
      coinAddress: c.address, trader: lc(log.args.recipient as string), isBuy,
      amountIn: amountIn.toString(), amountOut: amountOut.toString(), fee: "0",
      priceQuote, venue: "pool", block: log.blockNumber as bigint, txHash: log.transactionHash as string,
      logIndex: Number(log.logIndex), ts,
    },
    update: {},
  });
  const quoteUsd = lc(c.quote) === cfg.weth ? cfg.ethUsd : 0;
  const priceUsd = priceQuote * quoteUsd;
  const marketCapUsd = priceUsd * (Number(c.totalSupply) / 10 ** c.decimals);
  const row = await db.coin.update({
    where: { address: c.address },
    data: {
      priceQuote, priceUsd, marketCapUsd,
      volumeQuote: c.volumeQuote + volAdd, volumeUsd: c.volumeUsd + volAdd * quoteUsd,
      tradeCount: c.tradeCount + 1,
    },
  });
  await db.pricePoint.create({ data: { coinAddress: c.address, priceQuote, priceUsd, block: log.blockNumber as bigint, ts } });
  notify({ type: "trade", data: { coin: c.address, trader: lc(log.args.recipient as string), isBuy, amountIn: amountIn.toString(), amountOut: amountOut.toString(), fee: "0", priceQuote, venue: "pool", ts } });
  notify({ type: "coin", data: serializeCoin(row) });
}

async function onVaultEvent(log: any, coinAddress: string, quote: string, db: Db, notify: Notify) {
  const ts = await blockTime(log.blockNumber as bigint);
  const base = { coinAddress, block: log.blockNumber as bigint, txHash: log.transactionHash as string, logIndex: Number(log.logIndex), ts };
  let data: any;
  if (log.eventName === "Distributed") {
    data = { ...base, kind: "distributed", asset: quote, amount: (log.args.quoteSpent as bigint).toString() };
  } else if (log.eventName === "Claimed") {
    data = { ...base, kind: "claimed", holder: lc(log.args.holder as string), asset: lc(log.args.stock as string), amount: (log.args.amount as bigint).toString() };
  } else if (log.eventName === "LaunchFeesConverted") {
    data = { ...base, kind: "converted", asset: quote, amount: (log.args.tokenIn as bigint).toString(), amountB: (log.args.quoteOut as bigint).toString() };
  } else {
    throw new Error("Unrecognized vault event");
  }
  await db.rewardEvent.upsert({
    where: { txHash_logIndex: { txHash: base.txHash, logIndex: base.logIndex } },
    create: data, update: {},
  });
  notify({ type: "reward", data: { ...data, block: base.block.toString() } });
}

async function processLog(log: any, db: Db, notify: Notify) {
  if (log.eventName === "Registered") return onRegistered(log, db, notify);
  if (log.eventName === "Traded") return onTraded(log, db, notify);
  if (log.eventName === "Graduated") return onGraduated(log, db, notify);
  throw new Error("Unrecognized curve event");
}

// ---- cursor + loops ----
async function getCursor(): Promise<bigint> {
  const c = await prisma.cursor.findUnique({ where: { id: CURSOR_ID } });
  return c ? c.lastBlock : cfg.startBlock - 1n;
}

async function scan(fromBlock: bigint, toBlock: bigint) {
  if (cfg.logPage <= 0n) throw new Error("LOG_PAGE must be positive");
  let from = fromBlock;
  while (from <= toBlock) {
    const to = from + cfg.logPage - 1n > toBlock ? toBlock : from + cfg.logPage - 1n;
    // All RPC/decoder/write failures propagate. The live loop retries from the durable cursor.
    const anchor = await client.getBlock({ blockNumber: to });
    const logs: any[] = await client.getLogs({ address: cfg.curve, events: EVENTS as any, fromBlock: from, toBlock: to });
    logs.sort((a, b) => (a.blockNumber === b.blockNumber ? Number(a.logIndex) - Number(b.logIndex) : Number(a.blockNumber - b.blockNumber)));
    const updates = await prisma.$transaction(async (db) => {
      // Serializes workers sharing this database; rollback includes event receipts and cursor.
      await db.$executeRaw`SELECT pg_advisory_xact_lock(1128615507)`;
      const cursor = await db.cursor.findUnique({ where: { id: CURSOR_ID } });
      if (cursor && cursor.lastBlock >= to) return [];
      if ((cursor ? cursor.lastBlock + 1n : cfg.startBlock) !== from) throw new Error("Cursor changed; retry page");
      if (cursor) {
        if (cursor.chainId !== cfg.chainId || cursor.curve !== cfg.curve || !cursor.lastHash) throw new Error("Database identity/hash missing or mismatched; rebuild from a verified checkpoint");
        const previous = await client.getBlock({ blockNumber: cursor.lastBlock });
        if (previous.hash !== cursor.lastHash) throw new Error("Reorg at indexed checkpoint; stop and rebuild before resuming");
      }
      // Post-graduation coverage: also read this page's events from the graduated pools and
      // vaults of every indexed coin — including coins registered/graduated within THIS page,
      // so a swap or reward landing right after graduation is never skipped.
      const ZERO = "0x0000000000000000000000000000000000000000";
      const known = await db.coin.findMany({ select: { address: true, pool: true, vault: true, quote: true } });
      const poolMap = new Map<string, string>();
      const vaultMap = new Map<string, { coin: string; quote: string }>();
      for (const k of known) {
        if (k.pool) poolMap.set(lc(k.pool), k.address);
        if (k.vault) vaultMap.set(lc(k.vault), { coin: k.address, quote: k.quote });
      }
      for (const log of logs) {
        if (log.eventName === "Graduated") poolMap.set(lc(log.args.pool), lc(log.args.coin));
        if (log.eventName === "Registered" && lc(log.args.vault) !== ZERO) vaultMap.set(lc(log.args.vault), { coin: lc(log.args.coin), quote: lc(log.args.quote) });
      }
      const extAddrs = [...poolMap.keys(), ...vaultMap.keys()];
      const extLogs: any[] = extAddrs.length
        ? await client.getLogs({ address: extAddrs as `0x${string}`[], events: EXT_EVENTS as any, fromBlock: from, toBlock: to })
        : [];

      const all = [...logs.map((l: any) => ({ ...l, _ext: false })), ...extLogs.map((l: any) => ({ ...l, _ext: true }))]
        .sort((a, b) => (a.blockNumber === b.blockNumber ? Number(a.logIndex) - Number(b.logIndex) : Number(a.blockNumber - b.blockNumber)));

      const pending: Update[] = [];
      const hashes = new Map<bigint, string | null>();
      for (const log of all) {
        if (!log.blockHash || !log.transactionHash || log.removed || log.blockNumber < from || log.blockNumber > to) throw new Error("Invalid/unconfirmed event");
        if (!hashes.has(log.blockNumber)) hashes.set(log.blockNumber, (await client.getBlock({ blockNumber: log.blockNumber })).hash);
        if (hashes.get(log.blockNumber) !== log.blockHash) throw new Error("Event block hash is not canonical");
        const receipt = await db.indexedEvent.createMany({ data: [{ chainId: cfg.chainId, txHash: log.transactionHash, logIndex: Number(log.logIndex), block: log.blockNumber, blockHash: log.blockHash }], skipDuplicates: true });
        if (!receipt.count) continue;
        if (!log._ext) { await processLog(log, db, u => pending.push(u)); continue; }
        const addr = lc(log.address as string);
        if (log.eventName === "Swap" && poolMap.has(addr)) await onPoolSwap(log, poolMap.get(addr)!, db, u => pending.push(u));
        else if (vaultMap.has(addr)) await onVaultEvent(log, vaultMap.get(addr)!.coin, vaultMap.get(addr)!.quote, db, u => pending.push(u));
        else throw new Error("Event from unwatched address");
      }
      const check = await client.getBlock({ blockNumber: to });
      if (!anchor.hash || anchor.hash !== check.hash) throw new Error("Chain changed while reading page");
      const data = { lastBlock: to, lastHash: anchor.hash, chainId: cfg.chainId, curve: cfg.curve };
      await db.cursor.upsert({ where: { id: CURSOR_ID }, create: { id: CURSOR_ID, ...data }, update: data });
      return pending;
    }, { isolationLevel: "Serializable", timeout: 60000, maxWait: 10000 });
    // Clients only see durable state; a broken socket cannot undo or prevent indexing.
    for (const update of updates) { try { publish(update); } catch { console.error("[ingest] update delivery failed"); } }
    ingestion.lastBlock = to.toString();
    from = to + 1n;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runIngest() {
  console.log(`[ingest] curve=${getAddress(cfg.curve)} chain=${cfg.chainId}`);
  if (await client.getChainId() !== cfg.chainId) throw new Error("RPC chain ID mismatch");
  for (;;) {
    try {
      const cursor = await getCursor();
      const finalized = await client.getBlock({ blockTag: "finalized" });
      const head = finalized.number;
      if (head === null) throw new Error("Finalized block unavailable");
      // Check the checkpoint even when no new finalized blocks arrive.
      const checkpoint = await prisma.cursor.findUnique({ where: { id: CURSOR_ID } });
      if (checkpoint && (checkpoint.chainId !== cfg.chainId || checkpoint.curve !== cfg.curve || !checkpoint.lastHash || (await client.getBlock({ blockNumber: checkpoint.lastBlock })).hash !== checkpoint.lastHash)) throw new Error("Checkpoint identity or canonical hash mismatch; rebuild required");
      if (head > cursor) await scan(cursor + 1n, head);
      ingestion.lastSuccessAt = Date.now();
      ingestion.error = null;
    } catch (e: any) {
      ingestion.error = "Ingestion stalled; inspect server logs";
      tsCache.clear();
      console.error("[ingest] live loop:", e?.shortMessage ?? e?.message ?? e);
    }
    await sleep(cfg.pollMs);
  }
}

// ---- serialization (BigInt -> string for JSON/WS) ----
export function serializeCoin(c: any) {
  return {
    address: c.address, name: c.name, symbol: c.symbol, decimals: c.decimals,
    totalSupply: c.totalSupply, creator: c.creator, quote: c.quote, quoteSymbol: c.quoteSymbol, quoteIsCoin: c.quoteIsCoin ?? false,
    vault: c.vault, holdersBps: c.holdersBps, isV2: c.isV2,
    virtualQuote: c.virtualQuote, tokenReserve: c.tokenReserve, realQuote: c.realQuote,
    graduationQuote: c.graduationQuote, graduated: c.graduated, pool: c.pool, progressBps: c.progressBps,
    priceQuote: c.priceQuote, priceUsd: c.priceUsd, marketCapUsd: c.marketCapUsd,
    volumeQuote: c.volumeQuote, volumeUsd: c.volumeUsd, tradeCount: c.tradeCount,
    createdBlock: c.createdBlock?.toString?.() ?? String(c.createdBlock ?? "0"),
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}
