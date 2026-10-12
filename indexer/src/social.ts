import { createPublicClient, defineChain, http, isAddress, parseAbi, type Hex } from "viem";
import type { FastifyInstance, FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import { cfg } from "./config.js";
import { prisma } from "./db.js";

const chain = defineChain({ id: cfg.chainId, name: `chain-${cfg.chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
const chainClient = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);
const ZERO = "0x0000000000000000000000000000000000000000";
const MIN_HOLDER_BPS = 50; // 0.5% of real totalSupply, not just circulating supply
const EDIT_WAIT_MS = 24 * 60 * 60 * 1000;
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
const lower = (s: string) => s.toLowerCase();
const bad = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });
const official = (coin: string, wallet: string) => (cfg.companyCalloutWallets[coin] ?? []).includes(wallet);

type Intent = { action: "post" | "like" | "unlike"; coin: string; wallet: string; text: string; target: string; issuedAt: number; nonce: string };
// Keep this message byte-for-byte identical to frontend/src/lib/callouts.ts.
function message(i: Intent) {
  return `Delos callout\nChain: ${cfg.chainId}\nCoin: ${i.coin}\nWallet: ${i.wallet}\nAction: ${i.action}\nTarget: ${i.target}\nText: ${i.text}\nIssued: ${i.issuedAt}\nNonce: ${i.nonce}`;
}

function parseIntent(body: unknown, action: Intent["action"], coin: string): (Intent & { signature: Hex }) | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  // Contract wallets (for example a company Safe) may return EIP-1271 signatures of variable length.
  if (typeof b.wallet !== "string" || !isAddress(b.wallet) || typeof b.signature !== "string" || !/^0x(?:[0-9a-fA-F]{2}){1,2048}$/.test(b.signature)) return null;
  if (typeof b.issuedAt !== "number" || !Number.isSafeInteger(b.issuedAt) || Math.abs(Date.now() - b.issuedAt) > SIGNATURE_WINDOW_MS) return null;
  if (typeof b.nonce !== "string" || !/^[0-9a-fA-F-]{36}$/.test(b.nonce)) return null;
  const text = action === "post" && typeof b.text === "string" ? b.text.trim() : "";
  if (action === "post" && (text.length < 20 || text.length > 1000)) return null;
  const target = action === "post" ? "-" : typeof b.target === "string" ? b.target : "";
  if (action !== "post" && (target.length < 1 || target.length > 64)) return null;
  return { action, coin, wallet: lower(b.wallet), text, target, issuedAt: b.issuedAt, nonce: b.nonce, signature: b.signature as Hex };
}

async function signed(i: Intent & { signature: Hex }) {
  try { return await chainClient.verifyMessage({ address: i.wallet as `0x${string}`, message: message(i), signature: i.signature }); }
  catch { return false; }
}

function systemHolders(coin: { address: string; vault: string | null; pool: string | null }) {
  return [...new Set([ZERO, coin.address, coin.vault, coin.pool, cfg.curve, cfg.curveV4, cfg.factory, cfg.factoryV2, cfg.factoryV4, cfg.poolManager, cfg.hook]
    .filter((a): a is string => !!a).map(lower))];
}

type ProfileFields = { displayName: string; bio: string; avatar: string; banner: string; x: string; telegram: string; website: string };
const publicProfile = (p: ProfileFields & { wallet: string; updatedAt: Date }) => ({
  wallet: p.wallet, displayName: p.displayName, bio: p.bio, avatar: p.avatar, banner: p.banner,
  x: p.x, telegram: p.telegram, website: p.website, updatedAt: p.updatedAt,
});
function profileUrl(raw: unknown, hosts?: string[]): string | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  if (!raw.trim()) return "";
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) return null;
    if (hosts && !hosts.some((h) => url.hostname === h)) return null;
    return url.toString().length <= 200 ? url.toString() : null;
  } catch { return null; }
}
function profileImage(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname.endsWith(".public.blob.vercel-storage.com") && !url.username && !url.password && url.toString().length <= 500 ? url.toString() : null;
  } catch { return null; }
}
function cleanProfile(raw: unknown): ProfileFields | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.displayName !== "string" || typeof p.bio !== "string" || p.displayName.length > 48 || p.bio.length > 500) return null;
  const avatar = profileImage(p.avatar), banner = profileImage(p.banner);
  const x = profileUrl(p.x, ["x.com", "www.x.com", "twitter.com", "www.twitter.com"]);
  const telegram = profileUrl(p.telegram, ["t.me", "telegram.me"]);
  const website = profileUrl(p.website);
  if ([avatar, banner, x, telegram, website].some((v) => v === null)) return null;
  return { displayName: p.displayName.trim(), bio: p.bio.trim(), avatar: avatar!, banner: banner!, x: x!, telegram: telegram!, website: website! };
}
// Keep byte-for-byte identical to frontend/src/lib/profiles.ts.
function profileMessage(wallet: string, profile: ProfileFields, issuedAt: number, nonce: string) {
  return `Delos profile\nChain: ${cfg.chainId}\nWallet: ${wallet}\nProfile: ${JSON.stringify(profile)}\nIssued: ${issuedAt}\nNonce: ${nonce}`;
}

export function registerSocialRoutes(app: FastifyInstance) {
  const prune = () => { void prisma.socialNonce.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - EDIT_WAIT_MS) } } }).catch(() => {}); };
  const pruneTimer = setInterval(prune, 60 * 60 * 1000);
  pruneTimer.unref();
  app.addHook("onClose", async () => { clearInterval(pruneTimer); });

  app.get("/profiles/:wallet", async (req, reply) => {
    const { wallet } = req.params as { wallet: string };
    if (!isAddress(wallet)) return bad(reply, 400, "Invalid wallet address");
    const row = await prisma.walletProfile.findUnique({ where: { wallet: lower(wallet) } });
    return { profile: row && !row.hidden ? publicProfile(row) : null };
  });

  app.put("/profiles/:wallet", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { wallet } = req.params as { wallet: string };
    if (!isAddress(wallet)) return bad(reply, 400, "Invalid wallet address");
    const body = req.body as Record<string, unknown> | null;
    const profile = cleanProfile(body?.profile);
    const issuedAt = body?.issuedAt, nonce = body?.nonce, signature = body?.signature;
    if (!profile || typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt) || Math.abs(Date.now() - issuedAt) > SIGNATURE_WINDOW_MS ||
      typeof nonce !== "string" || !/^[0-9a-fA-F-]{36}$/.test(nonce) || typeof signature !== "string" || !/^0x(?:[0-9a-fA-F]{2}){1,2048}$/.test(signature)) {
      return bad(reply, 400, "Invalid profile or signature payload");
    }
    const owner = lower(wallet);
    let valid = false;
    try { valid = await chainClient.verifyMessage({ address: owner as `0x${string}`, message: profileMessage(owner, profile, issuedAt, nonce), signature: signature as Hex }); }
    catch { /* fail closed */ }
    if (!valid) return bad(reply, 401, "Wallet signature did not verify");
    try {
      const row = await prisma.$transaction(async (db) => {
        await db.socialNonce.create({ data: { nonce, wallet: owner } });
        const prior = await db.walletProfile.findUnique({ where: { wallet: owner } });
        if (!prior) return db.walletProfile.create({ data: { wallet: owner, ...profile, signedAt: BigInt(issuedAt) } });
        if (prior.hidden) throw new Error("PROFILE_HIDDEN");
        const updated = await db.walletProfile.updateMany({ where: { wallet: owner, signedAt: { lt: BigInt(issuedAt) } }, data: { ...profile, signedAt: BigInt(issuedAt) } });
        if (!updated.count) throw new Error("STALE_PROFILE");
        return db.walletProfile.findUniqueOrThrow({ where: { wallet: owner } });
      }, { isolationLevel: "Serializable" });
      return { profile: publicProfile(row) };
    } catch (e) {
      if (e instanceof Error && e.message === "PROFILE_HIDDEN") return bad(reply, 403, "Profile unavailable");
      if (e instanceof Error && e.message === "STALE_PROFILE") return bad(reply, 409, "A newer profile edit was already saved");
      if (e instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(e.code)) return bad(reply, 409, "Profile edit collided; retry with a fresh signature");
      throw e;
    }
  });

  app.get("/coins/:address/holders", async (req, reply) => {
    const { address } = req.params as { address: string };
    if (!isAddress(address)) return bad(reply, 400, "Invalid coin address");
    const coin = await prisma.coin.findUnique({ where: { address: lower(address) } });
    if (!coin) return bad(reply, 404, "Coin not indexed");
    if (!coin.holdersIndexed) return { available: false, reason: "Transfer history must be rebuilt from the token mint before holder ranks can be shown", holders: [] };
    const where = { coinAddress: coin.address, holder: { notIn: systemHolders(coin) }, balance: { gt: 0 } };
    const [rows, count, cursor] = await Promise.all([
      prisma.holderBalance.findMany({ where, orderBy: { balance: "desc" }, take: 20 }),
      prisma.holderBalance.count({ where }),
      prisma.cursor.findUnique({ where: { id: "curve" } }),
    ]);
    const supply = BigInt(coin.totalSupply);
    return { available: true, asOfBlock: cursor?.lastBlock.toString() ?? null, totalHolders: count,
      holders: rows.map((r) => ({ wallet: r.holder, balance: r.balance.toString(), shareBps: supply > 0n ? Number((BigInt(r.balance.toString()) * 10000n) / supply) : 0 })) };
  });

  app.get("/coins/:address/callouts", async (req, reply) => {
    const { address } = req.params as { address: string };
    if (!isAddress(address)) return bad(reply, 400, "Invalid coin address");
    const coin = lower(address);
    if (!await prisma.coin.findUnique({ where: { address: coin }, select: { address: true } })) return bad(reply, 404, "Coin not indexed");
    const { viewer } = (req.query ?? {}) as { viewer?: string };
    if (viewer !== undefined && !isAddress(viewer)) return bad(reply, 400, "Invalid viewer address");
    const rows = await prisma.callout.findMany({ where: { coinAddress: coin, hidden: false }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 100, include: { _count: { select: { likes: true } } } });
    rows.sort((a, b) => Number(official(coin, b.author)) - Number(official(coin, a.author)));
    const likes = viewer && rows.length ? await prisma.calloutLike.findMany({ where: { wallet: lower(viewer), calloutId: { in: rows.map((r) => r.id) } }, select: { calloutId: true } }) : [];
    const liked = new Set(likes.map((x) => x.calloutId));
    return { thresholdBps: MIN_HOLDER_BPS, callouts: rows.map((r) => ({ id: r.id, author: r.author, text: r.text,
      officialCompany: official(coin, r.author), createdAt: r.createdAt, updatedAt: r.updatedAt,
      likes: r._count.likes, likedByViewer: liked.has(r.id) })) };
  });

  app.post("/coins/:address/callouts", { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { address } = req.params as { address: string };
    if (!isAddress(address)) return bad(reply, 400, "Invalid coin address");
    const coinAddress = lower(address);
    const intent = parseIntent(req.body, "post", coinAddress);
    if (!intent) return bad(reply, 400, "Invalid callout or signature payload");
    const coin = await prisma.coin.findUnique({ where: { address: coinAddress } });
    if (!coin) return bad(reply, 404, "Coin not indexed");
    if (!await signed(intent)) return bad(reply, 401, "Wallet signature did not verify");
    if (!official(coinAddress, intent.wallet)) {
      try {
        const blockNumber = await chainClient.getBlockNumber();
        const [balance, supply] = await Promise.all([
          chainClient.readContract({ address: coinAddress as `0x${string}`, abi: tokenAbi, functionName: "balanceOf", args: [intent.wallet as `0x${string}`], blockNumber }),
          chainClient.readContract({ address: coinAddress as `0x${string}`, abi: tokenAbi, functionName: "totalSupply", blockNumber }),
        ]);
        if (supply === 0n || balance * 10000n < supply * BigInt(MIN_HOLDER_BPS)) return bad(reply, 403, "Hold at least 0.5% of total supply to write a callout");
      } catch { return bad(reply, 503, "On-chain holder check unavailable; try again"); }
    }
    try {
      const row = await prisma.$transaction(async (db) => {
        await db.socialNonce.create({ data: { nonce: intent.nonce, wallet: intent.wallet } });
        const key = { coinAddress_author: { coinAddress, author: intent.wallet } };
        const prior = await db.callout.findUnique({ where: key });
        if (!prior) return db.callout.create({ data: { coinAddress, author: intent.wallet, text: intent.text } });
        const updated = await db.callout.updateMany({ where: { id: prior.id, updatedAt: { lte: new Date(Date.now() - EDIT_WAIT_MS) } }, data: { text: intent.text } });
        if (!updated.count) throw new Error("EDIT_COOLDOWN");
        return db.callout.findUniqueOrThrow({ where: { id: prior.id } });
      }, { isolationLevel: "Serializable" });
      return reply.code(200).send({ id: row.id, updatedAt: row.updatedAt });
    } catch (e) {
      if (e instanceof Error && e.message === "EDIT_COOLDOWN") return bad(reply, 429, "You can update your callout once every 24 hours");
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return bad(reply, 409, "Signed request already used or callout updated concurrently");
      throw e;
    }
  });

  app.post("/coins/:address/callouts/:id/like", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { address, id } = req.params as { address: string; id: string };
    if (!isAddress(address)) return bad(reply, 400, "Invalid coin address");
    const body = req.body as Record<string, unknown> | null;
    const action = body?.action === "unlike" ? "unlike" : "like";
    const intent = parseIntent({ ...body, target: id }, action, lower(address));
    if (!intent) return bad(reply, 400, "Invalid like or signature payload");
    if (!await signed(intent)) return bad(reply, 401, "Wallet signature did not verify");
    const callout = await prisma.callout.findUnique({ where: { id } });
    if (!callout || callout.hidden || callout.coinAddress !== intent.coin) return bad(reply, 404, "Callout not found");
    if (callout.author === intent.wallet) return bad(reply, 403, "You cannot like your own callout");
    try {
      await prisma.$transaction(async (db) => {
        await db.socialNonce.create({ data: { nonce: intent.nonce, wallet: intent.wallet } });
        const key = { calloutId_wallet: { calloutId: id, wallet: intent.wallet } };
        if (action === "like") await db.calloutLike.upsert({ where: key, create: { calloutId: id, wallet: intent.wallet }, update: {} });
        else await db.calloutLike.deleteMany({ where: { calloutId: id, wallet: intent.wallet } });
      }, { isolationLevel: "Serializable" });
      return { liked: action === "like" };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return bad(reply, 409, "Signed request already used");
      throw e;
    }
  });
}
