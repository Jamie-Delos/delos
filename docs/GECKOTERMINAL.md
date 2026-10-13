# GeckoTerminal integration

The indexer serves GeckoTerminal's "Integration API Standards" (v0.1, Nov 2024) so Delos can be listed as its own launchpad DEX. That is the one free, automated way to get a coin's chart and logo onto GeckoTerminal (and the trackers that feed from it, such as ScanHood) from its first curve trade. GeckoTerminal already indexes the hooked Uniswap V4 pools coins graduate into under `uniswap-v4-robinhood`; this integration covers the curve phase and hands over at graduation.

## Endpoints

Base URL: `https://<indexer host>/geckoterminal`

| Endpoint | Serves |
| --- | --- |
| `GET /latest-block` | The last block the ingester has finished, with its timestamp. Returns 503 until the first block is ingested, so GeckoTerminal never asks `/events` for blocks we have not persisted. |
| `GET /asset?id=<token>` | A coin (name, symbol, decimals, decimalized total supply, and `metadata.imageUrl` / `description` / `website` taken from the site's `/api/metadata`) or any ERC-20 used as a quote asset (read from chain). |
| `GET /pair?id=<coin>` | One virtual pair per coin for the curve phase: `asset0` = the coin, `asset1` = its quote asset, `dexKey` = `GT_DEX_KEY`, creation block, timestamp and transaction, creator, `feeBps` = 200 plus any holder reflection. |
| `GET /events?fromBlock=&toBlock=` | Curve trades as `swap` events (decimalized amounts, fees in `metadata.fees1In` / `fees1Out`, `priceNative` = quote per coin from the post-trade reserves, reserves after each trade) and each graduation as an `exit` that empties the pair. Pool-venue trades are excluded, GeckoTerminal counts those itself. Spans above `GT_MAX_SPAN` blocks (default 10,000) are refused with 400. |

Ids are checksummed addresses, as GeckoTerminal asks for EVM chains. Numbers are strings.

## Configuration

| Env | Purpose |
| --- | --- |
| `GT_DEX_KEY` | The dex key GeckoTerminal lists us under. Default `delos`. |
| `GT_METADATA_URL` | Origin of the site that serves `/api/metadata`, e.g. `https://delos-team-test.vercel.app`. Without it assets carry no image or description. |
| `GT_MAX_SPAN` | Largest `toBlock - fromBlock + 1` one `/events` call may ask for. Default 10000. |

The routes share the API's rate limit but allow 1,200 requests a minute each, since GeckoTerminal polls `/latest-block` and `/events` every two seconds.

## Database

Migration `20261013130000_geckoterminal` adds the per-trade transaction index and post-trade curve reserves (`Trade.txIndex`, `reserve0After`, `reserve1After`) and the creation and graduation transactions of each coin (`Coin.createdTxHash`, `graduatedBlock`, `graduatedTxHash`, `graduatedTxIndex`, `graduatedLogIndex`, `graduatedAt`). Trades indexed before this migration have no stored reserves; `/events` then falls back to the coin's current reserves, which is only accurate for the latest trade. Re-index from the deploy block if historical accuracy matters.

## Listing with GeckoTerminal

1. Deploy the indexer with the env above and confirm `GET /geckoterminal/latest-block` answers 200 from the public URL.
2. Submit GeckoTerminal's DEX listing form (free, 5 to 10 working days): network Robinhood Chain (`robinhood`), DEX name Delos, dex key `delos`, the base URL above, and a public website. Ask for a block chunk of at most 2,000 blocks and for image ingestion from `asset.metadata.imageUrl`, which is how integrated launchpads get logos.
3. After the listing, every coin appears on GeckoTerminal from its first curve trade with its image and description, and continues under the V4 pool after graduation.

The in-memory readiness suite (`npm test`) covers the routes end to end against stubbed data: ordering, decimalization, buy and sell orientation, fees, reserves, the graduation exit and range validation.
