// Live curve stats for a list of coins — price, market cap (FDV) and graduation progress read straight
// off the CensusCurve (curves(coin) + the token's totalSupply). Cheap at low coin counts; at scale this
// is exactly what the indexer serves instead. USD comes from each anchor's live price (lib/anchors);
// a coin whose anchor can't be priced keeps null price/mcap and shows "—".
import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { zeroAddress, type Address } from "viem";
import { CONTRACTS } from "../config";
import { censusCurveAbi, erc20Abi } from "../abis";
import { cachedQuoteUsd, quoteInfo } from "./anchors";

export type CurveStat = {
  priceUsd: number | null;
  mcapUsd: number | null;
  gradPct: number | null; // 0..100, or 100 once graduated
  graduated: boolean;
  anchor: string; // "ETH" | "HOOD" | a company coin's symbol — for row/trade labels
  anchorIsCoin: boolean; // anchored to another Census coin
  quoteAddress: string; // the anchor's address (ecosystem lookups)
  reserve: number; // quote raised so far (in the anchor's units), for the graduation caption
  graduationTarget: number | null; // quote needed to graduate (anchor units)
};

const EMPTY: CurveStat = { priceUsd: null, mcapUsd: null, gradPct: null, graduated: false, anchor: "ETH", anchorIsCoin: false, quoteAddress: "", reserve: 0, graduationTarget: null };

export function useCurveStats(addresses: string[]): Record<string, CurveStat> {
  const pc = usePublicClient();
  const [stats, setStats] = useState<Record<string, CurveStat>>({});
  const key = addresses.map((a) => a.toLowerCase()).sort().join(",");

  useEffect(() => {
    let cancelled = false;
    if (!pc || CONTRACTS.curve === zeroAddress || addresses.length === 0) {
      setStats({});
      return;
    }
    (async () => {
      const entries = await Promise.all(
        addresses.map(async (addr): Promise<[string, CurveStat]> => {
          const lc = addr.toLowerCase();
          try {
            const cv = await pc.readContract({ address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "curves", args: [addr as Address] });
            if (!cv[10]) return [lc, EMPTY]; // not registered on the curve
            const [quote, , , , , virtualQuote, tokenReserve, realQuote, graduationQuote, graduated] = cv;
            const info = await quoteInfo(pc, quote);
            const quoteDec = info.decimals;

            let priceUsd: number | null = null;
            let mcapUsd: number | null = null;
            if (!graduated && tokenReserve > 0n) {
              const quoteUsd = await cachedQuoteUsd(pc, quote);
              if (quoteUsd != null) {
                const priceQuote = (Number(virtualQuote) / 10 ** quoteDec) / (Number(tokenReserve) / 1e18);
                priceUsd = priceQuote * quoteUsd;
                try {
                  const supply = await pc.readContract({ address: addr as Address, abi: erc20Abi, functionName: "totalSupply" });
                  mcapUsd = priceUsd * (Number(supply) / 1e18);
                } catch { /* keep priceUsd, leave mcap null */ }
              }
            } else if (graduated) {
              // Graduated: the coin's own USD price comes from its locked pool (same path a coin anchor uses).
              const priceFromPool = await cachedQuoteUsd(pc, addr);
              if (priceFromPool != null) {
                priceUsd = priceFromPool;
                try {
                  const supply = await pc.readContract({ address: addr as Address, abi: erc20Abi, functionName: "totalSupply" });
                  mcapUsd = priceUsd * (Number(supply) / 1e18);
                } catch { /* leave mcap null */ }
              }
            }
            const gradPct = graduated ? 100 : graduationQuote > 0n ? Math.min(100, Math.round(Number((realQuote * 10000n) / graduationQuote) / 100)) : null;
            const reserve = Number(realQuote) / 10 ** quoteDec;
            const graduationTarget = graduationQuote > 0n ? Number(graduationQuote) / 10 ** quoteDec : null;
            return [lc, { priceUsd, mcapUsd, gradPct, graduated, anchor: info.symbol, anchorIsCoin: info.isCoin, quoteAddress: quote, reserve, graduationTarget }];
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
