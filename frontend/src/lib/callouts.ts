import { CHAIN, INDEXER_URL } from "../config";

export type HolderRow = { wallet: string; balance: string; shareBps: number };
export type HoldersResponse = { available: boolean; reason?: string; asOfBlock?: string | null; totalHolders?: number; holders: HolderRow[] };
export type Callout = { id: string; author: string; text: string; officialCompany: boolean; createdAt: string; updatedAt: string; likes: number; likedByViewer: boolean };
export type CalloutsResponse = { thresholdBps: number; callouts: Callout[] };
type Action = "post" | "like" | "unlike";
type Intent = { action: Action; coin: string; wallet: string; text: string; target: string; issuedAt: number; nonce: string };

// Keep this message byte-for-byte identical to indexer/src/social.ts.
function message(i: Intent) {
  return `Delos callout\nChain: ${CHAIN.id}\nCoin: ${i.coin}\nWallet: ${i.wallet}\nAction: ${i.action}\nTarget: ${i.target}\nText: ${i.text}\nIssued: ${i.issuedAt}\nNonce: ${i.nonce}`;
}

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${INDEXER_URL}${path}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload as T;
}

export const getHolders = (coin: string) => json<HoldersResponse>(`/coins/${coin.toLowerCase()}/holders`);
export const getCallouts = (coin: string, viewer?: string) => json<CalloutsResponse>(`/coins/${coin.toLowerCase()}/callouts${viewer ? `?viewer=${viewer.toLowerCase()}` : ""}`);

export async function sendCalloutAction(args: {
  coin: string; wallet: string; action: Action; text?: string; target?: string;
  sign: (message: string) => Promise<string>;
}) {
  const intent: Intent = { action: args.action, coin: args.coin.toLowerCase(), wallet: args.wallet.toLowerCase(),
    text: args.action === "post" ? (args.text ?? "").trim() : "", target: args.action === "post" ? "-" : args.target ?? "",
    issuedAt: Date.now(), nonce: crypto.randomUUID() };
  const signature = await args.sign(message(intent));
  const path = `/coins/${intent.coin}/callouts${intent.action === "post" ? "" : `/${intent.target}/like`}`;
  const response = await fetch(`${INDEXER_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    wallet: intent.wallet, text: intent.text, action: intent.action, issuedAt: intent.issuedAt, nonce: intent.nonce, signature,
  }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
  return payload;
}
