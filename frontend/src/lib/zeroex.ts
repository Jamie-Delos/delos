// Client-side helpers for the 0x Swap API. All calls go through the /api/zeroex serverless proxy so
// the API key stays server-side (see api/zeroex.ts). Used for best-price coin trading, with the coin's
// own Uniswap pool as the fallback when 0x has no route (e.g. a coin it hasn't indexed yet).
import type { Address, Hex } from "viem";

const PROXY = (import.meta.env.VITE_ZEROX_PROXY as string | undefined) ?? "/api/zeroex";
const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 4663);

export type ZeroExQuote = {
  liquidityAvailable: boolean;
  buyAmount: string;
  minBuyAmount: string;
  transaction?: { to: Address; data: Hex; value: string; gas?: string };
  issues?: { allowance?: { spender: Address; actual: string } | null };
  allowanceTarget?: Address;
  route?: { fills?: { source: string; proportionBps: string | number }[] };
};

type Params = { sellToken: Address; buyToken: Address; sellAmount: bigint; taker?: Address; slippageBps?: number };

async function call(endpoint: "price" | "quote", p: Params): Promise<ZeroExQuote> {
  const u = new URL(PROXY, window.location.origin);
  u.searchParams.set("endpoint", endpoint);
  u.searchParams.set("chainId", String(CHAIN_ID));
  u.searchParams.set("sellToken", p.sellToken);
  u.searchParams.set("buyToken", p.buyToken);
  u.searchParams.set("sellAmount", p.sellAmount.toString());
  if (p.taker) u.searchParams.set("taker", p.taker);
  if (p.slippageBps != null) u.searchParams.set("slippageBps", String(p.slippageBps));
  const res = await fetch(u.toString());
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.reason || body?.message || `0x ${endpoint} failed (${res.status})`);
  return body as ZeroExQuote;
}

// Indicative price (no wallet needed) — for the live "you'll receive ~X" readout as the user types.
export const zeroExPrice = (p: Params) => call("price", p);
// Firm, executable quote (needs `taker`) — returns transaction calldata to submit.
export const zeroExQuote = (p: Params & { taker: Address }) => call("quote", p);

// Where to grant the ERC20 approval before executing a quote (the 0x AllowanceHolder). Never approve
// the Settler; the allowance-holder flow always points allowance + call target at the AllowanceHolder.
export const allowanceSpender = (q: ZeroExQuote): Address | undefined =>
  q.issues?.allowance?.spender ?? q.allowanceTarget ?? q.transaction?.to;

export function routeSummary(q: ZeroExQuote): string {
  const fills = q.route?.fills;
  if (!Array.isArray(fills) || fills.length === 0) return "0x";
  return fills.map((f) => `${f.source} ${Math.round(Number(f.proportionBps || 0) / 100)}%`).join(" + ");
}
