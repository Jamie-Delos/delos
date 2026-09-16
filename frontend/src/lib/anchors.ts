// Launch "anchors" — the quote asset a coin's bonding curve (and, after graduation, its locked pool) is
// priced in. Default is ETH (WETH). A non-ETH anchor pairs the coin directly against that token (e.g.
// HOOD/TOKEN), the stock-anchored model that is a live meta on Robinhood Chain: OPENAI, ANTHROPIC,
// NVDA, HOOD… are all used as anchors on-chain. Both tiers take any anchor — Prima simply trades in it;
// Maxima collects fees in it and its vault swaps them into the stock basket (lib/basket.ts).
//
// Two kinds of anchor:
//   - the fixed menu below (ETH, HOOD): each needs a `pricePool` (its quote/USDG pool) for USD pricing,
//     plus a zap path on the curve (CensusCurve.setZapPath) so plain-ETH buyers can reach it;
//   - any GRADUATED Census coin ("company coin"): priced through its own locked pool back to its anchor,
//     recursively, so a coin anchored to a coin anchored to HOOD still gets a real dollar figure.
import { isAddress, parseUnits, zeroAddress, type Address, type PublicClient } from "viem";
import { CONTRACTS, DEFAULT_FEE, IS_MAINNET, START_FDV_ETH } from "../config";
import { censusCurveAbi, erc20Abi, poolAbi } from "../abis";
import { poolSpotOut } from "./pool";

// ETH price used only when no WETH/USDG pool is configured (testnet). On mainnet ETH is read live from
// CONTRACTS.ethPricePool exactly like any other anchor.
export const ETH_USD_FALLBACK = 3000;

export type Anchor = {
  key: string; // ticker shown in the picker
  label: string;
  quote: Address; // the curve's quote token — the coin is paired against this
  quoteDecimals: number;
  logo: string; // real asset logo shown in the anchor picker / preview ("" => lettermark)
  // The anchor/USDG V3 pool used to read the anchor's live USD price. The OTHER side of this pool must
  // be USDG (≈ $1). Omitted => ETH_USD_FALLBACK for ETH, unpriceable for anything else.
  pricePool?: Address;
  // Its liquidity only exists on mainnet: shown in the picker everywhere, selectable on mainnet only.
  mainnetOnly?: boolean;
  // A graduated Census coin used as the anchor (priced via lib/pool.ts, not a pricePool).
  coin?: boolean;
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
export const anchorByQuote = (quote: string): Anchor | undefined => ANCHORS.find((a) => a.quote.toLowerCase() === quote.toLowerCase());
export const anchorAvailable = (a: Anchor) => IS_MAINNET || !a.mainnetOnly;
export const isCoinKey = (key: string) => isAddress(key);
// A graduated Census coin as the anchor. `symbol` is what the picker showed (the draft caches it).
export const coinAnchor = (address: Address, symbol: string): Anchor =>
  ({ key: symbol || `${address.slice(0, 6)}…`, label: symbol || "Company coin", quote: address, quoteDecimals: 18, logo: "", coin: true });
// The wizard's draft key: "ETH" | "HOOD" | a coin address.
export const anchorByKey = (key: string, symbol = ""): Anchor =>
  isCoinKey(key) ? coinAnchor(key as Address, symbol) : (ANCHORS.find((a) => a.key === key) ?? ETH);

// Live USD price of a menu anchor from its USDG pool (USDG ≈ $1). ETH without a pool uses the fallback.
async function poolUsdPrice(pc: PublicClient, a: Anchor): Promise<number> {
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

// USD price of a Census coin: its price in its own anchor (curve spot pre-graduation, the locked pool's
// spot after) times that anchor's USD price — recursive for coins anchored to coins (depth-capped).
async function coinUsdPrice(pc: PublicClient, coin: Address, depth: number): Promise<number> {
  if (depth > 3 || CONTRACTS.curve === zeroAddress) throw new Error("unpriceable anchor");
  const cv = await pc.readContract({ address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "curves", args: [coin] });
  if (!cv[10]) throw new Error("not a Census coin");
  const [quote, , , , poolFee, virtualQuote, tokenReserve, , , graduated] = cv;
  const usdA = await quoteUsdDepth(pc, quote, depth + 1);
  if (usdA == null) throw new Error("anchor unpriceable");
  const decA = (await quoteInfo(pc, quote)).decimals;
  let priceInA: number;
  if (graduated) {
    const out = await poolSpotOut(pc, quote, coin, parseUnits("1", decA), poolFee || DEFAULT_FEE);
    if (out == null || out <= 0n) throw new Error("no pool price");
    priceInA = 1 / (Number(out) / 1e18);
  } else {
    if (tokenReserve <= 0n) throw new Error("no curve price");
    priceInA = (Number(virtualQuote) / 10 ** decA) / (Number(tokenReserve) / 1e18);
  }
  return priceInA * usdA;
}

export const quoteUsdPrice = (pc: PublicClient, a: Anchor): Promise<number> => (a.coin ? coinUsdPrice(pc, a.quote, 0) : poolUsdPrice(pc, a));
export const ethUsdPrice = (pc: PublicClient) => poolUsdPrice(pc, ETH);

// USD price of any quote asset by address — menu anchor or Census coin — cached for a minute so the
// board doesn't re-read pools per row. null when it can't be priced (UI shows "—", never a made-up $).
const priceCache = new Map<string, { at: number; p: Promise<number | null> }>();
function quoteUsdDepth(pc: PublicClient, quote: string, depth: number): Promise<number | null> {
  const key = quote.toLowerCase();
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const a = anchorByQuote(quote);
  const p = (a ? poolUsdPrice(pc, a) : coinUsdPrice(pc, quote as Address, depth)).catch(() => null);
  priceCache.set(key, { at: Date.now(), p });
  return p;
}
export const cachedQuoteUsd = (pc: PublicClient, quote: string) => quoteUsdDepth(pc, quote, 0);

// What a quote asset is called and how it's denominated (menu anchor, or an ERC-20 read once).
export type QuoteInfo = { symbol: string; decimals: number; isCoin: boolean };
const infoCache = new Map<string, Promise<QuoteInfo>>();
export function quoteInfo(pc: PublicClient, quote: string): Promise<QuoteInfo> {
  const key = quote.toLowerCase();
  const hit = infoCache.get(key);
  if (hit) return hit;
  const a = anchorByQuote(quote);
  const p: Promise<QuoteInfo> = a
    ? Promise.resolve({ symbol: a.key, decimals: a.quoteDecimals, isCoin: false })
    : (async () => {
        const addr = quote as Address;
        const [symbol, decimals, isCoin] = await Promise.all([
          pc.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }).catch(() => `${quote.slice(0, 6)}…`),
          pc.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" }).then(Number).catch(() => 18),
          CONTRACTS.curve === zeroAddress ? Promise.resolve(false)
            : pc.readContract({ address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "curves", args: [addr] }).then((cv) => cv[10]).catch(() => false),
        ]);
        return { symbol, decimals, isCoin };
      })();
  infoCache.set(key, p);
  return p;
}

