// One normalised read of a coin's curve registration. New launches live on CensusCurveV4; the legacy
// CensusCurve (V3 graduation) is consulted only when it's configured, so old testnet coins still
// resolve. Every consumer (coin page, board stats, anchor pricing) goes through here rather than
// picking a curve address and tuple layout itself.
//
// Errors propagate (an RPC failure is NOT "not a Census coin" — CX-N1); `null` is a confirmed miss.
import { zeroAddress, type Address, type PublicClient } from "viem";
import { CONTRACTS } from "../config";
import { censusCurveV4Abi, legacyCurveAbi } from "../abis";

export type CurveVenue = "v4" | "legacy";
export type CurveRecord = {
  venue: CurveVenue;
  curve: Address; // the curve contract this coin trades on (buy/sell/quotes go here)
  quote: Address;
  creator: Address;
  vault: Address; // zeroAddress when there is no rewards vault
  reflectionBps: number; // V4: holder reflection ON TOP of the 2% base (0 = off). Legacy: 0.
  virtualQuote: bigint;
  tokenReserve: bigint;
  realQuote: bigint;
  graduationQuote: bigint;
  graduated: boolean;
  legacyPoolFee?: number; // legacy only: the Uniswap V3 tier the coin graduated into (for reading its pool)
};

export const hasV4Curve = () => CONTRACTS.curveV4 !== zeroAddress;
export const hasLegacyCurve = () => CONTRACTS.curve !== zeroAddress;
export const hasAnyCurve = () => hasV4Curve() || hasLegacyCurve();

export async function readCurve(pc: PublicClient, coin: Address): Promise<CurveRecord | null> {
  if (hasV4Curve()) {
    // V4 tuple: quote@0, creator@1, vault@2, reflectionBps@3, virtualQuote@4, tokenReserve@5,
    // realQuote@6, graduationQuote@7, graduated@8, exists@9.
    const cv = await pc.readContract({ address: CONTRACTS.curveV4, abi: censusCurveV4Abi, functionName: "curves", args: [coin] });
    if (cv[9]) {
      return {
        venue: "v4", curve: CONTRACTS.curveV4, quote: cv[0], creator: cv[1], vault: cv[2], reflectionBps: Number(cv[3]),
        virtualQuote: cv[4], tokenReserve: cv[5], realQuote: cv[6], graduationQuote: cv[7], graduated: cv[8],
      };
    }
  }
  if (hasLegacyCurve()) {
    // Legacy tuple: quote@0, creator@1, vault@2, holdersBps@3, poolFee@4, virtualQuote@5, tokenReserve@6,
    // realQuote@7, graduationQuote@8, graduated@9, exists@10.
    const cv = await pc.readContract({ address: CONTRACTS.curve, abi: legacyCurveAbi, functionName: "curves", args: [coin] });
    if (cv[10]) {
      return {
        venue: "legacy", curve: CONTRACTS.curve, quote: cv[0], creator: cv[1], vault: cv[2], reflectionBps: 0,
        virtualQuote: cv[5], tokenReserve: cv[6], realQuote: cv[7], graduationQuote: cv[8], graduated: cv[9], legacyPoolFee: Number(cv[4]),
      };
    }
  }
  return null;
}
