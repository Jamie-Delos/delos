// Resolve a launched coin's trading state from the CensusCurve: the quote/pairing asset it trades
// against (WETH by default, or HOOD, …), whether it's registered on the curve, whether it's a Maxima
// (dividend) coin, and whether it has graduated to a real, locked Uniswap pool. Pre-graduation every
// trade is on the curve; post-graduation the coin trades on its pool (the Coin page's 0x/pool path).
import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { type Address } from "viem";
import { CONTRACTS } from "../config";
import { erc20Abi, censusCurveAbi } from "../abis";

const ZERO = "0x0000000000000000000000000000000000000000";

export type CoinQuote = {
  quote: Address; // the pairing/quote token the coin trades against
  pool?: Address; // the coin's V3 pool (only exists once graduated)
  isV2: boolean; // Maxima (dividend) vs Prima
  resolved: boolean; // true once read from chain (false => WETH default / preview)
  name?: string; // real on-chain token name (falls back to caller's placeholder)
  symbol?: string;
  routed?: boolean; // registered on the CensusCurve (curves(coin).exists) — trades take the 2% fee there
  graduated?: boolean; // curve filled + migrated to a real, permanently-locked Uniswap pool
  routerPoolFee?: number; // the coin's (graduated) pool fee tier, from the curve registry
  creator?: Address; // the coin's creator (creator-side fee recipient), from the curve registry
  virtualQuote?: bigint; // V — current virtual quote reserve (spot price = virtualQuote / (tokenReserve + virtualTokenOffset))
  virtualTokenOffset?: bigint; // pricing only, not part of totalSupply
  tokenReserve?: bigint; // tokens still in the curve
  realQuote?: bigint; // quote raised so far (for the graduation reserve caption)
  graduationQuote?: bigint; // quote needed to graduate
  totalSupply?: bigint; // the coin's ERC-20 total supply (for market cap / FDV)
};

/// Read the coin's CensusCurve state (curves(coin)) — the authoritative quote asset, pool-fee tier,
/// dividend flag and graduation state — plus its real ERC-20 name/symbol.
export function useCoinQuote(coin?: string): CoinQuote {
  const pc = usePublicClient();
  const [info, setInfo] = useState<CoinQuote>({ quote: CONTRACTS.weth, isV2: false, resolved: false });

  useEffect(() => {
    let cancelled = false;
    const c = (coin || "").toLowerCase();
    if (!pc || c.length !== 42) return;
    (async () => {
      // Real token name/symbol/supply — read for any ERC-20 at this address, independent of our factory.
      try {
        const [nm, sym, sup] = await Promise.all([
          pc.readContract({ address: coin as Address, abi: erc20Abi, functionName: "name" }) as Promise<string>,
          pc.readContract({ address: coin as Address, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
          pc.readContract({ address: coin as Address, abi: erc20Abi, functionName: "totalSupply" }) as Promise<bigint>,
        ]);
        if (!cancelled) setInfo((prev) => ({ ...prev, name: nm || prev.name, symbol: sym || prev.symbol, totalSupply: sup ?? prev.totalSupply }));
      } catch { /* not an ERC-20 we can read — keep placeholder */ }

      // CensusCurve registration is the source of truth. curves(coin) returns the 11-field tuple:
      // quote@0, creator@1, vault@2, holdersBps@3, poolFee@4, virtualQuote@5, tokenReserve@6,
      // realQuote@7, graduationQuote@8, graduated@9, exists@10.
      if (CONTRACTS.curve !== ZERO) {
        try {
          const cv = (await pc.readContract({
            address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "curves", args: [coin as Address],
          })) as readonly [Address, Address, Address, number, number, bigint, bigint, bigint, bigint, boolean, boolean];
          const offset = cv[10] ? await pc.readContract({
            address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "virtualTokenOffset", args: [coin as Address],
          }).catch(() => undefined) as bigint | undefined : 0n; // hide spot price if offset unavailable; retain routing state
          if (!cancelled && cv[10]) {
            setInfo((prev) => ({
              ...prev,
              quote: cv[0],
              creator: cv[1],
              isV2: cv[2] !== ZERO, // a Maxima coin has a DividendVault; Prima's vault is address(0)
              routerPoolFee: Number(cv[4]),
              virtualQuote: cv[5],
              tokenReserve: cv[6],
              virtualTokenOffset: offset,
              realQuote: cv[7],
              graduationQuote: cv[8],
              graduated: cv[9],
              routed: true,
              resolved: true,
            }));
          }
        } catch { /* not registered on the curve — keep the WETH default / placeholder */ }
      }
    })();
    return () => { cancelled = true; };
  }, [pc, coin]);

  return info;
}