// Fully-diluted market cap (in ETH terms) the curve reaches when it graduates after raising `g` ETH:
// constant product with virtual reserve V0 => price = (V0+g)² / (V0·S), FDV = (V0+g)² / V0.
export const graduationFdvEth = (g: number) => ((START_FDV_ETH + g) ** 2) / START_FDV_ETH;

// CensusCurve launch params for an anchor + graduation target. The curve is priced in the anchor's own
// asset, so the ETH-denominated targets (start FDV, graduation reserve) are converted to quote-wei via
// live USD prices. For ETH this is an identity; for HOOD or a company coin it scales by that asset's
// price so the same USD band holds:  virtualQuote = START_FDV_ETH·ethUsd/quoteUsd,  graduationQuote =
// graduationEth·ethUsd/quoteUsd.
export async function curveLaunchParams(
  pc: PublicClient,
  a: Anchor,
  graduationEth: number,
): Promise<{ quote: Address; virtualQuote: bigint; graduationQuote: bigint }> {
  const ethUsd = await ethUsdPrice(pc);
  const quoteUsd = isDefaultAnchor(a) ? ethUsd : await quoteUsdPrice(pc, a);
  if (!(quoteUsd > 0) || !Number.isFinite(quoteUsd)) throw new Error(`couldn't price ${a.key} on-chain`);
  const toQuoteWei = (ethAmount: number) => parseUnits(((ethAmount * ethUsd) / quoteUsd).toFixed(a.quoteDecimals), a.quoteDecimals);
  return {
    quote: a.quote,
    virtualQuote: toQuoteWei(START_FDV_ETH),
    graduationQuote: toQuoteWei(graduationEth),
  };
}
