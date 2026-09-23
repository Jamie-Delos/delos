// Resolve a launched coin's trading state from its curve registration (CensusCurveV4, or the legacy
// CensusCurve for old testnet coins): the anchor it trades against (WETH by default, or HOOD, or a
// company coin), whether it's registered, its holder reflection + rewards vault, and whether it has
// graduated. Pre-graduation every trade is on the curve; post-graduation a V4 coin trades in its
// canonical hooked pool through CensusV4Router (the Coin page's pool path).
import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { zeroAddress, type Address, type Hex } from "viem";
import { CONTRACTS } from "../config";
import { erc20Abi, censusCurveV4Abi } from "../abis";
import { readTokenOffset } from "./curveOffset";
import { readCurve, hasAnyCurve, type CurveVenue } from "./curves";
import { poolIdFor, poolKeyFor } from "./v4pool";

export type CoinQuote = {
  quote: Address; // the anchor/quote token the coin trades against
  resolved: boolean; // true once the curve registry has been read (registered or not)
  error?: boolean; // the curve read threw (RPC down) — distinct from a confirmed "not registered"
  name?: string; // real on-chain token name
  symbol?: string;
  routed?: boolean; // registered on a Census curve
  venue?: CurveVenue; // "v4" (CensusCurveV4 -> hooked V4 pool) or "legacy" (old CensusCurve -> V3 pool)
  curve?: Address; // the curve contract this coin trades on
  graduated?: boolean; // curve filled + migrated to the permanent pool
  creator?: Address; // the coin's creator, from the curve registry
  vault?: Address; // rewards vault (zero when reflection is off)
  reflectionBps?: number; // holder reflection ON TOP of the 2% base fee (0 = off)
  poolId?: Hex; // V4, graduated: keccak256(abi.encode(PoolKey)), cross-checked with curve.poolIds(coin)
  poolIdMismatch?: boolean; // the computed key doesn't match what the curve registered — never trade on it
  legacyPoolFee?: number; // legacy only: the V3 tier of the coin's graduated pool
  virtualQuote?: bigint; // V — current virtual quote reserve (spot price = virtualQuote / (tokenReserve + virtualTokenOffset))
  tokenReserve?: bigint; // real tokens still in the curve
  virtualTokenOffset?: bigint | null; // PF pricing offset (unminted); null = couldn't be read, so no price is shown
  realQuote?: bigint; // quote raised so far (for the graduation reserve caption)
  graduationQuote?: bigint; // quote needed to graduate
  totalSupply?: bigint; // the coin's ERC-20 total supply (for market cap / FDV)
};

// `nonce` lets a caller force a re-read (e.g. a Retry button after an RPC failure).
export function useCoinQuote(coin?: string, nonce = 0): CoinQuote {
  const pc = usePublicClient();
  const [info, setInfo] = useState<CoinQuote>({ quote: CONTRACTS.weth, resolved: false });

  useEffect(() => {
    let cancelled = false;
    const c = (coin || "").toLowerCase();
    setInfo({ quote: CONTRACTS.weth, resolved: false });
    if (!pc || c.length !== 42) return;
    (async () => {
      // Real token name/symbol/supply — readable for any ERC-20 at this address, independent of our factory.
      try {
        const [nm, sym, sup] = await Promise.all([
          pc.readContract({ address: coin as Address, abi: erc20Abi, functionName: "name" }),
          pc.readContract({ address: coin as Address, abi: erc20Abi, functionName: "symbol" }),
          pc.readContract({ address: coin as Address, abi: erc20Abi, functionName: "totalSupply" }),
        ]);
        if (!cancelled) setInfo((prev) => ({ ...prev, name: nm || prev.name, symbol: sym || prev.symbol, totalSupply: sup ?? prev.totalSupply }));
      } catch { /* not an ERC-20 we can read */ }

      // The curve registration is the source of truth (V4 first, then the legacy curve if configured).
      if (!hasAnyCurve()) { if (!cancelled) setInfo((prev) => ({ ...prev, resolved: true })); return; }
      try {
        const rec = await readCurve(pc, coin as Address);
        if (cancelled) return;
        if (!rec) { setInfo((prev) => ({ ...prev, resolved: true, routed: false })); return; }
        const offset = await readTokenOffset(pc, rec.curve, coin as Address);
        // Graduated V4 coin: build the fixed PoolKey and cross-check its id with what the curve registered.
        let poolId: Hex | undefined, poolIdMismatch: boolean | undefined;
        if (rec.venue === "v4" && rec.graduated) {
          poolId = poolIdFor(poolKeyFor(coin as Address, rec.quote).key);
          try {
            const onChain = await pc.readContract({ address: rec.curve, abi: censusCurveV4Abi, functionName: "poolIds", args: [coin as Address] });
            poolIdMismatch = onChain.toLowerCase() !== poolId.toLowerCase();
          } catch { poolIdMismatch = undefined; }
        }
        if (cancelled) return;
        setInfo((prev) => ({
          ...prev,
          quote: rec.quote,
          creator: rec.creator,
          vault: rec.vault === zeroAddress ? undefined : rec.vault,
          reflectionBps: rec.reflectionBps,
          venue: rec.venue,
          curve: rec.curve,
          legacyPoolFee: rec.legacyPoolFee,
          poolId,
          poolIdMismatch,
          virtualQuote: rec.virtualQuote,
          tokenReserve: rec.tokenReserve,
          virtualTokenOffset: offset,
          realQuote: rec.realQuote,
          graduationQuote: rec.graduationQuote,
          graduated: rec.graduated,
          routed: true,
          resolved: true,
        }));
      } catch { if (!cancelled) setInfo((prev) => ({ ...prev, resolved: true, error: true })); } // couldn't read — NOT a confirmed "not a coin"
    })();
    return () => { cancelled = true; };
  }, [pc, coin, nonce]);

  return info;
}
