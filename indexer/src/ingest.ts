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

// ---- legacy V3 curve (CensusCurve) ----
const REGISTERED = parseAbiItem(
  "event Registered(address indexed coin, address quote, address creator, address vault, uint16 holdersBps, uint256 virtualQuote, uint256 graduationQuote)",
);
const TRADED = parseAbiItem(
  "event Traded(address indexed coin, address indexed trader, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 fee)",
);
const GRADUATED = parseAbiItem(
  "event Graduated(address indexed coin, address pool, uint256 tokenId, uint256 tokensIn, uint256 quoteIn)",
);
const REGISTERED_LEGACY = REGISTERED;
const REGISTERED_PF = parseAbiItem("event Registered(address indexed coin, address quote, address creator, address vault, uint16 holdersBps, uint256 virtualQuote, uint256 graduationQuote, uint256 virtualTokenOffset)");
const EVENTS = [REGISTERED_LEGACY, REGISTERED_PF, TRADED, GRADUATED] as const;

// ---- V4 product (CensusCurveV4 + canonical Uniswap V4 pool with the Census hook) ----
// Registered/Traded share their topics with the PF curve; they are fetched from CURVE_V4_ADDRESS and
// decoded with the V4 names (reflectionBps). FeeAllocated is emitted right before Traded in the same
// transaction and carries the protocol/creator/holder/penalty split of Traded.fee.
const REGISTERED_V4 = parseAbiItem(
  "event Registered(address indexed coin, address quote, address creator, address vault, uint16 reflectionBps, uint256 virtualQuote, uint256 graduationQuote, uint256 virtualTokenOffset)",
);
const FEE_ALLOCATED = parseAbiItem(
  "event FeeAllocated(address indexed coin, bool isBuy, uint256 protocolFee, uint256 creatorFee, uint256 holderFee, uint256 penalty)",
);
const GRADUATED_V4 = parseAbiItem(
  "event Graduated(address indexed coin, bytes32 indexed poolId, uint256 tokensIn, uint256 quoteIn, uint128 liquidity)",
);
const V4_EVENTS = [REGISTERED_V4, TRADED, FEE_ALLOCATED, GRADUATED_V4] as const;
// PoolManager swaps are filtered by the coin's poolId (topic1). Deltas are the SWAPPER's balance
// deltas (negative = paid into the pool), the opposite sign convention of the V3 pool Swap event.
const PM_SWAP = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
// The hook accrues exactly one FeeAccrued per swap on a Census pool: in beforeSwap for buys (fee
// taken from the specified quote input, so the Swap deltas are net) and in afterSwap for sells
// (fee taken from the quote output). quoteVolume is the gross quote either way.
const HOOK_FEE_ACCRUED = parseAbiItem(
  "event FeeAccrued(bytes32 indexed poolId, bool buy, uint256 quoteVolume, uint256 protocolFee, uint256 creatorFee, uint256 holderFee)",
);
const HOOK_FEES_CLAIMED = parseAbiItem("event FeesClaimed(address indexed asset, address indexed recipient, uint256 amount)");
const HOOK_EVENTS = [HOOK_FEE_ACCRUED, HOOK_FEES_CLAIMED] as const;

// Post-graduation coverage: the coin's own locked V3 pool (swaps) and its vault (rewards). The V4
// CensusRewardVault emits the same Distributed/Claimed topics as the V3 DividendVault (the second
// Claimed argument is named `asset` there, `stock` here; both are read).
const POOL_SWAP = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);
const VAULT_DISTRIBUTED = parseAbiItem("event Distributed(uint256 quoteSpent)");
const VAULT_CLAIMED = parseAbiItem("event Claimed(address indexed holder, address indexed stock, uint256 amount)");
const VAULT_CONVERTED = parseAbiItem("event LaunchFeesConverted(uint256 tokenIn, uint256 quoteOut)");
const EXT_EVENTS = [POOL_SWAP, VAULT_DISTRIBUTED, VAULT_CLAIMED, VAULT_CONVERTED] as const;
const TOKEN_TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const CURSOR_ID = "curve"; // One chain/deployment per database; deployment identity is checked on startup.
// Deployment identity stored on the cursor. Adding or removing a curve changes it, which forces a
// rebuild from a fresh checkpoint (events of the added curve before the old cursor would otherwise
// be missed). A V3-only deployment keeps the historical value (the V3 curve address).
const IDENTITY: string = cfg.curveV4 ? `${cfg.curve ?? "none"}|v4:${cfg.curveV4}` : (cfg.curve as string);
const ZERO = "0x0000000000000000000000000000000000000000";
type Db = Prisma.TransactionClient;
type Notify = (u: Update) => void;
const lc = (a: string) => a.toLowerCase();

// Which watched contract a log came from; set by prefetchPage and used to dispatch in commitPage.
type Source = "curve" | "curveV4" | "pool" | "vault" | "poolManager" | "hook" | "token";
// Per-trade fee split attached to a Traded (from FeeAllocated) or a PoolManager Swap (from FeeAccrued).
type FeeSplit = { protocol: bigint; creator: bigint; holders: bigint; penalty: bigint; gross?: bigint; buy?: boolean };
const feeColumns = (f?: FeeSplit) => ({
  feeProtocol: (f?.protocol ?? 0n).toString(), feeCreator: (f?.creator ?? 0n).toString(),
  feeHolders: (f?.holders ?? 0n).toString(), feePenalty: (f?.penalty ?? 0n).toString(),
});

