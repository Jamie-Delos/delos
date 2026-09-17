// Metadata store for launched coins — thesis / description / logo URL, keyed by chain + token address.
// The chain holds name/ticker/economics; this holds the off-chain copy the wizard collects.
//
// AUTHORIZATION (repairs B18; hardened per the independent review M10–M12):
//   - The client signs (EIP-191 personal_sign) a canonical message binding chain id, token address,
//     the keccak256 of the cleaned content AND an issue timestamp — so a signature authorizes exactly
//     one payload on exactly one chain/token, expires after SIGNATURE_TTL_S, and can never roll a
//     later write back: a write is accepted only if its timestamp is newer than the stored one.
//   - The server recovers the signer and checks it equals `CensusCurve.curves(token).creator` via a
//     read-only RPC call whose chain id must match CENSUS_CHAIN_ID (no silent mainnet default: the
//     chain id is REQUIRED configuration). Unregistered tokens (including merely-predicted CREATE2
//     addresses) are rejected, which ends description-squatting on future launches.
//   - The creator may overwrite their own metadata (the authorized correction policy). Each write is
//     a single atomic KV SET whose reply is verified; there is no read-modify-write of the content.
//   - Smart-contract wallets (ERC-1271) are not supported by this recovery path; those creators
//     currently launch via EOAs. Fail-closed: verification errors never fall back to accepting, and
//     unexpected errors return a generic message (details stay in the server log).
//
// Backed by Vercel KV (Upstash Redis REST): KV_REST_API_URL + KV_REST_API_TOKEN. Verification needs
// CENSUS_RPC_URL + CENSUS_CURVE_ADDRESS + CENSUS_CHAIN_ID. Until provisioned this degrades
// gracefully (GET returns null, POST returns 503) so the launch flow still works.
//   GET  /api/metadata?address=0x…                                            -> { address, metadata: {…} | null }
//   POST /api/metadata { address, chainId, metadata, signature, issuedAt }   -> { ok: true }

import { createPublicClient, http, keccak256, recoverMessageAddress, stringToBytes } from "viem";

const isAddr = (s: any) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
const isSig = (s: any) => typeof s === "string" && /^0x[0-9a-fA-F]{130}$/.test(s);

export const SIGNATURE_TTL_S = 10 * 60; // a signed write must land within 10 minutes of issue
const FUTURE_SKEW_S = 60;               // tolerate slightly-ahead client clocks

const CURVE_ABI = [{
  type: "function", name: "curves", stateMutability: "view",
  inputs: [{ name: "", type: "address" }],
  outputs: [
    { name: "quote", type: "address" }, { name: "creator", type: "address" },
    { name: "vault", type: "address" }, { name: "holdersBps", type: "uint16" },
    { name: "poolFee", type: "uint24" }, { name: "virtualQuote", type: "uint256" },
    { name: "tokenReserve", type: "uint256" }, { name: "realQuote", type: "uint256" },
    { name: "graduationQuote", type: "uint256" }, { name: "graduated", type: "bool" },
    { name: "exists", type: "bool" },
  ],
}] as const;

/// The configured chain id, or null when unset. There is deliberately NO default: a testnet project
/// without the variable must fail closed rather than silently key/verify against mainnet.
function chainId(): number | null {
  const raw = process.env.CENSUS_CHAIN_ID;
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
const KEY = (chain: number, addr: string) => `census:meta:${chain}:${addr.toLowerCase()}`;

// Canonical cleaned payload — key order matters: the client hashes the same shape before signing.
function cleanMetadata(meta: any) {
  const m = meta && typeof meta === "object" ? meta : {};
  return {
    name: String(m.name ?? "").slice(0, 64),
    thesis: String(m.thesis ?? "").slice(0, 140),
    description: String(m.description ?? "").slice(0, 2000),
    image: String(m.image ?? "").slice(0, 400),
  };
}

// The exact string the creator signs. Any change here is a breaking protocol change for the client.
export function metadataMessage(chain: number, address: string, contentHash: string, issuedAt: number): string {
  return `Census metadata v2\nchain: ${chain}\ntoken: ${address.toLowerCase()}\ncontent: ${contentHash}\nissued: ${issuedAt}`;
}

async function kv(command: unknown[]): Promise<any> {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { unavailable: true };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    return await r.json();
  } catch {
    return { unavailable: true };
  }
}

// Per-IP write rate limit (CX-L2): a signed POST costs a signature recover + an on-chain readContract +
// KV ops, so an unthrottled caller can abuse the single RPC and function budget with well-formed-but-wrong
// signatures. Fail-open: a POST already fails closed (503) without KV, so this never weakens anything.
const METADATA_RATE_PER_MIN = Number(process.env.METADATA_RATE_PER_MIN || 30);
function clientIp(req: any): string {
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  const xr = req.headers?.["x-real-ip"];
  if (typeof xr === "string" && xr.length) return xr.trim();
  return "unknown";
}
async function rateLimited(req: any): Promise<boolean> {
  const key = `census:meta:rl:${clientIp(req)}:${Math.floor(Date.now() / 60000)}`;
  const counted = await kv(["INCR", key]);
  if (counted?.unavailable) return false;
  const n = Number(counted?.result);
  if (!Number.isFinite(n)) return false;
  if (n === 1) await kv(["EXPIRE", key, 120]);
  return n > METADATA_RATE_PER_MIN;
}

