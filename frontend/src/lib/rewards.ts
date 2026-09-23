// Holder rewards for a coin with a reflection vault (CensusRewardVault), read straight off the vault: the
// basket (assets + weights), what the connected wallet can withdraw per asset right now, and the quote
// fees that have arrived but not yet been distributed into the basket. Rewards are only ever paid in
// quoted assets — the coin's pairing asset and/or tokenised stocks allow-listed on CensusCurveV4 — never
// in the coin itself. `useAllowedRewardAssets` reads that allow-list once per session for the wizard.
import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { zeroAddress, type Address, type PublicClient } from "viem";
import { CONTRACTS, CHAIN } from "../config";
import { vaultAbi, erc20Abi, censusCurveV4Abi } from "../abis";
import { STOCK_ROUTES } from "./stockRoutes";
import { quoteInfo } from "./anchors";

export type RewardAsset = { asset: Address; ticker: string; decimals: number; weightBps: number; amount: bigint; isQuote: boolean };
export type Rewards = { vault: Address; undistributed: bigint; assets: RewardAsset[] };

const tickerFor = (asset: string) => Object.values(STOCK_ROUTES).find((r) => r.address.toLowerCase() === asset.toLowerCase())?.ticker;

export async function readRewards(pc: PublicClient, vault: Address, quote: Address, holder?: Address): Promise<Rewards> {
  const n = Number(await pc.readContract({ address: vault, abi: vaultAbi, functionName: "basketLength" }));
  const assets = await Promise.all(Array.from({ length: n }, async (_, i): Promise<RewardAsset> => {
    const [asset, weight] = await Promise.all([
      pc.readContract({ address: vault, abi: vaultAbi, functionName: "basket", args: [BigInt(i)] }),
      pc.readContract({ address: vault, abi: vaultAbi, functionName: "weights", args: [BigInt(i)] }).then(Number).catch(() => 0),
    ]);
    const isQuote = asset.toLowerCase() === quote.toLowerCase();
    const [symbol, decimals, amount] = await Promise.all([
      isQuote ? quoteInfo(pc, quote).then((q) => q.symbol) : pc.readContract({ address: asset, abi: erc20Abi, functionName: "symbol" }).catch(() => ""),
      pc.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" }).then(Number).catch(() => 18),
      holder ? pc.readContract({ address: vault, abi: vaultAbi, functionName: "withdrawableOf", args: [holder, asset] }).catch(() => 0n) : Promise.resolve(0n),
    ]);
    return { asset, ticker: tickerFor(asset) ?? symbol ?? `${asset.slice(0, 6)}…`, decimals, weightBps: weight, amount, isQuote };
  }));
  // V4 vault: availableQuote() is the exact undistributed quote; a legacy DividendVault has no such view.
  const undistributed = await pc.readContract({ address: vault, abi: vaultAbi, functionName: "availableQuote" })
    .catch(() => pc.readContract({ address: quote, abi: erc20Abi, functionName: "balanceOf", args: [vault] }).catch(() => 0n));
  return { vault, undistributed, assets };
}

export const hasClaimable = (r: Rewards | null | undefined) => !!r && r.assets.some((a) => a.amount > 0n);

// ---- the on-chain reward-asset allow-list (CensusCurveV4.allowedRewardAsset) ----

// Which of the routable tokenised stocks (lib/stockRoutes) the curve currently allows in a reward basket,
// as a set of lowercase addresses. The factory reverts `AssetNotAllowed` for anything else, so the
// wizard must never offer a stock that isn't in here. Read once per session (one eth_call per stock, in
// parallel) and shared by every mount; an unconfigured curve resolves to "nothing listed".
export type AllowedRewardAssets = { allowed: Set<string> | null; error: boolean }; // allowed === null while loading

type AllowedCache = { curve: string; promise: Promise<{ allowed: Set<string>; error: boolean }> };
let allowedCache: AllowedCache | null = null;

async function readAllowedRewardAssets(pc: PublicClient, curve: Address): Promise<{ allowed: Set<string>; error: boolean }> {
  const routes = Object.values(STOCK_ROUTES);
  let error = false;
  const flags = await Promise.all(routes.map((r) =>
    pc.readContract({ address: curve, abi: censusCurveV4Abi, functionName: "allowedRewardAsset", args: [r.address] })
      .catch(() => { error = true; return false; }), // a failed read is treated as "not listed" — never offer what we can't verify
  ));
  const allowed = new Set<string>();
  routes.forEach((r, i) => { if (flags[i]) allowed.add(r.address.toLowerCase()); });
  return { allowed, error };
}

export function useAllowedRewardAssets(): AllowedRewardAssets {
  const pc = usePublicClient({ chainId: CHAIN.id });
  const curve = CONTRACTS.curveV4;
  const [state, setState] = useState<AllowedRewardAssets>({ allowed: null, error: false });
  useEffect(() => {
    let cancelled = false;
    if (curve === zeroAddress) { setState({ allowed: new Set(), error: false }); return; }
    if (!pc) return;
    if (!allowedCache || allowedCache.curve !== curve.toLowerCase()) {
      const promise = readAllowedRewardAssets(pc, curve);
      allowedCache = { curve: curve.toLowerCase(), promise };
      // A read that failed outright shouldn't be pinned for the whole session: let the next mount retry.
      promise.then((r) => { if (r.error && allowedCache?.promise === promise) allowedCache = null; });
    }
    allowedCache.promise.then((r) => { if (!cancelled) setState(r); });
    return () => { cancelled = true; };
  }, [pc, curve]);
  return state;
}

export const isAllowedRewardAsset = (allowed: Set<string> | null, asset: string) => !!allowed && allowed.has(asset.toLowerCase());
