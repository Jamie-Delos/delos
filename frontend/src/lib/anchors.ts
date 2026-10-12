// Launch "anchors" — the quote asset a coin's bonding curve (and, after graduation, its canonical pool)
// is priced in. Default is ETH (WETH). A non-ETH anchor pairs the coin directly against that token (e.g.
// HOOD/TOKEN), the stock-anchored model that is a live meta on Robinhood Chain: OPENAI, ANTHROPIC,
// NVDA, HOOD… are all used as anchors on-chain. Every launch takes any anchor — it trades in it, and a
// reflection vault collects fees in it and turns them into the reward basket (lib/basket.ts).
//
// Two kinds of anchor:
//   - the fixed menu below (ETH, HOOD): each needs a `pricePool` (its quote/USDG V3 pool) for USD pricing,
//     plus a zap path on the curve (setZapPath) so plain-ETH buyers can reach it;
//   - any GRADUATED V4 Census coin ("company coin"): priced through its own canonical pool back to its
//     anchor, recursively, so a coin anchored to a coin anchored to HOOD still gets a real dollar figure.
import { isAddress, parseUnits, zeroAddress, type Address, type PublicClient } from "viem";
import { CONTRACTS, LEGACY_V3_POOL_FEE, IS_MAINNET, START_FDV_ETH } from "../config";
import { erc20Abi, poolAbi } from "../abis";
import { poolSpotOut, poolRawPrice } from "./pool";
import { readTokenOffset, curveSpot } from "./curveOffset";
import { readCurve, hasAnyCurve } from "./curves";
import { v4SpotPrice } from "./v4pool";

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
  const [priced, t0, t1] = await Promise.all([
    poolRawPrice(pc, a.pricePool), // TWAP-first (spot fallback for a warming pool) — CX-H1
    pc.readContract({ address: a.pricePool, abi: poolAbi, functionName: "token0" }),
    pc.readContract({ address: a.pricePool, abi: poolAbi, functionName: "token1" }),
  ]);
  const USDG_DECIMALS = 6;
  const quoteIsToken0 = t0.toLowerCase() === a.quote.toLowerCase();
  if (!quoteIsToken0 && t1.toLowerCase() !== a.quote.toLowerCase()) throw new Error(`${a.key} price pool doesn't contain ${a.key}`);
  if (priced == null) throw new Error(`couldn't read ${a.key} price on-chain`);
  const rawP = priced.raw; // token1 per token0, raw units
  const [d0, d1] = quoteIsToken0 ? [a.quoteDecimals, USDG_DECIMALS] : [USDG_DECIMALS, a.quoteDecimals];
  const human = rawP * 10 ** (d0 - d1); // token1 per token0, human units
  const usd = quoteIsToken0 ? human : human > 0 ? 1 / human : 0;
  if (!(usd > 0) || !Number.isFinite(usd)) throw new Error(`couldn't read ${a.key} price on-chain`);
  return usd;
}

// USD price of a Census coin: its price in its own anchor (curve spot pre-graduation, the canonical
// pool's spot after) times that anchor's USD price — recursive for coins anchored to coins. Guarded two ways:
// a depth cap AND a `seen` set (CX-H2). The cycle guard matters because the shared price cache can hand
// back an IN-FLIGHT promise for a coin already being priced upstream, so an A↔B anchor pair would await
// each other forever (a hang) rather than hit the depth cap. On-chain rules prevent cycles today; this
// makes an accidental one resolve to "—" instead of hanging the row.
async function coinUsdPrice(pc: PublicClient, coin: Address, depth: number, seen: Set<string>): Promise<number> {
  if (depth > 3 || !hasAnyCurve()) throw new Error("unpriceable anchor");
  const key = coin.toLowerCase();
  if (seen.has(key)) throw new Error("anchor cycle");
  seen.add(key);
  const rec = await readCurve(pc, coin);
  if (!rec) throw new Error("not a Census coin");
  const { quote, virtualQuote, tokenReserve, graduated } = rec;
  const usdA = await quoteUsdDepth(pc, quote, depth + 1, seen);
  if (usdA == null) throw new Error("anchor unpriceable");
  const decA = (await quoteInfo(pc, quote)).decimals;
  let priceInA: number;
  if (graduated && rec.venue === "v4") {
    // V4: the canonical hooked pool's spot (there is no TWAP in V4).
    const spot = await v4SpotPrice(pc, coin, quote, decA);
    if (spot == null) throw new Error("no pool price");
    priceInA = spot;
  } else if (graduated) {
    // Legacy: the V3 pool the old curve minted.
    const out = await poolSpotOut(pc, quote, coin, parseUnits("1", decA), rec.legacyPoolFee || LEGACY_V3_POOL_FEE);
    if (out == null || out <= 0n) throw new Error("no pool price");
    priceInA = 1 / (Number(out) / 1e18);
  } else {
    const spot = curveSpot(virtualQuote, tokenReserve, await readTokenOffset(pc, rec.curve, coin), decA);
    if (spot == null) throw new Error("no curve price");
    priceInA = spot;
  }
  return priceInA * usdA;
}

