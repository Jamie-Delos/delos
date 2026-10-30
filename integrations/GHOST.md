# Ghost: listing and charting Delos coins

Entry page for a data terminal. Everything below links to the two references, [CONTRACTS.md](CONTRACTS.md) and [DATA-API.md](DATA-API.md).

## What a Delos coin looks like to a terminal

One token, two venues in sequence. From launch until graduation all trading is on the curve contract (one address for every coin), with a deterministic price and a visible progress bar toward graduation. After graduation it is a normal Uniswap V4 pool with a fee hook, identified by `poolId`. Every coin has a creator, a quote asset (ETH, HOOD or another Delos coin), a graduation target, and optionally a reward vault paying holders in HOOD or tokenised stocks.

## Two ways to source data

**From the data API** (simplest, once the host is live): `/coins` for the board with `sort=new|mcap|volume|active`, `/ws` for launches, trades and graduations as they finalize, `/coins/:address/candles` for OHLCV at six resolutions, `/trades`, `/holders`, `/callouts`. Or, if your pipeline already consumes GeckoTerminal-format feeds, `/geckoterminal/*`.

**From the chain** (no dependency on us): watch the curve for `Registered`, `Traded`, `Graduated`; price pre-graduation coins from `curves(coin)` and `virtualTokenOffset(coin)`; after graduation read `StateView.getSlot0(poolId)` and the PoolManager's `Swap` events for that `poolId`. Section 9 of CONTRACTS.md lists exactly which events to watch, and `addresses.json` gives the start block.

## Identity

- Name, symbol, decimals, supply: on-chain (ERC-20).
- Logo, thesis, description: `GET <app>/api/metadata?address=<coin>` (DATA-API.md, last section). Images are hosted URLs; `null` when the creator has not published any.
- Address suffix: `de105` on the final factory, `c0de` on the team-test one. It is a convenience for humans, not a validity check; `curves(coin).exists` is the check.
- Verified contract source on the explorer: https://robinhoodchain.blockscout.com.

## Numbers worth showing

- **Progress to graduation**: `graduationProgress(coin)` in bps, or `realQuote / graduationQuote`. The final buy is capped, so progress never overshoots.
- **Fee**: 2% both sides, everywhere. During the first 3 seconds after launch, buyers who are not the creator or a declared bundle wallet pay the decaying anti-snipe tax on top; `buyFeeBps(coin, buyer)` gives the live number if you quote for a specific wallet.
- **Reflection**: `reflectionBps` > 0 means holders earn 1 to 4% of every trade in the vault's basket; `/coins/:address/rewards` shows distributions and claims.
- **Volume**: in quote terms, `amountIn` for buys and `amountOut + fee` for sells (the API's `Trade` rows and candles already apply this).

## If you also trade

Pre-graduation: `buyWithETH` / `sell` on the curve with the quote views for slippage; after `Graduated`: the pool through `CensusV4Router.swapExactInput` or your own V4 execution. CONTRACTS.md sections 5 and 6 have the calls, the price-limit constants and the approvals.

## What is pending

The data API has no public URL yet, and the final contract stack (with `de105`) is not deployed; both land in `addresses.json` when ready. The chain-side integration does not wait on either.
