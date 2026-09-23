// The PF-style curve prices against (tokenReserve + virtualTokenOffset), where the offset is an unminted
// pricing term the contract exposes via `virtualTokenOffset(coin)`. The oldest legacy curve deployments
// have no such getter and no offset, so a call that reverts with no data means "legacy curve: offset 0",
// while an RPC failure means "unknown" — callers hide the price rather than guess. `curve` is the curve
// the coin trades on (V4 or legacy — see lib/curves.ts); the probe is remembered per curve address.
import { type Address, type PublicClient } from "viem";
import { censusCurveV4Abi } from "../abis";

const noOffsetGetter = new Map<string, boolean>(); // curve address -> probed "has no virtualTokenOffset"

const looksLikeMissingFunction = (e: unknown) => {
  const m = String((e as any)?.shortMessage ?? (e as any)?.message ?? e ?? "");
  return /returned no data|0x\)|reverted|does not have|function selector|ContractFunctionZeroData|AbiFunctionNotFound/i.test(m);
};

export async function readTokenOffset(pc: PublicClient, curve: Address, coin: Address): Promise<bigint | null> {
  const k = curve.toLowerCase();
  if (noOffsetGetter.get(k) === true) return 0n;
  try {
    const v = await pc.readContract({ address: curve, abi: censusCurveV4Abi, functionName: "virtualTokenOffset", args: [coin] });
    noOffsetGetter.set(k, false);
    return v;
  } catch (e) {
    if (!noOffsetGetter.has(k) && looksLikeMissingFunction(e)) { noOffsetGetter.set(k, true); return 0n; }
    return null;
  }
}

// Spot price in quote units per token, or null when the offset can't be established.
export const curveSpot = (virtualQuote: bigint, tokenReserve: bigint, offset: bigint | null, quoteDec: number): number | null =>
  offset == null || tokenReserve + offset <= 0n ? null : (Number(virtualQuote) / 10 ** quoteDec) / (Number(tokenReserve + offset) / 1e18);