// Everything a page needs from the chain, fetched BEFORE the database transaction opens so no
// network I/O ever runs while the serializable transaction / advisory lock is held (a busy page on a
// slow RPC used to expire the 60 s transaction and livelock the ingester on the same page).
type TokenMeta = { name: string; symbol: string; decimals: number; totalSupply: string };
type PageContext = {
  from: bigint; to: bigint; anchorHash: string;
  logs: any[];                                   // every watched contract's logs, canonical order, tagged _src
  blocks: Map<string, { hash: string; ts: Date }>; // block number -> canonical hash + timestamp
  tokenMeta: Map<string, TokenMeta>;            // coin -> immutable ERC20 metadata (Registered only)
  poolMap: Map<string, string>;                 // V3 pool address -> coin
  poolIdMap: Map<string, string>;               // V4 poolId (bytes32) -> coin
  vaultMap: Map<string, { coin: string; quote: string }>;
  tokenMap: Set<string>;
};

async function onTokenTransfer(log: any, db: Db) {
  const coinAddress = lc(log.address);
  const from = lc(log.args.from);
  const to = lc(log.args.to);
  const value = log.args.value as bigint;
  if (value < 0n || from === to) return;
  for (const [holder, change] of [[from, -value], [to, value]] as const) {
    if (holder === ZERO || change === 0n) continue;
    const key = { coinAddress_holder: { coinAddress, holder } };
    const prior = await db.holderBalance.findUnique({ where: key });
    const next = BigInt(prior?.balance.toString() ?? "0") + change;
    if (next < 0n) throw new Error(`Incomplete Transfer history for ${coinAddress}; rebuild holder index from mint`);
    if (prior) await db.holderBalance.update({ where: key, data: { balance: next.toString() } });
    else await db.holderBalance.create({ data: { coinAddress, holder, balance: next.toString() } });
  }
}

// ---- block-timestamp cache (fallback for callers without a page context) ----
const tsCache = new Map<string, Date>();
async function blockTime(blockNumber: bigint, ctx?: PageContext): Promise<Date> {
  const k = blockNumber.toString();
  const pre = ctx?.blocks.get(k);
  if (pre) return pre.ts;
  const hit = tsCache.get(k);
  if (hit) return hit;
  const b = await client.getBlock({ blockNumber });
  const d = new Date(Number(b.timestamp) * 1000);
  tsCache.set(k, d);
  if (tsCache.size > 5000) tsCache.clear();
  return d;
}

// ---- USD pricing (fail closed) ----
// Returns the configured USD price of a quote asset, or null when none is configured. Callers must
// write null USD fields in that case: a placeholder (0 or a fixed ETH price) would be a wrong number
// served to the board, not a missing one.
function quoteUsdFor(quote: string): number | null {
  const q = lc(quote);
  if (q === cfg.weth) return typeof cfg.ethUsd === "number" && cfg.ethUsd > 0 ? cfg.ethUsd : null;
  const v = (cfg as any).quoteUsd?.[q];
  return typeof v === "number" && v > 0 ? v : null;
}

// ---- derived fields ----
function derive(coin: {
  virtualQuote: string; tokenReserve: string; virtualTokenOffset?: string; realQuote: string; graduationQuote: string;
  decimals: number; quote: string; totalSupply: string; quoteDecimals?: number;
}) {
  const vq = Number(coin.virtualQuote);
  const tr = Number(BigInt(coin.tokenReserve) + BigInt(coin.virtualTokenOffset ?? "0"));
  const qd = coin.quoteDecimals ?? 18;
  const decFactor = 10 ** (coin.decimals - qd); // human quote per human token
  const priceQuote = tr > 0 ? (vq / tr) * decFactor : 0; // quote per token (human)
  const quoteUsd = quoteUsdFor(coin.quote);
  const priceUsd = quoteUsd == null ? null : priceQuote * quoteUsd;
  const supplyHuman = Number(coin.totalSupply) / 10 ** coin.decimals;
  const marketCapUsd = priceUsd == null ? null : priceUsd * supplyHuman;
  const gq = BigInt(coin.graduationQuote || "0");
  const rq = BigInt(coin.realQuote || "0");
  const progressBps = gq > 0n ? Number((rq >= gq ? 10000n : (rq * 10000n) / gq)) : 0;
  return { priceQuote, priceUsd, marketCapUsd, progressBps };
}

