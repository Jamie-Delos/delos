// Client for the /api/metadata store (thesis / description / logo URL per launched coin).
// Degrades to null / false when the store isn't provisioned yet, so the UI never breaks.
//
// Writes are creator-signed: the server only accepts metadata signed by the coin's on-chain creator
// (EIP-191 over a message binding chain id + token + content hash), so the caller must pass a
// `signMessage` function from the connected wallet (wagmi's signMessageAsync).
import { keccak256, stringToBytes } from "viem";

export type CoinMetadata = { name?: string; thesis?: string; description?: string; image?: string };

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

export function metadataMessage(chainId: number, address: string, metadata: CoinMetadata): string {
  const contentHash = keccak256(stringToBytes(JSON.stringify(cleanMetadata(metadata))));
  return `Census metadata v1\nchain: ${chainId}\ntoken: ${address.toLowerCase()}\ncontent: ${contentHash}`;
}

export async function putMetadata(
  address: string,
  chainId: number,
  metadata: CoinMetadata,
  signMessage: (args: { message: string }) => Promise<string>,
): Promise<boolean> {
  try {
    const signature = await signMessage({ message: metadataMessage(chainId, address, metadata) });
    const r = await fetch(`/api/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, chainId, metadata, signature }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