export const quoteUsdPrice = (pc: PublicClient, a: Anchor): Promise<number> => (a.coin ? coinUsdPrice(pc, a.quote, 0, new Set()) : poolUsdPrice(pc, a));
export const ethUsdPrice = (pc: PublicClient) => poolUsdPrice(pc, ETH);

// USD price of any quote asset by address — menu anchor or Census coin — cached for a minute so the
// board doesn't re-read pools per row. null when it can't be priced (UI shows "—", never a made-up $).
const priceCache = new Map<string, { at: number; p: Promise<number | null> }>();
function quoteUsdDepth(pc: PublicClient, quote: string, depth: number, seen: Set<string>): Promise<number | null> {
  const key = quote.toLowerCase();
  if (seen.has(key)) return Promise.resolve(null); // anchor cycle: this coin is already being priced upstream (CX-H2)
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const a = anchorByQuote(quote);
  const p = (a ? poolUsdPrice(pc, a) : coinUsdPrice(pc, quote as Address, depth, seen)).catch(() => null);
  priceCache.set(key, { at: Date.now(), p });
  return p;
}
// Each top-level lookup starts a fresh `seen` set (the cache is shared and path-independent across them).
export const cachedQuoteUsd = (pc: PublicClient, quote: string) => quoteUsdDepth(pc, quote, 0, new Set());

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
          hasAnyCurve() ? readCurve(pc, addr).then((r) => !!r).catch(() => false) : Promise.resolve(false),
        ]);
        return { symbol, decimals, isCoin };
      })();
  infoCache.set(key, p);
  return p;
}

// Fully-diluted market cap (in ETH terms) at graduation after raising `g` ETH net. PF-style curve:
// unminted offset X = S·V0²/(g·(g+2V0)), so the exit price is g·(g+2V0)/(V0·S) and FDV = g·(2V0+g)/V0
// (2.67 ETH for the temporary 1 ETH target with V0 = 1.5). The pool opens at exactly this price.
export const graduationFdvEth = (g: number) => (g * (2 * START_FDV_ETH + g)) / START_FDV_ETH;

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
  // ETH targets are already denominated in the quote asset. A USD oracle adds no information
  // here and must not block a launch when its pool or RPC is unavailable. Direct parsing also
  // avoids floating-point rounding from multiplying and dividing by the same USD price.
  if (isDefaultAnchor(a)) {
    return {
      quote: a.quote,
      virtualQuote: parseUnits(String(START_FDV_ETH), a.quoteDecimals),
      graduationQuote: parseUnits(String(graduationEth), a.quoteDecimals),
    };
  }
  const ethUsd = await ethUsdPrice(pc);
  const quoteUsd = await quoteUsdPrice(pc, a);
  if (!(quoteUsd > 0) || !Number.isFinite(quoteUsd)) throw new Error(`couldn't price ${a.key} on-chain`);
  const toQuoteWei = (ethAmount: number) => parseUnits(((ethAmount * ethUsd) / quoteUsd).toFixed(a.quoteDecimals), a.quoteDecimals);
  return {
    quote: a.quote,
    virtualQuote: toQuoteWei(START_FDV_ETH),
    graduationQuote: toQuoteWei(graduationEth),
  };
}