// ---- handlers ----
// Shared by both curves: the V3 event names the holder share `holdersBps`, the V4 one names the
// extra reflection fee `reflectionBps`. `product` records which curve the coin lives on.
async function onRegistered(log: any, db: Db, notify: Notify, ctx?: PageContext, product: "v3" | "v4" = log._src === "curveV4" ? "v4" : "v3") {
  const coin = lc(log.args.coin as string);
  const quote = lc(log.args.quote as string);
  const vault = lc(log.args.vault as string);
  const isV2 = vault !== ZERO;

  // Token metadata is immutable, so it is read at `latest` (no archive node needed) before the
  // transaction; the fallback path serves callers that process a single log without a page context.
  const meta = ctx?.tokenMeta.get(coin) ?? (await readTokenMeta(coin));
  const { name, symbol, decimals, totalSupply } = meta;

  // Meme pairs are quoted in another Census coin: show its symbol, use ITS decimals, flag it for the UI.
  const quoteCoin = await db.coin.findUnique({ where: { address: quote } });
  const quoteSymbol = quote === cfg.weth ? "ETH" : quoteCoin?.symbol ?? quote;
  const quoteDecimals = quoteCoin?.decimals ?? 18; // WETH/HOOD are 18-dec; company-coin quotes carry their own
  const base = {
    name, symbol, decimals, totalSupply,
    creator: lc(log.args.creator as string),
    quote, quoteSymbol, quoteDecimals, quoteIsCoin: !!quoteCoin,
    vault: isV2 ? vault : null,
    holdersBps: product === "v4" ? 0 : Number(log.args.holdersBps),
    reflectionBps: product === "v4" ? Number(log.args.reflectionBps) : 0,
    product,
    isV2,
    virtualQuote: (log.args.virtualQuote as bigint).toString(),
    tokenReserve: totalSupply, // only real tokens seed the curve
    virtualTokenOffset: (log.args.virtualTokenOffset ?? 0n).toString(), // legacy event => original math
    realQuote: "0",
    graduationQuote: (log.args.graduationQuote as bigint).toString(),
    graduated: false,
    createdBlock: log.blockNumber as bigint,
    createdAt: await blockTime(log.blockNumber, ctx),
  };
  const d = derive(base);
  const row = await db.coin.upsert({
    where: { address: coin },
    create: { address: coin, ...base, ...d, holdersIndexed: !!ctx?.tokenMap.has(coin), volumeUsd: quoteUsdFor(quote) == null ? null : 0 },
    update: { ...base, ...d, holdersIndexed: !!ctx?.tokenMap.has(coin) },
  });
  notify({ type: "coin", data: serializeCoin(row) });
}

async function readTokenMeta(coin: string): Promise<TokenMeta> {
  const a = coin as `0x${string}`;
  const [n, s, d, ts] = await Promise.all([
    client.readContract({ address: a, abi: erc20Abi, functionName: "name" }),
    client.readContract({ address: a, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: a, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: a, abi: erc20Abi, functionName: "totalSupply" }),
  ]);
  return { name: n as string, symbol: s as string, decimals: Number(d), totalSupply: (ts as bigint).toString() };
}

