// Launch "anchors" — the asset a Prima (v1) coin's pool is quoted in.
//
// Default is ETH (WETH); a non-ETH anchor pairs the coin DIRECTLY against that token (pool becomes
// e.g. HOOD/TOKEN), the Lunch.fun stock-anchored model. On-chain discovery (block ~57.9M) shows this
// is a live meta on Robinhood Chain — the most-used non-stablecoin anchors are OPENAI (112 coins),
// ANTHROPIC (58), ZEC (58), NVDA (56), XMR (48), SAMSUNG (26), HOOD (24), SPCX (20)… To add one:
// drop an entry below with its `quote` address and a `pricePool` (its quote/USDG pool, for USD pricing).
//
// The contract side is already general: LaunchFactory.createLaunch(params, salt, quote). Only v1
// supports anchors — v2 (Maxima) routes its dividend basket in WETH, so it stays ETH-quoted for now.
import { parseUnits, type Address, type PublicClient } from "viem";
import { CONTRACTS, START_FDV_ETH } from "../config";
import { poolAbi, erc20Abi } from "../abis";

// ETH reference price for converting the ETH-denominated curve targets (start FDV, graduation) into a
// non-ETH anchor's own quote units. For ETH anchors this is a no-op (quoteUsd == ETH_USD).
export const ETH_USD = 3000;

export type Anchor = {
  key: string; // ticker shown in the picker
  label: string;
  quote: Address; // the pool's quote token — the coin is paired against this
  color: string;
  quoteDecimals: number;
  logo: string; // real asset logo shown in the anchor picker / preview
  // Non-ETH anchors: the anchor/USDG V3 pool used to read the anchor's live USD price. The OTHER side
  // of this pool must be USDG (≈ $1). Omit for ETH (priced by the ETH_USD constant).
  pricePool?: Address;
};

const WETH = CONTRACTS.weth;
const HOOD = "0x32ac8c1d7672667d5ebdea22935f7b06fc8d496f" as Address;

export const ANCHORS: Anchor[] = [
  {
    key: "ETH",
    label: "Ethereum",
    quote: WETH,
    color: "#627eea",
    quoteDecimals: 18,
    logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png",
  },
  {
    key: "HOOD",
    label: "Robinhood",
    quote: HOOD,
    color: "#00c805",
    quoteDecimals: 18,
    logo: "https://financialmodelingprep.com/image-stock/HOOD.png", // Robinhood (HOOD) is a listed stock
    pricePool: "0x1c1f6e283a72a68c15c816324363c794151cf913", // HOOD/USDG 1% (deepest HOOD quote pool)
  },
];

export const isDefaultAnchor = (a: Anchor) => a.quote.toLowerCase() === WETH.toLowerCase();
export const anchorByKey = (key: string): Anchor => ANCHORS.find((a) => a.key === key) ?? ANCHORS[0];

/// Live USD price of the anchor asset (USDG ≈ $1). ETH uses the calibration constant (no read).
export async function quoteUsdPrice(pc: PublicClient, a: Anchor): Promise<number> {
  if (isDefaultAnchor(a) || !a.pricePool) return ETH_USD;
  const [slot0, t0, t1] = await Promise.all([
    pc.readContract({ address: a.pricePool, abi: poolAbi, functionName: "slot0" }) as Promise<readonly [bigint, number, number, number, number, number, boolean]>,
    pc.readContract({ address: a.pricePool, abi: poolAbi, functionName: "token0" }) as Promise<Address>,
    pc.readContract({ address: a.pricePool, abi: poolAbi, functionName: "token1" }) as Promise<Address>,
  ]);
  const [d0, d1] = await Promise.all([
    pc.readContract({ address: t0, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
    pc.readContract({ address: t1, abi: erc20Abi, functionName: "decimals" }) as Promise<number>,
  ]);
  const sqrt = Number(slot0[0]);
  const rawP = (sqrt / 2 ** 96) ** 2; // token1/token0 in raw units
  const human = rawP * 10 ** (Number(d0) - Number(d1)); // token1 per token0 (human units)
  const quoteIsToken0 = t0.toLowerCase() === a.quote.toLowerCase();
  return quoteIsToken0 ? human : human > 0 ? 1 / human : 0; // USD per anchor
}

/// CensusCurve launch params for an anchor + graduation target. The curve is priced in the anchor's
/// own quote asset, so the ETH-denominated targets (start FDV, graduation reserve) are converted to
/// quote-wei via the anchor's live USD price. For ETH this is a no-op (quoteUsd == ETH_USD); for HOOD
/// it scales by the live HOOD price so the same USD band holds.
///  - virtualQuote  = START_FDV_ETH   * ETH_USD / quoteUsd  (the curve's V0 virtual quote reserve)
///  - graduationQuote = graduationEth * ETH_USD / quoteUsd  (raise this much quote to graduate)
export async function curveLaunchParams(
  pc: PublicClient,
  a: Anchor,
  graduationEth: number,
): Promise<{ quote: Address; virtualQuote: bigint; graduationQuote: bigint }> {
  const quoteUsd = await quoteUsdPrice(pc, a);
  if (!(quoteUsd > 0) || !Number.isFinite(quoteUsd)) throw new Error(`couldn't read ${a.key} price on-chain`);
  const toQuoteWei = (ethAmount: number) => {
    const value = (ethAmount * ETH_USD) / quoteUsd; // amount in quote-asset units
    return parseUnits(value.toFixed(a.quoteDecimals === 6 ? 6 : 18), a.quoteDecimals);
  };
  return {
    quote: a.quote,
    virtualQuote: toQuoteWei(START_FDV_ETH),
    graduationQuote: toQuoteWei(graduationEth),
  };
}

