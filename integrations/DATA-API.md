# Data API

The Delos indexer (source: [`indexer/`](../indexer/)) reads every curve, pool, vault and hook event from finalized blocks into Postgres and serves it over REST and WebSocket. It is the same API the Delos app uses. Base URL: `addresses.json → indexer.baseUrl` (pending a public host; `null` until then).

Conventions: JSON; token amounts are strings in base units unless the field says otherwise; `priceQuote` is a number in quote per token in human units; USD fields are `null` whenever the indexer has no price for the quote asset (never `0`). CORS is open. Rate limit 300 requests a minute per IP (1,200 on the GeckoTerminal routes). Addresses in paths are case-insensitive.

## Coins

`GET /coins?sort=new|mcap|volume|active&graduated=true|false&limit=1..200` → `{ coins: Coin[] }`

`GET /coins/:address` → `{ coin: Coin }` (404 if not indexed)

```
Coin {
  address, name, symbol, decimals, totalSupply, creator,
  quote, quoteSymbol, quoteDecimals, quoteIsCoin,     // pairing asset; quoteIsCoin = quoted in another Delos coin
  product: "v4" | "v3", reflectionBps, vault,          // vault = CensusRewardVault address or null
  virtualQuote, tokenReserve, virtualTokenOffset, realQuote, graduationQuote,   // curve state, base units
  graduated, poolId, pool, progressBps,                // poolId = V4 pool after graduation (V3 legacy coins use pool)
  priceQuote, priceUsd, marketCapUsd,
  volumeQuote, volumeUsd, tradeCount,
  createdBlock, createdAt, updatedAt, holdersIndexed
}
```

## Trades, candles, price points

`GET /coins/:address/trades?limit=1..200` → `{ trades: Trade[] }`, newest first.

```
Trade { coin, trader, isBuy, amountIn, amountOut, fee, feeProtocol, feeCreator, feeHolders, feePenalty,
        priceQuote, venue: "curve" | "pool", block, txHash, ts }
```

`GET /coins/:address/candles?resolution=60|300|900|3600|14400|86400&from=<ISO>&to=<ISO>` → `{ resolution, from, to, candles: [{ t, open, high, low, close, trades, volumeRaw }] }`. Real OHLCV from indexed curve and canonical-pool trades, at most 500 candles per call, no synthetic candles for empty intervals. Defaults: `to` = now, `from` = 500 resolutions earlier.

`GET /coins/:address/chart?limit=1..2000` → `{ points: [{ t, priceQuote, priceUsd }] }`, one point per trade, oldest first.

## Holders, rewards, community

`GET /coins/:address/holders` → `{ available, asOfBlock, totalHolders, holders: [{ wallet, balance, shareBps }] }` (top 20, protocol custody excluded; `available: false` until transfer history has been indexed from the mint).

`GET /coins/:address/rewards?limit=1..200` → `{ rewards: [{ coin, kind, holder, asset, amount, amountB, block, txHash, ts }] }` where `kind` is `distributed`, `claimed`, `converted` or `collected`.

`GET /coins/:address/callouts?viewer=<wallet>` → `{ thresholdBps, callouts: [{ id, author, text, officialCompany, createdAt, updatedAt, likes, likedByViewer }] }`: signed theses from wallets above the holding threshold.

`GET /profiles/:wallet` → `{ profile }`: a wallet's public profile (display name, bio, links) or `null`.

## Aggregate and health

`GET /stats` → `{ coins, graduated, tradeCount, volumeQuote, volumeUsd, unpricedCoins }`

`GET /health` → 200 with `{ ok, database, chainId, curve, finalizedBlock, ingestionError, usdPricing, products }`, 503 while the ingester is behind.

## Live stream

`GET /ws` (WebSocket). First message `{ type: "hello", data: { chainId } }`, then one JSON message per update:

| type | data |
| --- | --- |
| `coin` | a `Coin` whenever its row changes (launch, trade, graduation) |
| `trade` | a `Trade` plus `priceUsd` |
| `graduate` | the graduated `Coin` |

Messages carry finalized data; expect them a few seconds after the block.

## GeckoTerminal format

For charting integrations that already speak GeckoTerminal's Integration API Standards, the same data is served in that shape under `/geckoterminal`: `latest-block`, `asset?id=`, `pair?id=`, `events?fromBlock=&toBlock=`. One virtual pair per coin for the curve phase (asset0 = coin, asset1 = quote), swaps with fees and post-trade reserves, graduation as an exit. Details in [`docs/GECKOTERMINAL.md`](../docs/GECKOTERMINAL.md).

## Metadata and images

Name and symbol are on-chain. Logo, thesis and description are stored by the Delos app: `GET <app>/api/metadata?address=<coin>` → `{ address, metadata: { name, thesis, description, image } | null }`. Until the final app host is announced, `addresses.json → app.metadataApi` points at the team-test app.
