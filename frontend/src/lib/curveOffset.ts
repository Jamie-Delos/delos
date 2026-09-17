// The PF-style curve prices against (tokenReserve + virtualTokenOffset), where the offset is an unminted
// pricing term the contract exposes via `virtualTokenOffset(coin)`. Older curve deployments have no such
// getter and no offset, so a call that reverts with no data means "legacy curve: offset 0", while an RPC
// failure means "unknown" — callers hide the price rather than guess.
import { type Address, type PublicClient } from "viem";
import { CONTRACTS } from "../config";
import { censusCurveAbi } from "../abis";

let legacyCurve: boolean | null = null; // probed once per session for CONTRACTS.curve

const looksLikeMissingFunction = (e: unknown) => {
  const m = String((e as any)?.shortMessage ?? (e as any)?.message ?? e ?? "");
  return /returned no data|0x\)|reverted|does not have|function selector|ContractFunctionZeroData|AbiFunctionNotFound/i.test(m);
};

export async function readTokenOffset(pc: PublicClient, coin: Address): Promise<bigint | null> {
  if (legacyCurve === true) return 0n;
  try {
    const v = await pc.readContract({ address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "virtualTokenOffset", args: [coin] });
    legacyCurve = false;
    return v;
  } catch (e) {
    if (legacyCurve === null && looksLikeMissingFunction(e)) { legacyCurve = true; return 0n; }
    return null;
  }
}

// Spot price in quote units per token, or null when the offset can't be established.
export const curveSpot = (virtualQuote: bigint, tokenReserve: bigint, offset: bigint | null, quoteDec: number): number | null =>
  offset == null || tokenReserve + offset <= 0n ? null : (Number(virtualQuote) / 10 ** quoteDec) / (Number(tokenReserve + offset) / 1e18);
