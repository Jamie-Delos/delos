// Client-side logo handling for the launch wizard's drag-and-drop image field.
// `prepareImage` downscales the dropped file to a small thumbnail and returns a data URL for instant
// preview (keeps the payload tiny — logos land at tens of KB, not megabytes). `uploadImage` stores it
// via /api/upload and returns a persistent hosted URL. Uploads are wallet-signed (EIP-191 over the
// image bytes + a timestamp) and quota-limited per wallet, so a connected wallet is required; when the
// store isn't provisioned or the wallet declines, the caller keeps the local preview (same
// graceful-degrade contract as metadata).
import { keccak256 } from "viem";

const MAX_DIM = 512;

export type UploadSigner = {
  address: string;
  chainId: number;
  signMessage: (args: { message: string }) => Promise<string>;
};
export type UploadResult = { url: string } | { url: null; reason: string };

export async function prepareImage(file: File, maxDim = MAX_DIM): Promise<string> {
  const src = await readAsDataUrl(file);
  try {
    const img = await loadImage(src);
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    if (scale >= 1) return src; // already small enough — keep the original bytes
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return src;
    ctx.drawImage(img, 0, 0, w, h);
    return maxDim > MAX_DIM ? canvas.toDataURL("image/jpeg", 0.82) : canvas.toDataURL("image/png"); // larger banners stay below upload cap
  } catch {
    return src; // decode failed (e.g. SVG/odd format) — fall back to the raw data URL for preview
  }
}

// Must mirror api/upload.ts `uploadMessage` exactly.
export function uploadMessage(chainId: number, wallet: string, contentHash: string, issuedAt: number): string {
  return `Census upload v1\nchain: ${chainId}\nwallet: ${wallet.toLowerCase()}\ncontent: ${contentHash}\nissued: ${issuedAt}`;
}

function imageBytes(dataUrl: string): Uint8Array | null {
  const m = /^data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function uploadImage(dataUrl: string, signer: UploadSigner | null): Promise<UploadResult> {
  if (!signer) return { url: null, reason: "connect a wallet to host the logo" };
  const bytes = imageBytes(dataUrl);
  if (!bytes) return { url: null, reason: "unsupported image" };
  const issuedAt = Math.floor(Date.now() / 1000);
  let signature: string;
  try {
    signature = await signer.signMessage({ message: uploadMessage(signer.chainId, signer.address, keccak256(bytes), issuedAt) });
  } catch {
    return { url: null, reason: "signature declined" };
  }
  try {
    const r = await fetch(`/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: dataUrl, address: signer.address, chainId: signer.chainId, signature, issuedAt }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && typeof j?.url === "string") return { url: j.url };
    return { url: null, reason: j?.message ?? `upload failed (${r.status})` };
  } catch {
    return { url: null, reason: "network error" };
  }
}

export const isHostedUrl = (s: string) => /^https?:\/\//i.test(s) && s.length <= 400;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

