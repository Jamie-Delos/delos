// Resolve a launched coin's trading state from the CensusCurve: the anchor it trades against (WETH by
// default, or HOOD, …), whether it's registered on the curve, whether it's a Maxima (rewards-basket)
// coin, and whether it has graduated to a real, locked Uniswap pool. Pre-graduation every trade is on
// the curve; post-graduation the coin trades on its pool (the Coin page's 0x/pool path).
import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { zeroAddress, type Address } from "viem";
import { CONTRACTS } from "../config";
import { erc20Abi, censusCurveAbi } from "../abis";

export type CoinQuote = {
  quote: Address; // the anchor/quote token the coin trades against
  isV2: boolean; // Maxima (has a rewards vault) vs Prima
  resolved: boolean; // true once the curve registry has been read (registered or not)
  name?: string; // real on-chain token name
  symbol?: string;
  routed?: boolean; // registered on the CensusCurve (curves(coin).exists)
  graduated?: boolean; // curve filled + migrated to a real, permanently-locked Uniswap pool
  routerPoolFee?: number; // the coin's (graduated) pool fee tier, from the curve registry
  creator?: Address; // the coin's creator (creator-side fee recipient), from the curve registry
  vault?: Address; // Maxima rewards vault (zero for Prima)
  holdersBps?: number; // holders' share of the creator side (Maxima)
  virtualQuote?: bigint; // V — current virtual quote reserve (spot price = virtualQuote / tokenReserve)
  tokenReserve?: bigint; // tokens still in the curve
  realQuote?: bigint; // quote raised so far (for the graduation reserve caption)
  graduationQuote?: bigint; // quote needed to graduate
  totalSupply?: bigint; // the coin's ERC-20 total supply (for market cap / FDV)
};

// Read the coin's CensusCurve state (curves(coin)) — the authoritative anchor, pool-fee tier, vault
// flag and graduation state — plus its real ERC-20 name/symbol/supply.
export function useCoinQuote(coin?: string): CoinQuote {
  const pc = usePublicClient();
  const [info, setInfo] = useState<CoinQuote>({ quote: CONTRACTS.weth, isV2: false, resolved: false });

  useEffect(() => {
    let cancelled = false;
    const c = (coin || "").toLowerCase();
    setInfo({ quote: CONTRACTS.weth, isV2: false, resolved: false });
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

      // CensusCurve registration is the source of truth. curves(coin) returns the 11-field tuple:
      // quote@0, creator@1, vault@2, holdersBps@3, poolFee@4, virtualQuote@5, tokenReserve@6,
      // realQuote@7, graduationQuote@8, graduated@9, exists@10.
      if (CONTRACTS.curve === zeroAddress) { if (!cancelled) setInfo((prev) => ({ ...prev, resolved: true })); return; }
      try {
        const cv = await pc.readContract({ address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "curves", args: [coin as Address] });
        if (cancelled) return;
        if (!cv[10]) { setInfo((prev) => ({ ...prev, resolved: true, routed: false })); return; }
        setInfo((prev) => ({
          ...prev,
          quote: cv[0],
          creator: cv[1],
          vault: cv[2],
          holdersBps: Number(cv[3]),
          isV2: cv[2] !== zeroAddress, // a Maxima coin has a rewards vault; Prima's vault is address(0)
          routerPoolFee: Number(cv[4]),
          virtualQuote: cv[5],
          tokenReserve: cv[6],
          realQuote: cv[7],
          graduationQuote: cv[8],
          graduated: cv[9],
          routed: true,
          resolved: true,
        }));
      } catch { if (!cancelled) setInfo((prev) => ({ ...prev, resolved: true, routed: false })); }
    })();
    return () => { cancelled = true; };
  }, [pc, coin]);

  return info;
}
