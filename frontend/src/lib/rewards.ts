// Holder rewards for a Maxima coin, read straight off its DividendVault: the basket, what the connected
// wallet can withdraw per stock right now, and the fees that have arrived but not yet been swapped into
// the basket (they sit in the vault as the anchor asset until the operator runs distribute()).
import { type Address, type PublicClient } from "viem";
import { vaultAbi, erc20Abi } from "../abis";
import { STOCK_ROUTES } from "./stockRoutes";

export type StockReward = { stock: Address; ticker: string; decimals: number; amount: bigint };
export type Rewards = { vault: Address; undistributed: bigint; stocks: StockReward[] };

const tickerFor = (stock: string) => Object.values(STOCK_ROUTES).find((r) => r.address.toLowerCase() === stock.toLowerCase())?.ticker;

export async function readRewards(pc: PublicClient, vault: Address, quote: Address, holder?: Address): Promise<Rewards> {
  const n = Number(await pc.readContract({ address: vault, abi: vaultAbi, functionName: "basketLength" }));
  const stocks = await Promise.all(Array.from({ length: n }, async (_, i): Promise<StockReward> => {
    const stock = await pc.readContract({ address: vault, abi: vaultAbi, functionName: "basket", args: [BigInt(i)] });
    const [symbol, decimals, amount] = await Promise.all([
      pc.readContract({ address: stock, abi: erc20Abi, functionName: "symbol" }).catch(() => ""),
      pc.readContract({ address: stock, abi: erc20Abi, functionName: "decimals" }).then(Number).catch(() => 18),
      holder ? pc.readContract({ address: vault, abi: vaultAbi, functionName: "withdrawableOf", args: [holder, stock] }).catch(() => 0n) : Promise.resolve(0n),
    ]);
    return { stock, ticker: tickerFor(stock) ?? symbol ?? `${stock.slice(0, 6)}…`, decimals, amount };
  }));
  const undistributed = await pc.readContract({ address: quote, abi: erc20Abi, functionName: "balanceOf", args: [vault] }).catch(() => 0n);
  return { vault, undistributed, stocks };
}