/// Read the coin's on-chain creator. "unconfigured" when the curve/RPC isn't set, "mismatch" when the
/// RPC serves a different chain than CENSUS_CHAIN_ID, null when the coin is unknown.
async function onchainCreator(chain: number, address: `0x${string}`): Promise<`0x${string}` | null | "unconfigured" | "mismatch"> {
  const rpc = process.env.CENSUS_RPC_URL;
  const curve = process.env.CENSUS_CURVE_ADDRESS;
  if (!rpc || !isAddr(curve)) return "unconfigured";
  const client = createPublicClient({ transport: http(rpc, { timeout: 5000, retryCount: 1 }) });
  if ((await client.getChainId()) !== chain) return "mismatch";
  const c = await client.readContract({
    address: curve as `0x${string}`, abi: CURVE_ABI, functionName: "curves", args: [address],
  });
  return c[10] ? (c[1] as `0x${string}`) : null; // exists ? creator : null
}

export default async function handler(req: any, res: any) {
  try {
    const chain = chainId();
    if (req.method === "GET") {
      const address = String(req.query?.address ?? "");
      if (!isAddr(address)) return res.status(400).json({ message: "bad address" });
      if (chain === null) return res.status(200).json({ address, metadata: null, store: "unconfigured" });
      const out = await kv(["GET", KEY(chain, address)]);
      if (out?.unavailable) return res.status(200).json({ address, metadata: null, store: "unavailable" });
      let metadata: any = null;
      try { metadata = out?.result ? JSON.parse(out.result) : null; } catch { metadata = null; }
      if (metadata) metadata = cleanMetadata(metadata); // never expose bookkeeping fields
      res.setHeader("cache-control", "public, max-age=10");
      return res.status(200).json({ address, metadata });
    }
    if (req.method === "POST") {
      if (chain === null) return res.status(503).json({ message: "verification not configured" });
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const address = String(body.address ?? "");
      if (!isAddr(address)) return res.status(400).json({ message: "bad address" });
      if (Number(body.chainId) !== chain) return res.status(400).json({ message: "wrong chain" });
      if (!isSig(body.signature)) return res.status(401).json({ message: "signature required" });
      const issuedAt = Number(body.issuedAt);
      const now = Math.floor(Date.now() / 1000);
      if (!Number.isSafeInteger(issuedAt) || issuedAt > now + FUTURE_SKEW_S) return res.status(400).json({ message: "bad timestamp" });
      if (issuedAt < now - SIGNATURE_TTL_S) return res.status(400).json({ message: "signature expired" });

      // Throttle before the signature recover + on-chain read, so a scripted caller can't abuse them.
      if (await rateLimited(req)) { res.setHeader("retry-after", "60"); return res.status(429).json({ message: "too many requests — slow down and retry" }); }

      const clean = cleanMetadata(body.metadata);
      const contentHash = keccak256(stringToBytes(JSON.stringify(clean)));
      const message = metadataMessage(chain, address, contentHash, issuedAt);

      let signer: `0x${string}`;
      try {
        signer = await recoverMessageAddress({ message, signature: body.signature as `0x${string}` });
      } catch {
        return res.status(401).json({ message: "bad signature" });
      }

      const creator = await onchainCreator(chain, address as `0x${string}`);
      if (creator === "unconfigured") return res.status(503).json({ message: "verification not configured" });
      if (creator === "mismatch") return res.status(503).json({ message: "verification RPC serves a different chain" });
      if (!creator) return res.status(403).json({ message: "unknown launch" });
      if (creator.toLowerCase() !== signer.toLowerCase()) return res.status(403).json({ message: "not the creator" });

      // Rollback protection: a captured older signature can never overwrite a newer write.
      const key = KEY(chain, address);
      const current = await kv(["GET", key]);
      if (current?.unavailable) return res.status(503).json({ message: "metadata store not provisioned" });
      let storedIssuedAt = 0;
      try { storedIssuedAt = Number(JSON.parse(current?.result ?? "null")?.issuedAt ?? 0) || 0; } catch { storedIssuedAt = 0; }
      if (issuedAt <= storedIssuedAt) return res.status(409).json({ message: "stale signature" });

      const written = await kv(["SET", key, JSON.stringify({ ...clean, issuedAt })]);
      if (written?.unavailable) return res.status(503).json({ message: "metadata store not provisioned" });
      if (written?.result !== "OK") { console.error("[metadata] KV SET rejected", written?.error ?? written); return res.status(502).json({ message: "metadata store rejected the write" }); }
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ message: "method not allowed" });
  } catch (e: any) {
    // viem request errors embed the RPC URL and request body: log them, never return them.
    console.error("[metadata] request failed:", e?.shortMessage ?? e?.message ?? e);
    return res.status(500).json({ message: "metadata service error" });
  }
}
