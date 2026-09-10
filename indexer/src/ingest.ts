import { createPublicClient, http, defineChain, parseAbiItem, getAddress, type PublicClient } from "viem";
import { cfg } from "./config.js";
import { erc20Abi } from "./abis.js";
import { prisma } from "./db.js";
import { publish } from "./bus.js";

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

const CURSOR_ID = "curve";
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
async function onRegistered(log: any) {
  const coin = lc(log.args.coin as string);
  const quote = lc(log.args.quote as string);
  const vault = lc(log.args.vault as string);
  const isV2 = vault !== "0x0000000000000000000000000000000000000000";

  let name = "", symbol = "TOKEN", decimals = 18, totalSupply = "0";
  try {
    const [n, s, d, ts] = await Promise.all([
      client.readContract({ address: coin as `0x${string}`, abi: erc20Abi, functionName: "name" }),
      client.readContract({ address: coin as `0x${string}`, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address: coin as `0x${string}`, abi: erc20Abi, functionName: "decimals" }),
      client.readContract({ address: coin as `0x${string}`, abi: erc20Abi, functionName: "totalSupply" }),
    ]);
    name = n as string; symbol = s as string; decimals = Number(d); totalSupply = (ts as bigint).toString();
  } catch { /* leave defaults */ }

  const quoteSymbol = quote === cfg.weth ? "ETH" : quote;
  const base = {
    name, symbol, decimals, totalSupply,
    creator: lc(log.args.creator as string),
    quote, quoteSymbol,
    vault: isV2 ? vault : null,
    holdersBps: Number(log.args.holdersBps),
    isV2,
    virtualQuote: (log.args.virtualQuote as bigint).toString(),
    tokenReserve: totalSupply, // whole supply seeds the curve
    realQuote: "0",
    graduationQuote: (log.args.graduationQuote as bigint).toString(),
    graduated: false,
    createdBlock: log.blockNumber as bigint,
  };
  const d = derive(base);
  const row = await prisma.coin.upsert({
    where: { address: coin },
    create: { address: coin, ...base, ...d },
    update: { ...base, ...d },
  });
  publish({ type: "coin", data: serializeCoin(row) });
}

async function onTraded(log: any) {
  const coin = lc(log.args.coin as string);
  const c = await prisma.coin.findUnique({ where: { address: coin } });
  if (!c) return; // Registered always precedes trades; skip if somehow missing

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

  await prisma.trade.upsert({
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
  const row = await prisma.coin.update({
    where: { address: coin },
    data: {
      virtualQuote: vq.toString(), tokenReserve: tr.toString(), realQuote: rq.toString(),
      ...d, volumeQuote: c.volumeQuote + volAdd, volumeUsd: c.volumeUsd + volAdd * (d.priceUsd > 0 && d.priceQuote > 0 ? d.priceUsd / d.priceQuote : 0),
      tradeCount: c.tradeCount + 1,
    },
  });
  await prisma.pricePoint.create({ data: { coinAddress: coin, priceQuote: tradePrice, priceUsd: d.priceUsd, block: log.blockNumber as bigint, ts } });
  publish({ type: "trade", data: { coin, trader: lc(log.args.trader as string), isBuy, amountIn: amountIn.toString(), amountOut: amountOut.toString(), fee: fee.toString(), priceQuote: tradePrice, ts } });
  publish({ type: "coin", data: serializeCoin(row) });
}

async function onGraduated(log: any) {
  const coin = lc(log.args.coin as string);
  const row = await prisma.coin.update({
    where: { address: coin },
    data: { graduated: true, pool: lc(log.args.pool as string), progressBps: 10000 },
  }).catch(() => null);
  if (row) publish({ type: "graduate", data: serializeCoin(row) });
}

async function processLog(log: any) {
  if (log.eventName === "Registered") return onRegistered(log);
  if (log.eventName === "Traded") return onTraded(log);
  if (log.eventName === "Graduated") return onGraduated(log);
}

// ---- cursor + loops ----
async function getCursor(): Promise<bigint> {
  const c = await prisma.cursor.findUnique({ where: { id: CURSOR_ID } });
  return c ? c.lastBlock : cfg.startBlock;
}
async function setCursor(block: bigint) {
  await prisma.cursor.upsert({ where: { id: CURSOR_ID }, create: { id: CURSOR_ID, lastBlock: block }, update: { lastBlock: block } });
}

async function scan(fromBlock: bigint, toBlock: bigint) {
  let from = fromBlock;
  while (from <= toBlock) {
    const to = from + cfg.logPage - 1n > toBlock ? toBlock : from + cfg.logPage - 1n;
    let logs: any[] = [];
    try {
      logs = await client.getLogs({ address: cfg.curve, events: EVENTS as any, fromBlock: from, toBlock: to });
    } catch (e: any) {
      if (cfg.logPage > 1000n && to > from) { /* range too big — shrink for this pass */ }
      console.error(`[ingest] getLogs ${from}-${to}:`, e?.shortMessage ?? e?.message ?? e);
      await sleep(500);
    }
    logs.sort((a, b) => (a.blockNumber === b.blockNumber ? Number(a.logIndex) - Number(b.logIndex) : Number(a.blockNumber - b.blockNumber)));
    for (const log of logs) {
      try { await processLog(log); } catch (e: any) { console.error("[ingest] processLog:", e?.message ?? e); }
    }
    await setCursor(to);
    from = to + 1n;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runIngest() {
  console.log(`[ingest] curve=${getAddress(cfg.curve)} rpc=${cfg.rpcUrl} chain=${cfg.chainId}`);
  const head0 = await client.getBlockNumber();
  const start = await getCursor();
  console.log(`[ingest] backfill ${start} -> ${head0}`);
  await scan(start, head0);
  console.log("[ingest] backfill complete; entering live poll");
  for (;;) {
    try {
      const cursor = await getCursor();
      const head = await client.getBlockNumber();
      if (head > cursor) await scan(cursor + 1n, head);
    } catch (e: any) {
      console.error("[ingest] live loop:", e?.shortMessage ?? e?.message ?? e);
    }
    await sleep(cfg.pollMs);
  }
}

// ---- serialization (BigInt -> string for JSON/WS) ----
export function serializeCoin(c: any) {
  return {
    address: c.address, name: c.name, symbol: c.symbol, decimals: c.decimals,
    totalSupply: c.totalSupply, creator: c.creator, quote: c.quote, quoteSymbol: c.quoteSymbol,
    vault: c.vault, holdersBps: c.holdersBps, isV2: c.isV2,
    virtualQuote: c.virtualQuote, tokenReserve: c.tokenReserve, realQuote: c.realQuote,
    graduationQuote: c.graduationQuote, graduated: c.graduated, pool: c.pool, progressBps: c.progressBps,
    priceQuote: c.priceQuote, priceUsd: c.priceUsd, marketCapUsd: c.marketCapUsd,
    volumeQuote: c.volumeQuote, volumeUsd: c.volumeUsd, tradeCount: c.tradeCount,
    createdBlock: c.createdBlock?.toString?.() ?? String(c.createdBlock ?? "0"),
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}
