# Delos integration kit

For teams that want to list, chart, trade or launch Delos coins: trading terminals, bots, aggregators and launch venues. This kit replaces the Census packets sent to Ghost and Sumo on 9 September 2026, which described an earlier product (a V3 locker, different fees, testnet addresses). Everything here is generated from the code in this repository and stays current with it.

**Status, 30 October 2026.** The contracts below are live on Robinhood Chain mainnet in a team-test deployment: coins have launched, filled, graduated and traded in their Uniswap V4 pools. Two things are still pending and are the only fields in this kit that will change:

1. **Final deployment.** A fresh stack (curve, graduator, hook, router, factory, treasury) replaces the team-test one; new coins then get `…de105` addresses instead of `…c0de`. `addresses.json` carries both blocks; `current` points at whichever is live.
2. **Hosted indexer.** The data API exists and is tested but has no public URL yet. `addresses.json` → `indexer.baseUrl` is `null` until it does.

Watch this folder for both. Nothing else in the integration surface depends on them.

## Start here

| You are | Read |
| --- | --- |
| A data terminal or tracker (Ghost) | [GHOST.md](GHOST.md): discovery feed, charts, holders, metadata, then trading. |
| A trading bot or launch venue (Sumo) | [SUMO.md](SUMO.md): curve trading with quotes and the snipe window, pool trading after graduation, launching with block-0 bundles. |
| Anyone | [CONTRACTS.md](CONTRACTS.md) is the on-chain reference, [DATA-API.md](DATA-API.md) the indexer, [ADDRESSES.md](ADDRESSES.md) the chain and contract addresses, `abi/` the ABIs. |

## The product in one paragraph

A Delos coin is a plain ERC-20 (fixed 1,000,000,000 supply, 18 decimals, no tax, no mint, no owner) whose whole supply is seeded into a shared bonding curve, `CensusCurveV4`, priced in a quote asset: ETH (as WETH), HOOD, or another Delos company coin. Buys and sells trade against the curve with a flat 2% fee. When the curve's real reserve reaches the coin's graduation target, the buy that crosses it is capped at the target, the excess is refunded, and in the same transaction the remaining tokens plus the raised quote move into a Uniswap V4 pool on Uniswap's official PoolManager. The pool's liquidity is custodied forever by the graduator, and the Delos hook on that pool keeps charging the same 2% on every swap, whichever router sends it. Company coins (Maxima) can add a 1 to 4% holder reflection paid in HOOD or tokenised stocks.

## What changed since the September packets

- Delos, not Census; delos.fund; addresses end in `de105` once the final factory is live.
- Graduation goes into a Uniswap V4 hooked pool keyed by `poolId`, not a locked Uniswap V3 pool. Post-graduation trades go through a V4 router (ours or any other); the hook fee applies either way.
- Fee split: 90% protocol / 10% creator on the curve, 30% / 70% after graduation, optional reflection on top. No DividendVault; reward vaults are `CensusRewardVault`.
- Anti-snipe: a 3-second decaying tax (99% at launch down to the base rate) instead of wallet or buy caps. Creator and declared bundle wallets are exempt.
- Capped final fill with refund, Pump.fun-style virtual token offset in the curve maths.
- New signatures everywhere: `Registered`, `Graduated`, `LaunchedV4`, `FeeAllocated`, `BuyRefunded`, `buyWithETH`, `maxQuoteIn`, `graduationProgress`, and the factory's `createLaunch`. See CONTRACTS.md.
- Data API: candles, rewards, holders, callouts and profiles, plus GeckoTerminal-format endpoints.

Questions: open an issue on this repository.
