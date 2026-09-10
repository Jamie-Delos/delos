import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { prisma } from "./db.js";
import { cfg } from "./config.js";
import { bus, type Update } from "./bus.js";
import { serializeCoin } from "./ingest.js";

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const serializeTrade = (t: any) => ({
  coin: t.coinAddress, trader: t.trader, isBuy: t.isBuy,
  amountIn: t.amountIn, amountOut: t.amountOut, fee: t.fee,
  priceQuote: t.priceQuote, block: t.block?.toString?.() ?? String(t.block), txHash: t.txHash, ts: t.ts,
});

export async function runApi() {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: cfg.corsOrigin });
  await app.register(websocket);

  app.get("/health", async () => ({ ok: true, chainId: cfg.chainId, curve: cfg.curve }));

  // Board: list coins. sort=new|mcap|volume, optional graduated filter.
  app.get("/coins", async (req) => {
    const q = req.query as Record<string, string>;
    const limit = clamp(Number(q.limit ?? 50), 1, 200);
    const sort = q.sort ?? "new";
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
    const limit = clamp(Number(q.limit ?? 50), 1, 200);
    const rows = await prisma.trade.findMany({
      where: { coinAddress: address.toLowerCase() }, orderBy: { ts: "desc" }, take: limit,
    });
    return { trades: rows.map(serializeTrade) };
  });

  app.get("/coins/:address/chart", async (req) => {
    const { address } = req.params as { address: string };
    const q = req.query as Record<string, string>;
    const limit = clamp(Number(q.limit ?? 500), 1, 2000);
    const rows = await prisma.pricePoint.findMany({
      where: { coinAddress: address.toLowerCase() }, orderBy: { ts: "asc" }, take: limit,
    });
    return { points: rows.map((p) => ({ t: p.ts, priceQuote: p.priceQuote, priceUsd: p.priceUsd })) };
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
    const onUpdate = (u: Update) => { try { socket.send(JSON.stringify(u)); } catch { /* client gone */ } };
    bus.on("update", onUpdate);
    socket.on("close", () => bus.off("update", onUpdate));
    try { socket.send(JSON.stringify({ type: "hello", data: { chainId: cfg.chainId } })); } catch { /* noop */ }
  });

  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  console.log(`[api] listening on :${cfg.port} (cors ${cfg.corsOrigin})`);
}
