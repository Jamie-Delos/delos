// The swap route a V4 reward vault uses to turn a coin's reflection fee (paid in the coin's quote asset)
// into one tokenised-stock basket entry. ETH/HOOD quotes use the stored V3 routes (lib/stockRoutes
// basketPath: WETH routes as-is, HOOD re-rooted via USDG). A coin anchored to another Census coin has
// no V3 route out of its V4 pool, so its basket is limited to "this coin" and the pairing coin (both a
// 0x path, credited directly) — the wizard enforces that; this throws if asked anyway.
import { type Address, type Hex } from "viem";
import { basketPath } from "./stockRoutes";
import { anchorByQuote } from "./anchors";

export function basketPathFor(quote: Address, ticker: string): Hex {
  if (anchorByQuote(quote)) return basketPath(quote, ticker);
  throw new Error("Stocks can't be routed from a company-coin anchor. Reward this coin or the pairing coin instead.");
}
