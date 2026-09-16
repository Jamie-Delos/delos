// Launch "anchors" — the quote asset a coin's bonding curve (and, after graduation, its locked pool) is
// priced in. Default is ETH (WETH). A non-ETH anchor pairs the coin directly against that token (e.g.
// HOOD/TOKEN), the stock-anchored model that is a live meta on Robinhood Chain: OPENAI, ANTHROPIC,
// NVDA, HOOD… are all used as anchors on-chain. Both tiers take any anchor — Prima simply trades in it;
// Maxima collects fees in it and its vault swaps them into the stock basket (lib/stockRoutes.basketPath).
//
// To add an anchor: an entry below with its `quote` address and a `pricePool` (its quote/USDG pool, for
// USD pricing), plus a zap path on the curve (CensusCurve.setZapPath) so plain-ETH buyers can reach it.
import { parseUnits, zeroAddress, type Address, type PublicClient } from "viem";
import { CONTRACTS, IS_MAINNET, START_FDV_ETH } from "../config";
import { poolAbi } from "../abis";

// ETH price used only when no WETH/USDG pool is configured (testnet). On mainnet ETH is read live from
// CONTRACTS.ethPricePool exactly like any other anchor.
export const ETH_USD_FALLBACK = 3000;

export type Anchor = {
  key: string; // ticker shown in the picker
  label: string;
  quote: Address; // the curve's quote token — the coin is paired against this
  quoteDecimals: number;
  logo: string; // real asset logo shown in the anchor picker / preview
  // The anchor/USDG V3 pool used to read the anchor's live USD price. The OTHER side of this pool must
  // be USDG (≈ $1). Omitted => ETH_USD_FALLBACK for ETH, unpriceable for anything else.
  pricePool?: Address;
  // Its liquidity only exists on mainnet: shown in the picker everywhere, selectable on mainnet only.
  mainnetOnly?: boolean;
};

const ETH: Anchor = {
  key: "ETH",
  label: "Ethereum",
  quote: CONTRACTS.weth,
  quoteDecimals: 18,
  logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
  pricePool: CONTRACTS.ethPricePool !== zeroAddress ? CONTRACTS.ethPricePool : undefined,
};
const HOOD: Anchor = {
  key: "HOOD",
  label: "Robinhood",
  quote: "0x32ac8c1d7672667d5ebdea22935f7b06fc8d496f",
  quoteDecimals: 18,
  logo: "https://financialmodelingprep.com/image-stock/HOOD.png", // Robinhood (HOOD) is a listed stock
  pricePool: "0x1c1f6e283a72a68c15c816324363c794151cf913", // HOOD/USDG 1% (deepest HOOD quote pool)
  mainnetOnly: true,
};

export const ANCHORS: Anchor[] = [ETH, HOOD];

export const isDefaultAnchor = (a: Anchor) => a.quote.toLowerCase() === CONTRACTS.weth.toLowerCase();
export const anchorByKey = (key: string): Anchor => ANCHORS.find((a) => a.key === key) ?? ETH;
export const anchorByQuote = (quote: string): Anchor | undefined => ANCHORS.find((a) => a.quote.toLowerCase() === quote.toLowerCase());
export const anchorAvailable = (a: Anchor) => IS_MAINNET || !a.mainnetOnly;

// Live USD price of an anchor from its USDG pool (USDG ≈ $1). ETH without a pool uses the fallback.
export async function quoteUsdPrice(pc: PublicClient, a: Anchor): Promise<number> {
  if (!a.pricePool) {
    if (isDefaultAnchor(a)) return ETH_USD_FALLBACK;
    throw new Error(`${a.key} has no price pool on this network`);
  }
  const [slot0, t0, t1] = await Promise.all([
    pc.readContract({ address: a.pricePool, abi: poolAbi, functionName: "slot0" }),
    pc.readContract({ address: a.pricePool, abi: poolAbi, functionName: "token0" }),
    pc.readContract({ address: a.pricePool, abi: poolAbi, functionName: "token1" }),
  ]);
  const USDG_DECIMALS = 6;
  const quoteIsToken0 = t0.toLowerCase() === a.quote.toLowerCase();
  if (!quoteIsToken0 && t1.toLowerCase() !== a.quote.toLowerCase()) throw new Error(`${a.key} price pool doesn't contain ${a.key}`);
  const rawP = (Number(slot0[0]) / 2 ** 96) ** 2; // token1 per token0, raw units
  const [d0, d1] = quoteIsToken0 ? [a.quoteDecimals, USDG_DECIMALS] : [USDG_DECIMALS, a.quoteDecimals];
  const human = rawP * 10 ** (d0 - d1); // token1 per token0, human units
  const usd = quoteIsToken0 ? human : human > 0 ? 1 / human : 0;
  if (!(usd > 0) || !Number.isFinite(usd)) throw new Error(`couldn't read ${a.key} price on-chain`);
  return usd;
}
export const ethUsdPrice = (pc: PublicClient) => quoteUsdPrice(pc, ETH);

// USD price of a coin's quote asset, by address, cached for a minute so the board doesn't re-read the
// price pool per row. null when the quote isn't a known anchor or the read fails (UI shows "—").
const priceCache = new Map<string, { at: number; p: Promise<number | null> }>();
export function cachedQuoteUsd(pc: PublicClient, quote: string): Promise<number | null> {
  const key = quote.toLowerCase();
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const a = anchorByQuote(quote);
  const p = a ? quoteUsdPrice(pc, a).catch(() => null) : Promise.resolve(null);
  priceCache.set(key, { at: Date.now(), p });
  return p;
}

// Fully-diluted market cap (in ETH terms) the curve reaches when it graduates after raising `g` ETH:
// constant product with virtual reserve V0 => price = (V0+g)² / (V0·S), FDV = (V0+g)² / V0.
export const graduationFdvEth = (g: number) => ((START_FDV_ETH + g) ** 2) / START_FDV_ETH;

// CensusCurve launch params for an anchor + graduation target. The curve is priced in the anchor's own
// asset, so the ETH-denominated targets (start FDV, graduation reserve) are converted to quote-wei via
// live USD prices. For ETH this is an identity; for HOOD it scales by HOOD's price so the same USD band
// holds:  virtualQuote = START_FDV_ETH·ethUsd/quoteUsd,  graduationQuote = graduationEth·ethUsd/quoteUsd.
export async function curveLaunchParams(
  pc: PublicClient,
  a: Anchor,
  graduationEth: number,
): Promise<{ quote: Address; virtualQuote: bigint; graduationQuote: bigint }> {
  const ethUsd = await ethUsdPrice(pc);
  const quoteUsd = isDefaultAnchor(a) ? ethUsd : await quoteUsdPrice(pc, a);
  const toQuoteWei = (ethAmount: number) => parseUnits(((ethAmount * ethUsd) / quoteUsd).toFixed(a.quoteDecimals), a.quoteDecimals);
  return {
    quote: a.quote,
    virtualQuote: toQuoteWei(START_FDV_ETH),
    graduationQuote: toQuoteWei(graduationEth),
  };
}
