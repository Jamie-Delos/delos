// The swap route a Maxima vault uses to turn a coin's fee (paid in the coin's anchor) into one basket
// stock. ETH/HOOD anchors use the stored routes (lib/stockRoutes.basketPath). A coin anchored to
// another Census coin sells through that coin's own locked pool first and then follows the parent
// anchor's route, so the path is built recursively from the curve registry:
//   coin -> (its pool's fee tier) -> parent anchor -> … -> stock
import { zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { CONTRACTS, DEFAULT_FEE } from "../config";
import { censusCurveAbi } from "../abis";
import { basketPath } from "./stockRoutes";
import { anchorByQuote } from "./anchors";

export async function basketPathFor(pc: PublicClient, quote: Address, ticker: string, depth = 0): Promise<Hex> {
  if (anchorByQuote(quote)) return basketPath(quote, ticker);
  if (depth > 3 || CONTRACTS.curve === zeroAddress) throw new Error("This anchor can't be routed into a stock basket.");
  const cv = await pc.readContract({ address: CONTRACTS.curve, abi: censusCurveAbi, functionName: "curves", args: [quote] });
  if (!cv[10] || !cv[9]) throw new Error("The anchor coin hasn't graduated yet, so its pool doesn't exist.");
  const parentQuote = cv[0];
  const parent = await basketPathFor(pc, parentQuote, ticker, depth + 1);
  // "0x" from the parent means the stock IS the parent anchor: one hop, coin -> parent.
  const tail = parent === "0x" ? parentQuote.slice(2) : parent.slice(2);
  const fee = (cv[4] || DEFAULT_FEE).toString(16).padStart(6, "0");
  return (`0x${quote.slice(2)}${fee}${tail}`).toLowerCase() as Hex;
}
