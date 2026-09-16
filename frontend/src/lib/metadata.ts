// Client for the /api/metadata store (thesis / description / logo URL per launched coin).
// Reads degrade to null when the store isn't provisioned yet, so the UI never breaks.
//
// Writes are creator-signed: the server only accepts metadata signed by the coin's on-chain creator
// (EIP-191 over a message binding chain id + token + content hash + issue timestamp), so the caller
// must pass a `signMessage` function from the connected wallet (wagmi's signMessageAsync).
// A failed write is REPORTED (with the reason) rather than swallowed, and the payload is kept in
// localStorage so it can be retried later (`pendingMetadata` / `retryPendingMetadata`).
import { keccak256, stringToBytes } from "viem";

export type CoinMetadata = { name?: string; thesis?: string; description?: string; image?: string };
export type PutResult = { ok: true } | { ok: false; status: number; reason: string; retryable: boolean };

const PENDING_KEY = (chainId: number, address: string) => `census:meta-pending:${chainId}:${address.toLowerCase()}`;

export async function getMetadata(address: string): Promise<CoinMetadata | null> {
  try {
    const r = await fetch(`/api/metadata?address=${address}`);
    if (!r.ok) return null;
    const j = await r.json();
    return (j?.metadata as CoinMetadata) ?? null;
  } catch {
    return null;
  }
}

// Must mirror the server's cleanMetadata + metadataMessage exactly (same field order and caps).
function cleanMetadata(m: CoinMetadata) {
  return {
    name: String(m.name ?? "").slice(0, 64),
    thesis: String(m.thesis ?? "").slice(0, 140),
    description: String(m.description ?? "").slice(0, 2000),
    image: String(m.image ?? "").slice(0, 400),
  };
}

export function metadataMessage(chainId: number, address: string, metadata: CoinMetadata, issuedAt: number): string {
  const contentHash = keccak256(stringToBytes(JSON.stringify(cleanMetadata(metadata))));
  return `Census metadata v2\nchain: ${chainId}\ntoken: ${address.toLowerCase()}\ncontent: ${contentHash}\nissued: ${issuedAt}`;
}

/// Sign + store. Never throws: the result says whether it worked and, if not, why and whether a
/// retry can help (user declined the signature, store not provisioned yet, RPC lag on a brand-new
/// launch, ...). On failure the payload is remembered for `retryPendingMetadata`.
export async function putMetadata(
  address: string,
  chainId: number,
  metadata: CoinMetadata,
  signMessage: (args: { message: string }) => Promise<string>,
): Promise<PutResult> {
  const remember = () => { try { localStorage.setItem(PENDING_KEY(chainId, address), JSON.stringify(metadata)); } catch { /* ignore */ } };
  const forget = () => { try { localStorage.removeItem(PENDING_KEY(chainId, address)); } catch { /* ignore */ } };
  let signature: string;
  const issuedAt = Math.floor(Date.now() / 1000);
  try {
    signature = await signMessage({ message: metadataMessage(chainId, address, metadata, issuedAt) });
  } catch (e: any) {
    remember();
    return { ok: false, status: 0, reason: /reject|denied/i.test(String(e?.message ?? e)) ? "signature declined in wallet" : "wallet could not sign", retryable: true };
  }
  try {
    const r = await fetch(`/api/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, chainId, metadata, signature, issuedAt }),
    });
    if (r.ok) { forget(); return { ok: true }; }
    let reason = `store returned ${r.status}`;
    try { reason = (await r.json())?.message ?? reason; } catch { /* keep */ }
    // 4xx authorization failures are final for this signer; 403 "unknown launch" is RPC lag (retry).
    const retryable = r.status >= 500 || r.status === 409 || reason === "unknown launch" || reason === "signature expired";
    remember();
    return { ok: false, status: r.status, reason, retryable };
  } catch {
    remember();
    return { ok: false, status: 0, reason: "network error", retryable: true };
  }
}

/// A write that failed earlier for this coin (if any), so a page can offer "save details" again.
export function pendingMetadata(chainId: number, address: string): CoinMetadata | null {
  try { const raw = localStorage.getItem(PENDING_KEY(chainId, address)); return raw ? (JSON.parse(raw) as CoinMetadata) : null; } catch { return null; }
}

export async function retryPendingMetadata(
  chainId: number,
  address: string,
  signMessage: (args: { message: string }) => Promise<string>,
): Promise<PutResult | null> {
  const pending = pendingMetadata(chainId, address);
  if (!pending) return null;
  return putMetadata(address, chainId, pending, signMessage);
}
