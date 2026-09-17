// Logo upload for the launch wizard. Accepts a small image data URL and stores it in Vercel Blob,
// returning a public https URL that fits the metadata store's URL field.
//
// AUTHORIZATION (closes the "upload.ts is unauthenticated" gate): uploads happen BEFORE the token
// exists, so there is no on-chain creator to check yet. Instead every upload is bound to a wallet:
//   - the client signs (EIP-191) `Census upload v1` over chain id + wallet + keccak256(image bytes) +
//     an issue timestamp (10-minute expiry), and the server recovers the signer;
//   - each wallet gets UPLOAD_DAILY_QUOTA uploads per UTC day (KV INCR with expiry), so the store
//     cannot be used as anonymous free hosting or filled by one key;
//   - size (MAX_BYTES) and MIME are enforced server-side from the decoded bytes.
// Fail closed: without CENSUS_CHAIN_ID, the KV vars or BLOB_READ_WRITE_TOKEN the endpoint returns 503
// and the wizard keeps its local preview (same graceful-degrade contract as /api/metadata).
//   POST /api/upload { image, address, signature, issuedAt } -> { url }

import { put } from "@vercel/blob";
import { keccak256, recoverMessageAddress } from "viem";

const MAX_BYTES = 1_500_000; // downscaled logos are tens of KB; well under Vercel's 4.5MB function-body limit
export const UPLOAD_TTL_S = 10 * 60;
const FUTURE_SKEW_S = 60;
const isAddr = (s: any) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
const isSig = (s: any) => typeof s === "string" && /^0x[0-9a-fA-F]{130}$/.test(s);

// Injectable for tests (the blob SDK is replaced with a fake there).
export const deps = { put };

export function uploadMessage(chain: number, wallet: string, contentHash: string, issuedAt: number): string {
  return `Census upload v1\nchain: ${chain}\nwallet: ${wallet.toLowerCase()}\ncontent: ${contentHash}\nissued: ${issuedAt}`;
}

function chainId(): number | null {
  const raw = process.env.CENSUS_CHAIN_ID;
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function kv(command: unknown[]): Promise<any> {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { unavailable: true };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  return r.json();
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "POST") return res.status(405).json({ message: "method not allowed" });
    const chain = chainId();
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
    if (chain === null || !blobToken || !process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      return res.status(503).json({ message: "image store not provisioned" });
    }
    const quota = Number(process.env.UPLOAD_DAILY_QUOTA || 20);

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const address = String(body.address ?? "");
    if (!isAddr(address)) return res.status(400).json({ message: "bad address" });
    if (!isSig(body.signature)) return res.status(401).json({ message: "signature required" });
    const issuedAt = Number(body.issuedAt);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(issuedAt) || issuedAt > now + FUTURE_SKEW_S) return res.status(400).json({ message: "bad timestamp" });
    if (issuedAt < now - UPLOAD_TTL_S) return res.status(400).json({ message: "signature expired" });

    const dataUrl = String(body.image ?? "");
    const m = /^data:(image\/(png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) return res.status(400).json({ message: "expected an image data URL" });
    const mime = m[1];
    const ext = mime.split("/")[1].replace("jpeg", "jpg");
    const buf = Buffer.from(m[3], "base64");
    if (!buf.length) return res.status(400).json({ message: "empty image" });
    if (buf.length > MAX_BYTES) return res.status(413).json({ message: "image too large" });

    // The signature binds THESE bytes to THIS wallet on THIS chain, for a short window.
    const contentHash = keccak256(new Uint8Array(buf));
    let signer: string;
    try {
      signer = await recoverMessageAddress({ message: uploadMessage(chain, address, contentHash, issuedAt), signature: body.signature as `0x${string}` });
    } catch {
      return res.status(401).json({ message: "bad signature" });
    }
    if (signer.toLowerCase() !== address.toLowerCase()) return res.status(403).json({ message: "signature does not match wallet" });

    // Per-wallet daily quota (UTC day); the counter expires on its own.
    const day = new Date().toISOString().slice(0, 10);
    const key = `census:upload:${chain}:${address.toLowerCase()}:${day}`;
    const counted = await kv(["INCR", key]);
    if (counted?.unavailable) return res.status(503).json({ message: "image store not provisioned" });
    const n = Number(counted?.result);
    if (!Number.isFinite(n)) { console.error("[upload] KV INCR rejected", counted?.error ?? counted); return res.status(502).json({ message: "quota store rejected the request" }); }
    if (n === 1) await kv(["EXPIRE", key, 2 * 86400]);
    if (n > quota) return res.status(429).json({ message: "daily upload quota reached for this wallet" });

    const name = `census/${chain}/${address.toLowerCase()}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { url } = await deps.put(name, buf, { access: "public", contentType: mime, token: blobToken });
    return res.status(200).json({ url });
  } catch (e: any) {
    console.error("[upload] request failed:", e?.message ?? e); // never echo provider errors (tokens/URLs)
    return res.status(500).json({ message: "upload service error" });
  }
}
