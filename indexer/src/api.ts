import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { prisma } from "./db.js";
import { cfg } from "./config.js";
import { bus, type Update } from "./bus.js";
import { serializeCoin } from "./ingest.js";
import { ingestion } from "./status.js";
import rateLimit from "@fastify/rate-limit";

function limitOf(value: string | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1 || n > maximum) {
    throw Object.assign(new Error(`limit must be an integer from 1 to ${maximum}`), { statusCode: 400 });
  }
  return n;
}
const serializeTrade = (t: any) => ({
  coin: t.coinAddress, trader: t.trader, isBuy: t.isBuy,
  amountIn: t.amountIn, amountOut: t.amountOut, fee: t.fee,
  priceQuote: t.priceQuote, block: t.block?.toString?.() ?? String(t.block), txHash: t.txHash, ts: t.ts,
});

export async function runApi() {
  const app = Fastify({ logger: false, requestTimeout: 15000, bodyLimit: 16384 });
  await app.register(cors, { origin: cfg.corsOrigin });
  await app.register(websocket);
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  app.get("/live", async () => ({ ok: true }));
  app.get("/health", async (_req, reply) => {
    let database = false;
    try { await prisma.$queryRaw`SELECT 1`; database = true; } catch { /* unavailable */ }
    const ok = database && !ingestion.error && Date.now() - ingestion.lastSuccessAt < Math.max(60000, cfg.pollMs * 3);
    return reply.code(ok ? 200 : 503).send({ ok, database, chainId: cfg.chainId, curve: cfg.curve, finalizedBlock: ingestion.lastBlock, ingestionError: ingestion.error });
  });

  // Board: list coins. sort=new|mcap|volume, optional graduated filter.
  app.get("/coins", async (req) => {
    const q = req.query as Record<string, string>;
    const limit = limitOf(q.limit, 50, 200);
    const sort = q.sort ?? "new";
    if (!["new", "mcap", "volume", "active"].includes(sort) || q.graduated !== undefined && !["true", "false"].includes(q.graduated)) throw Object.assign(new Error("invalid filter"), { statusCode: 400 });
    const orderBy =
      sort === "mcap" ? { marketCapUsd: "desc" as const }
      : sort === "volume" ? { volumeQuote: "desc" as const }
      : sort === "active" ? { updatedAt: "desc" as const }
      : { createdAt: "desc" as const };
    const where = q.graduated === undefined ? {} : { graduated: q.graduated === "true" };
    const rows = await prisma.coin.findMany({ where, orderBy, take: limit });
    return { coins: rows.map(serializeCoin) };
  });

  app.get("/coins/:address", async (req, reply) => {
    const { address } = req.params as { address: string };
    const row = await prisma.coin.findUnique({ where: { address: address.toLowerCase() } });
    if (!row) return reply.code(404).send({ error: "not found" });
    return { coin: serializeCoin(row) };
  });

  app.get("/coins/:address/trades", async (req) => {
    const { address } = req.params as { address: string };
    const q = req.query as Record<string, string>;
    const limit = limitOf(q.limit, 50, 200);
    const rows = await prisma.trade.findMany({
      where: { coinAddress: address.toLowerCase() }, orderBy: { ts: "desc" }, take: limit,
    });
    return { trades: rows.map(serializeTrade) };
  });

  app.get("/coins/:address/chart", async (req) => {
    const { address } = req.params as { address: string };
    const q = req.query as Record<string, string>;
    const limit = limitOf(q.limit, 500, 2000);
    const rows = await prisma.pricePoint.findMany({
      where: { coinAddress: address.toLowerCase() }, orderBy: [{ ts: "desc" }, { id: "desc" }], take: limit,
    });
    return { points: rows.reverse().map((p) => ({ t: p.ts, priceQuote: p.priceQuote, priceUsd: p.priceUsd })) };
  });

  app.get("/stats", async () => {
    const [coins, graduated, tradeCount] = await Promise.all([
      prisma.coin.count(), prisma.coin.count({ where: { graduated: true } }), prisma.trade.count(),
    ]);
    const vol = await prisma.coin.aggregate({ _sum: { volumeQuote: true, volumeUsd: true } });
    return { coins, graduated, tradeCount, volumeQuote: vol._sum.volumeQuote ?? 0, volumeUsd: vol._sum.volumeUsd ?? 0 };
  });

  // Live stream: new coins, trades, graduations.
  app.get("/ws", { websocket: true }, (socket) => {
    if (bus.listenerCount("update") >= 1000) { socket.close(1013, "capacity"); return; }
    const onUpdate = (u: Update) => {
      if (socket.bufferedAmount > 1024 * 1024) { socket.terminate(); return; }
      try { socket.send(JSON.stringify(u)); } catch { socket.terminate(); }
    };
    bus.on("update", onUpdate);
    socket.on("close", () => bus.off("update", onUpdate));
    socket.on("error", () => { bus.off("update", onUpdate); socket.terminate(); });
    try { socket.send(JSON.stringify({ type: "hello", data: { chainId: cfg.chainId } })); } catch { /* noop */ }
  });

  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  console.log(`[api] listening on :${cfg.port} (cors ${cfg.corsOrigin})`);
}
