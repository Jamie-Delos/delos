// Live curve stats for a list of coins — price, market cap (FDV) and graduation progress read straight
// off the CensusCurve (curves(coin) + the token's totalSupply). Cheap at low coin counts; at scale this
// is exactly what the indexer serves instead. USD is derived for ETH-quoted coins via the ETH_USD
// calibration; non-ETH-quoted coins report null price/mcap (shown as "new") until the indexer lands.
import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { type Address } from "viem";
import { CONTRACTS } from "../config";
import { censusCurveAbi, erc20Abi } from "../abis";
import { ANCHORS, ETH_USD } from "./anchors";

const ZERO = "0x0000000000000000000000000000000000000000";

export type CurveStat = {
  priceUsd: number | null;
  mcapUsd: number | null;
  gradPct: number | null; // 0..100, or 100 once graduated
  graduated: boolean;
  anchor: string;         // "ETH" | "HOOD" — the coin's quote asset, for row/trade labels
  reserve: number;        // quote raised so far (in the anchor's units), for the graduation caption
};

const EMPTY: CurveStat = { priceUsd: null, mcapUsd: null, gradPct: null, graduated: false, anchor: "ETH", reserve: 0 };

export function useCurveStats(addresses: string[]): Record<string, CurveStat> {
  const pc = usePublicClient();
  const [stats, setStats] = useState<Record<string, CurveStat>>({});
  const key = addresses.map((a) => a.toLowerCase()).sort().join(",");

  useEffect(() => {
    let cancelled = false;
    if (!pc || CONTRACTS.curve === ZERO || addresses.length === 0) {
      setStats({});
      return;
    }
    (async () => {
      const entries = await Promise.all(
        addresses.map(async (addr): Promise<[string, CurveStat]> => {
          const lc = addr.toLowerCase();
          try {
            const cv = (await pc.readContract({
              address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "curves", args: [addr as Address],
            })) as readonly [Address, Address, Address, number, number, bigint, bigint, bigint, bigint, boolean, boolean];
            if (!cv[10]) return [lc, EMPTY]; // not registered on the curve
            const quote = cv[0], virtualQuote = cv[5], tokenReserve = cv[6], realQuote = cv[7], graduationQuote = cv[8], graduated = cv[9];
            const offset = await pc.readContract({ address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "virtualTokenOffset", args: [addr as Address] }) as bigint;
            const isWeth = quote.toLowerCase() === CONTRACTS.weth.toLowerCase();
            const quoteDec = ANCHORS.find((a) => a.quote.toLowerCase() === quote.toLowerCase())?.quoteDecimals ?? 18;

            let priceUsd: number | null = null;
            let mcapUsd: number | null = null;
            if (isWeth && tokenReserve > 0n) {
              const priceQuote = (Number(virtualQuote) / 10 ** quoteDec) / (Number(tokenReserve + offset) / 1e18);
              priceUsd = priceQuote * ETH_USD;
              try {
                const supply = (await pc.readContract({ address: addr as Address, abi: erc20Abi, functionName: "totalSupply" })) as bigint;
                mcapUsd = priceUsd * (Number(supply) / 1e18);
              } catch { /* keep priceUsd, leave mcap null */ }
            }
            const gradPct = graduated ? 100 : graduationQuote > 0n ? Math.min(100, Math.round(Number((realQuote * 10000n) / graduationQuote) / 100)) : null;
            const anchor = ANCHORS.find((a) => a.quote.toLowerCase() === quote.toLowerCase())?.key ?? "ETH";
            const reserve = Number(realQuote) / 10 ** quoteDec;
            return [lc, { priceUsd, mcapUsd, gradPct, graduated, anchor, reserve }];
          } catch {
            return [lc, EMPTY];
          }
        }),
      );
      if (!cancelled) setStats(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [pc, key]);

  return stats;
}