// Same shape on both curves; a V4 Traded carries its FeeAllocated split in log._fee (paired in prefetch).
async function onTraded(log: any, db: Db, notify: Notify, ctx?: PageContext) {
  const coin = lc(log.args.coin as string);
  const c = await db.coin.findUnique({ where: { address: coin } });
  if (!c) throw new Error(`Missing registration for ${coin}; refusing to skip trade`);
  const existing = await db.trade.findUnique({ where: { txHash_logIndex: { txHash: log.transactionHash, logIndex: Number(log.logIndex) } } });
  if (existing) return;

  const isBuy = Boolean(log.args.isBuy);
  const amountIn = log.args.amountIn as bigint;
  const amountOut = log.args.amountOut as bigint;
  const fee = log.args.fee as bigint;
  const split: FeeSplit | undefined = log._fee;

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
  const qd = (c as any).quoteDecimals ?? 18;
  const decFactor = 10 ** (c.decimals - qd);
  const tradePrice = Number(tokenSide) > 0 ? (Number(grossQuote) / Number(tokenSide)) * decFactor : 0;
  const volAdd = Number(grossQuote) / 10 ** qd;
  const ts = await blockTime(log.blockNumber as bigint, ctx);

  const tradeRow = {
    coinAddress: coin, trader: lc(log.args.trader as string), isBuy,
    amountIn: amountIn.toString(), amountOut: amountOut.toString(), fee: fee.toString(), ...feeColumns(split),
    priceQuote: tradePrice, block: log.blockNumber as bigint, txHash: log.transactionHash as string,
    logIndex: Number(log.logIndex), ts,
  };
  await db.trade.upsert({
    where: { txHash_logIndex: { txHash: log.transactionHash as string, logIndex: Number(log.logIndex) } },
    create: tradeRow,
    update: {},
  });

  const merged = { ...c, virtualQuote: vq.toString(), tokenReserve: tr.toString(), realQuote: rq.toString() };
  const d = derive(merged);
  const row = await db.coin.update({
    where: { address: coin },
    data: {
      virtualQuote: vq.toString(), tokenReserve: tr.toString(), realQuote: rq.toString(),
      ...d, volumeQuote: c.volumeQuote + volAdd, volumeUsd: addVolumeUsd(c.volumeUsd, volAdd, quoteUsdFor(c.quote)),
      tradeCount: c.tradeCount + 1,
    },
  });
  await db.pricePoint.create({ data: { coinAddress: coin, priceQuote: tradePrice, priceUsd: d.priceUsd, block: log.blockNumber as bigint, ts } });
  notify({ type: "trade", data: { coin, trader: tradeRow.trader, isBuy, amountIn: tradeRow.amountIn, amountOut: tradeRow.amountOut, fee: tradeRow.fee, feeProtocol: tradeRow.feeProtocol, feeCreator: tradeRow.feeCreator, feeHolders: tradeRow.feeHolders, feePenalty: tradeRow.feePenalty, priceQuote: tradePrice, venue: "curve", ts } });
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

// V4: the coin migrates into the canonical hooked pool identified by poolId (no pool address).
async function onGraduatedV4(log: any, db: Db, notify: Notify) {
  const coin = lc(log.args.coin as string);
  const row = await db.coin.update({
    where: { address: coin },
    data: { graduated: true, poolId: lc(log.args.poolId as string), progressBps: 10000 },
  });
  notify({ type: "graduate", data: serializeCoin(row) });
}

// ---- post-graduation handlers ----
// Spot price from a pool's sqrtPriceX96 (token1 per token0), oriented to quote-per-token (human units).
function poolPrice(c: { address: string; quote: string; decimals: number; quoteDecimals?: number | null }, sqrtPriceX96: bigint) {
  const tokenIsToken0 = BigInt(c.address) < BigInt(c.quote);
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const p01 = s * s;
  const priceRaw = tokenIsToken0 ? p01 : p01 > 0 ? 1 / p01 : 0;
  const qd = c.quoteDecimals ?? 18;
  return { tokenIsToken0, qd, priceQuote: priceRaw * 10 ** (c.decimals - qd) };
}

async function applyPoolTrade(c: any, t: {
  trader: string; isBuy: boolean; amountIn: bigint; amountOut: bigint; fee: bigint; split?: FeeSplit;
  grossQuote: bigint; priceQuote: number; qd: number;
}, log: any, db: Db, notify: Notify, ctx?: PageContext) {
  const volAdd = Number(t.grossQuote) / 10 ** t.qd;
  const ts = await blockTime(log.blockNumber as bigint, ctx);
  const tradeRow = {
    coinAddress: c.address, trader: t.trader, isBuy: t.isBuy,
    amountIn: t.amountIn.toString(), amountOut: t.amountOut.toString(), fee: t.fee.toString(), ...feeColumns(t.split),
    priceQuote: t.priceQuote, venue: "pool", block: log.blockNumber as bigint, txHash: log.transactionHash as string,
    logIndex: Number(log.logIndex), ts,
  };
  await db.trade.upsert({
    where: { txHash_logIndex: { txHash: log.transactionHash as string, logIndex: Number(log.logIndex) } },
    create: tradeRow,
    update: {},
  });
  const quoteUsd = quoteUsdFor(c.quote);
  const priceUsd = quoteUsd == null ? null : t.priceQuote * quoteUsd;
  const marketCapUsd = priceUsd == null ? null : priceUsd * (Number(c.totalSupply) / 10 ** c.decimals);
  const row = await db.coin.update({
    where: { address: c.address },
    data: {
      priceQuote: t.priceQuote, priceUsd, marketCapUsd,
      volumeQuote: c.volumeQuote + volAdd, volumeUsd: addVolumeUsd(c.volumeUsd, volAdd, quoteUsd),
      tradeCount: c.tradeCount + 1,
    },
  });
  await db.pricePoint.create({ data: { coinAddress: c.address, priceQuote: t.priceQuote, priceUsd, block: log.blockNumber as bigint, ts } });
  notify({ type: "trade", data: { coin: c.address, trader: t.trader, isBuy: t.isBuy, amountIn: tradeRow.amountIn, amountOut: tradeRow.amountOut, fee: tradeRow.fee, feeProtocol: tradeRow.feeProtocol, feeCreator: tradeRow.feeCreator, feeHolders: tradeRow.feeHolders, feePenalty: tradeRow.feePenalty, priceQuote: t.priceQuote, venue: "pool", ts } });
  notify({ type: "coin", data: serializeCoin(row) });
}

// V3 locked pool: deltas are the POOL's balance deltas (positive = paid into the pool).
async function onPoolSwap(log: any, coinAddress: string, db: Db, notify: Notify, ctx?: PageContext) {
  const c = await db.coin.findUnique({ where: { address: coinAddress } });
  if (!c) throw new Error(`Missing registration for pool coin ${coinAddress}`);
  const { tokenIsToken0, qd, priceQuote } = poolPrice(c, log.args.sqrtPriceX96 as bigint);
  const a0 = log.args.amount0 as bigint;
  const a1 = log.args.amount1 as bigint;
  const quoteDelta = tokenIsToken0 ? a1 : a0;
  const tokenDelta = tokenIsToken0 ? a0 : a1;
  if (quoteDelta === 0n && tokenDelta === 0n) return;
  const isBuy = quoteDelta > 0n; // quote in, tokens out
  const amountIn = isBuy ? quoteDelta : tokenDelta;
  const amountOut = isBuy ? -tokenDelta : -quoteDelta;
  const grossQuote = quoteDelta < 0n ? -quoteDelta : quoteDelta;
  await applyPoolTrade(c, { trader: lc(log.args.recipient as string), isBuy, amountIn, amountOut, fee: 0n, grossQuote, priceQuote, qd }, log, db, notify, ctx);
}

// V4 canonical pool: PoolManager Swap deltas are the SWAPPER's balance deltas (negative = paid in).
// The hook's FeeAccrued for the same swap (paired in prefetch, log._fee) supplies the gross quote
// volume and the protocol/creator/holder split; Trade.fee = their sum (the swap's `fee` field is the
// LP fee tier, 0 on Census pools, and is not what traders pay).
async function onPoolSwapV4(log: any, coinAddress: string, db: Db, notify: Notify, ctx?: PageContext) {
  const c = await db.coin.findUnique({ where: { address: coinAddress } });
  if (!c) throw new Error(`Missing registration for V4 pool coin ${coinAddress}`);
  const { tokenIsToken0, qd, priceQuote } = poolPrice(c, log.args.sqrtPriceX96 as bigint);
  const a0 = log.args.amount0 as bigint;
  const a1 = log.args.amount1 as bigint;
  const quoteDelta = tokenIsToken0 ? a1 : a0; // swapper perspective
  const tokenDelta = tokenIsToken0 ? a0 : a1;
  if (quoteDelta === 0n && tokenDelta === 0n) return;
  const isBuy = quoteDelta < 0n; // swapper paid quote, received tokens
  const split: FeeSplit | undefined = log._fee;
  if (split && split.buy !== undefined && split.buy !== isBuy) throw new Error(`Hook FeeAccrued direction mismatch for ${coinAddress} in ${log.transactionHash}`);
  const feeTotal = split ? split.protocol + split.creator + split.holders : 0n;
  let amountIn: bigint, amountOut: bigint, grossQuote: bigint;
  if (isBuy) {
    // The hook took its fee from the specified quote input before the pool swap: deltas are net.
    grossQuote = split?.gross ?? -quoteDelta;
    amountIn = grossQuote; amountOut = tokenDelta;
  } else {
    // The pool paid the gross quote; the hook took its fee from that output.
    grossQuote = quoteDelta;
    amountIn = -tokenDelta; amountOut = quoteDelta - feeTotal;
  }
  await applyPoolTrade(c, { trader: lc(log.args.sender as string), isBuy, amountIn, amountOut, fee: feeTotal, split, grossQuote, priceQuote, qd }, log, db, notify, ctx);
}

async function onVaultEvent(log: any, coinAddress: string, quote: string, db: Db, notify: Notify, ctx?: PageContext) {
  const ts = await blockTime(log.blockNumber as bigint, ctx);
  const base = { coinAddress, block: log.blockNumber as bigint, txHash: log.transactionHash as string, logIndex: Number(log.logIndex), ts };
  let data: any;
  if (log.eventName === "Distributed") {
    data = { ...base, kind: "distributed", asset: quote, amount: (log.args.quoteSpent as bigint).toString() };
  } else if (log.eventName === "Claimed") {
    data = { ...base, kind: "claimed", holder: lc(log.args.holder as string), asset: lc((log.args.asset ?? log.args.stock) as string), amount: (log.args.amount as bigint).toString() };
  } else if (log.eventName === "LaunchFeesConverted") {
    data = { ...base, kind: "converted", asset: quote, amount: (log.args.tokenIn as bigint).toString(), amountB: (log.args.quoteOut as bigint).toString() };
  } else if (log.eventName === "FeesClaimed") {
    // Hook fees pushed to the coin's reward vault (kind "collected"); payouts to treasury/creator are not indexed.
    data = { ...base, kind: "collected", asset: lc(log.args.asset as string), amount: (log.args.amount as bigint).toString() };
  } else {
    throw new Error("Unrecognized vault event");
  }
  await db.rewardEvent.upsert({
    where: { txHash_logIndex: { txHash: base.txHash, logIndex: base.logIndex } },
    create: data, update: {},
  });
  notify({ type: "reward", data: { ...data, block: base.block.toString() } });
}

async function processLog(log: any, db: Db, notify: Notify, ctx?: PageContext) {
  if (log.eventName === "Registered") return onRegistered(log, db, notify, ctx, "v3");
  if (log.eventName === "Traded") return onTraded(log, db, notify, ctx);
  if (log.eventName === "Graduated") return onGraduated(log, db, notify);
  throw new Error("Unrecognized curve event");
}

async function processLogV4(log: any, db: Db, notify: Notify, ctx?: PageContext) {
  if (log.eventName === "Registered") return onRegistered(log, db, notify, ctx, "v4");
  if (log.eventName === "Traded") return onTraded(log, db, notify, ctx);
  if (log.eventName === "Graduated") return onGraduatedV4(log, db, notify);
  throw new Error("Unrecognized V4 curve event");
}

// ---- fee pairing (pure; runs in prefetch) ----
// Attaches the fee split to the trade log it belongs to and drops the fee logs themselves (they are
// annotations, not state; receipts are written for state-changing events only).
//  - Curve V4: FeeAllocated(coin, isBuy, ...) is emitted inside the same buy/sell right before its
//    Traded, so for each (tx, coin) the queued FeeAllocated belongs to the next Traded with fee > 0.
//  - Pool: the hook emits exactly one FeeAccrued per Census-pool swap, before the PoolManager Swap on
//    buys and after it on sells, so the k-th Swap and the k-th FeeAccrued of a (tx, poolId) pair up.
function pairFees(logs: any[]): any[] {
  const out: any[] = [];
  const curveFees = new Map<string, any[]>();
  const swapsWaiting = new Map<string, any[]>();
  const accrualsWaiting = new Map<string, any[]>();
  const push = (m: Map<string, any[]>, k: string, v: any) => { const q = m.get(k); if (q) q.push(v); else m.set(k, [v]); };
  const attach = (swap: any, acc: any) => {
    const split: FeeSplit = { protocol: acc.args.protocolFee as bigint, creator: acc.args.creatorFee as bigint, holders: acc.args.holderFee as bigint, penalty: 0n, gross: acc.args.quoteVolume as bigint, buy: Boolean(acc.args.buy) };
    swap._fee = split;
  };
  for (const log of logs) {
    if (log._src === "curveV4" && log.eventName === "FeeAllocated") { push(curveFees, `${log.transactionHash}|${lc(log.args.coin)}`, log); continue; }
    if (log._src === "curveV4" && log.eventName === "Traded" && (log.args.fee as bigint) > 0n) {
      const f = curveFees.get(`${log.transactionHash}|${lc(log.args.coin)}`)?.shift();
      if (!f) throw new Error(`V4 Traded without FeeAllocated in ${log.transactionHash}`);
      const split: FeeSplit = { protocol: f.args.protocolFee, creator: f.args.creatorFee, holders: f.args.holderFee, penalty: f.args.penalty };
      if (Boolean(f.args.isBuy) !== Boolean(log.args.isBuy) || split.protocol + split.creator + split.holders !== (log.args.fee as bigint)) throw new Error(`FeeAllocated does not match Traded in ${log.transactionHash}`);
      log._fee = split;
    }
    if (log._src === "poolManager" && log.eventName === "Swap") {
      const k = `${log.transactionHash}|${lc(log.args.id)}`;
      const acc = accrualsWaiting.get(k)?.shift();
      if (acc) attach(log, acc); else push(swapsWaiting, k, log);
    }
    if (log._src === "hook" && log.eventName === "FeeAccrued") {
      const k = `${log.transactionHash}|${lc(log.args.poolId)}`;
      const swap = swapsWaiting.get(k)?.shift();
      if (swap) attach(swap, log); else push(accrualsWaiting, k, log);
      continue;
    }
    out.push(log);
  }
  if (cfg.hook) {
    for (const [k, q] of swapsWaiting) if (q.length) throw new Error(`V4 pool swap without hook FeeAccrued (${k})`);
  }
  return out;
}

// ---- cursor + loops ----
async function getCursor(): Promise<bigint> {
  const c = await prisma.cursor.findUnique({ where: { id: CURSOR_ID } });
  return c ? c.lastBlock : cfg.startBlock - 1n;
}

const byPosition = (a: any, b: any) => (a.blockNumber === b.blockNumber ? Number(a.logIndex) - Number(b.logIndex) : Number(a.blockNumber - b.blockNumber));
const tag = (logs: any[], _src: Source) => logs.map((l: any) => ({ ...l, _src }));

// Phase 1 (no database lock held): read everything the page needs from the chain and validate it
// against the canonical chain. All RPC failures propagate; nothing has been written yet.
async function prefetchPage(from: bigint, to: bigint): Promise<PageContext> {
  // The checkpoint must still be canonical before we build on it.
  const cursor = await prisma.cursor.findUnique({ where: { id: CURSOR_ID } });
  if (cursor) {
    if (cursor.chainId !== cfg.chainId || cursor.curve !== IDENTITY || !cursor.lastHash) throw new Error("Database identity/hash missing or mismatched; rebuild from a verified checkpoint");
    const previous = await client.getBlock({ blockNumber: cursor.lastBlock });
    if (previous.hash !== cursor.lastHash) throw new Error("Reorg at indexed checkpoint; stop and rebuild before resuming");
  }
  const anchor = await client.getBlock({ blockNumber: to });
  const curveLogs: any[] = cfg.curve ? tag(await client.getLogs({ address: cfg.curve, events: EVENTS as any, fromBlock: from, toBlock: to }), "curve") : [];
  const curveV4Logs: any[] = cfg.curveV4 ? tag(await client.getLogs({ address: cfg.curveV4, events: V4_EVENTS as any, fromBlock: from, toBlock: to }), "curveV4") : [];
  const logs = [...curveLogs, ...curveV4Logs].sort(byPosition);

  // Post-graduation coverage: this page's events from the graduated pools and vaults of every
  // indexed coin — including coins registered/graduated within THIS page, so a swap or reward
  // landing right after graduation is never skipped.
  const known = await prisma.coin.findMany({ select: { address: true, pool: true, poolId: true, vault: true, quote: true } });
  const poolMap = new Map<string, string>();
  const poolIdMap = new Map<string, string>();
  const vaultMap = new Map<string, { coin: string; quote: string }>();
  for (const k of known) {
    if (k.pool) poolMap.set(lc(k.pool), k.address);
    if (k.poolId) poolIdMap.set(lc(k.poolId), k.address);
    if (k.vault) vaultMap.set(lc(k.vault), { coin: k.address, quote: k.quote });
  }
  for (const log of logs) {
    if (log.eventName === "Graduated" && log._src === "curve") poolMap.set(lc(log.args.pool), lc(log.args.coin));
    if (log.eventName === "Graduated" && log._src === "curveV4") poolIdMap.set(lc(log.args.poolId), lc(log.args.coin));
    if (log.eventName === "Registered" && lc(log.args.vault) !== ZERO) vaultMap.set(lc(log.args.vault), { coin: lc(log.args.coin), quote: lc(log.args.quote) });
  }
  // Include tokens registered inside this page: mint/creator-buy Transfer logs may precede Registered.
  const tokenMap = new Set<string>([...known.map((k) => lc(k.address)), ...logs.filter((l) => l.eventName === "Registered").map((l) => lc(l.args.coin))]);
  const tokenAddresses = [...tokenMap] as `0x${string}`[];
  const transferLogs: any[] = [];
  for (let i = 0; i < tokenAddresses.length; i += 100) {
    transferLogs.push(...tag(await client.getLogs({ address: tokenAddresses.slice(i, i + 100), event: TOKEN_TRANSFER, fromBlock: from, toBlock: to }) as any[], "token"));
  }
  const extAddrs = [...poolMap.keys(), ...vaultMap.keys()];
  const extLogs: any[] = extAddrs.length
    ? (await client.getLogs({ address: extAddrs as `0x${string}`[], events: EXT_EVENTS as any, fromBlock: from, toBlock: to }))
        .map((l: any) => ({ ...l, _src: poolMap.has(lc(l.address)) ? "pool" : "vault" }))
    : [];
  // V4: PoolManager swaps of the indexed pools (topic1 = poolId) and the hook's fee events.
  const poolIds = [...poolIdMap.keys()] as `0x${string}`[];
  const pmLogs: any[] = cfg.poolManager && poolIds.length
    ? tag((await client.getLogs({ address: cfg.poolManager, event: PM_SWAP, args: { id: poolIds }, fromBlock: from, toBlock: to }) as any[])
        .filter((l: any) => l.eventName === "Swap" && poolIdMap.has(lc(l.args.id))), "poolManager")
    : [];
  const hookLogs: any[] = cfg.hook && (poolIds.length || vaultMap.size)
    ? tag((await client.getLogs({ address: cfg.hook, events: HOOK_EVENTS as any, fromBlock: from, toBlock: to }) as any[])
        .filter((l: any) => (l.eventName === "FeeAccrued" && poolIdMap.has(lc(l.args.poolId))) || (l.eventName === "FeesClaimed" && vaultMap.has(lc(l.args.recipient)))), "hook")
    : [];
  const all = [...logs, ...transferLogs, ...extLogs, ...pmLogs, ...hookLogs].sort(byPosition);

  // One getBlock per distinct block: canonical hash check + timestamp, shared by every handler.
  const blocks = new Map<string, { hash: string; ts: Date }>();
  for (const log of all) {
    if (!log.blockHash || !log.transactionHash || log.removed || log.blockNumber < from || log.blockNumber > to) throw new Error("Invalid/unconfirmed event");
    const k = (log.blockNumber as bigint).toString();
    if (!blocks.has(k)) {
      const b = await client.getBlock({ blockNumber: log.blockNumber });
      blocks.set(k, { hash: b.hash as string, ts: new Date(Number(b.timestamp) * 1000) });
    }
    if (blocks.get(k)!.hash !== log.blockHash) throw new Error("Event block hash is not canonical");
  }
  // Immutable token metadata for new registrations (read at latest; no archive node required).
  const tokenMeta = new Map<string, TokenMeta>();
  for (const log of all) {
    if ((log._src !== "curve" && log._src !== "curveV4") || log.eventName !== "Registered") continue;
    const coin = lc(log.args.coin as string);
    if (!tokenMeta.has(coin)) tokenMeta.set(coin, await readTokenMeta(coin));
  }
  const check = await client.getBlock({ blockNumber: to });
  if (!anchor.hash || anchor.hash !== check.hash) throw new Error("Chain changed while reading page");
  return { from, to, anchorHash: anchor.hash as string, logs: pairFees(all), blocks, tokenMeta, poolMap, poolIdMap, vaultMap, tokenMap };
}

// Phase 2: apply the prefetched page in ONE serializable transaction (receipts, writes and cursor).
// No network calls happen in here.
async function commitPage(page: PageContext): Promise<Update[]> {
  const { from, to } = page;
  return prisma.$transaction(async (db) => {
    // Serializes workers sharing this database; rollback includes event receipts and cursor.
    await db.$executeRaw`SELECT pg_advisory_xact_lock(1128615507)`;
    const cursor = await db.cursor.findUnique({ where: { id: CURSOR_ID } });
    if (cursor && cursor.lastBlock >= to) return [];
    if ((cursor ? cursor.lastBlock + 1n : cfg.startBlock) !== from) throw new Error("Cursor changed; retry page");
    if (cursor && (cursor.chainId !== cfg.chainId || cursor.curve !== IDENTITY || !cursor.lastHash)) throw new Error("Database identity/hash missing or mismatched; rebuild from a verified checkpoint");

    const pending: Update[] = [];
    const notify = (u: Update) => pending.push(u);
    for (const log of page.logs) {
      if (page.blocks.get((log.blockNumber as bigint).toString())?.hash !== log.blockHash) throw new Error("Event block hash is not canonical");
      const receipt = await db.indexedEvent.createMany({ data: [{ chainId: cfg.chainId, txHash: log.transactionHash, logIndex: Number(log.logIndex), block: log.blockNumber, blockHash: log.blockHash }], skipDuplicates: true });
      if (!receipt.count) continue;
      const addr = typeof log.address === "string" ? lc(log.address) : "";
      const src: Source = log._src;
      if (src === "curve") await processLog(log, db, notify, page);
      else if (src === "curveV4") await processLogV4(log, db, notify, page);
      else if (src === "pool" && log.eventName === "Swap" && page.poolMap.has(addr)) await onPoolSwap(log, page.poolMap.get(addr)!, db, notify, page);
      else if (src === "vault" && page.vaultMap.has(addr)) await onVaultEvent(log, page.vaultMap.get(addr)!.coin, page.vaultMap.get(addr)!.quote, db, notify, page);
      else if (src === "poolManager" && log.eventName === "Swap" && page.poolIdMap.has(lc(log.args.id))) await onPoolSwapV4(log, page.poolIdMap.get(lc(log.args.id))!, db, notify, page);
      else if (src === "hook" && log.eventName === "FeesClaimed" && page.vaultMap.has(lc(log.args.recipient))) { const v = page.vaultMap.get(lc(log.args.recipient))!; await onVaultEvent(log, v.coin, v.quote, db, notify, page); }
      else if (src === "token" && log.eventName === "Transfer" && page.tokenMap.has(addr)) await onTokenTransfer(log, db);
      else throw new Error("Event from unwatched address");
    }
    const data = { lastBlock: to, lastHash: page.anchorHash, chainId: cfg.chainId, curve: IDENTITY };
    await db.cursor.upsert({ where: { id: CURSOR_ID }, create: { id: CURSOR_ID, ...data }, update: data });
    return pending;
  }, { isolationLevel: "Serializable", timeout: 60000, maxWait: 10000 });
}

// Adaptive page size: an RPC that caps log ranges (or a page too dense to fetch) halves the
// attempted range and grows back after successes; a single-block failure is a real outage and
// propagates as before (the live loop retries from the durable cursor).
let pageSize = cfg.logPage;

async function scan(fromBlock: bigint, toBlock: bigint) {
  if (cfg.logPage <= 0n) throw new Error("LOG_PAGE must be positive");
  let from = fromBlock;
  while (from <= toBlock) {
    const to = from + pageSize - 1n > toBlock ? toBlock : from + pageSize - 1n;
    let page: PageContext;
    try {
      page = await prefetchPage(from, to);
    } catch (e: any) {
      const range = to - from + 1n;
      if (range > 1n) {
        pageSize = range / 2n;
        console.error(`[ingest] page ${from}-${to} failed (${e?.shortMessage ?? e?.message ?? e}); retrying with LOG_PAGE=${pageSize}`);
        continue;
      }
      throw e;
    }
    const updates = await commitPage(page);
    // Clients only see durable state; a broken socket cannot undo or prevent indexing.
    for (const update of updates) { try { publish(update); } catch { console.error("[ingest] update delivery failed"); } }
    ingestion.lastBlock = to.toString();
    ingestion.lastSuccessAt = Date.now(); // each committed page is progress: /health stays truthful during backfill
    ingestion.error = null;
    if (pageSize < cfg.logPage) pageSize = pageSize * 2n > cfg.logPage ? cfg.logPage : pageSize * 2n;
    from = to + 1n;
  }
}

// Once a coin's USD volume is unknown it stays null (a partial sum would understate it) until a rebuild.
function addVolumeUsd(current: number | null | undefined, volAdd: number, quoteUsd: number | null): number | null {
  if (current == null || quoteUsd == null) return null;
  return current + volAdd * quoteUsd;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runIngest() {
  console.log(`[ingest] curve=${cfg.curve ? getAddress(cfg.curve) : "off"} curveV4=${cfg.curveV4 ? getAddress(cfg.curveV4) : "off"} poolManager=${cfg.poolManager ?? "off"} hook=${cfg.hook ?? "off"} chain=${cfg.chainId}`);
  if (cfg.curveV4 && (!cfg.poolManager || !cfg.hook)) console.warn("[ingest] CURVE_V4_ADDRESS is set without POOL_MANAGER_ADDRESS/HOOK_ADDRESS: post-graduation V4 pool trades and hook fees will not be indexed.");
  if (cfg.ethUsd == null) console.warn("[ingest] ETH_USD is not set: USD price/mcap/volume are reported as null for ETH-quoted coins (fail closed). Set ETH_USD (and QUOTE_USD for other quotes) from a verified source before the board reads this indexer.");
  if (await client.getChainId() !== cfg.chainId) throw new Error("RPC chain ID mismatch");
  for (;;) {
    try {
      const cursor = await getCursor();
      const finalized = await client.getBlock({ blockTag: "finalized" });
      const head = finalized.number;
      if (head === null) throw new Error("Finalized block unavailable");
      // Check the checkpoint even when no new finalized blocks arrive.
      const checkpoint = await prisma.cursor.findUnique({ where: { id: CURSOR_ID } });
      if (checkpoint && (checkpoint.chainId !== cfg.chainId || checkpoint.curve !== IDENTITY || !checkpoint.lastHash || (await client.getBlock({ blockNumber: checkpoint.lastBlock })).hash !== checkpoint.lastHash)) throw new Error("Checkpoint identity or canonical hash mismatch; rebuild required");
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
    totalSupply: c.totalSupply, creator: c.creator, quote: c.quote, quoteSymbol: c.quoteSymbol, quoteDecimals: c.quoteDecimals ?? 18, quoteIsCoin: c.quoteIsCoin ?? false,
    vault: c.vault, holdersBps: c.holdersBps, isV2: c.isV2,
    product: c.product ?? "v3", reflectionBps: c.reflectionBps ?? 0,
    virtualQuote: c.virtualQuote, tokenReserve: c.tokenReserve, virtualTokenOffset: c.virtualTokenOffset ?? "0", realQuote: c.realQuote,
    graduationQuote: c.graduationQuote, graduated: c.graduated, pool: c.pool ?? null, poolId: c.poolId ?? null, progressBps: c.progressBps,
    priceQuote: c.priceQuote, priceUsd: c.priceUsd, marketCapUsd: c.marketCapUsd,
    volumeQuote: c.volumeQuote, volumeUsd: c.volumeUsd, tradeCount: c.tradeCount,
    createdBlock: c.createdBlock?.toString?.() ?? String(c.createdBlock ?? "0"), holdersIndexed: c.holdersIndexed ?? false,
    createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}
