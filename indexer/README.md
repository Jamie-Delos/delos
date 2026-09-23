# Census Indexer

Ingests Census on-chain activity (launches, trades, graduations from `CensusCurve`) into Postgres and
serves a fast **REST + WebSocket API** for the app board, coin pages, and partners — so the frontend
never scans the chain from the browser. This is the piece that lets Census handle real (Pons/pump.fun-
level) volume: one writer ingests, everyone else reads from Postgres/cache.

## Architecture
```
CensusCurve (chain) ──events──► ingester ──► Postgres ──► REST + WebSocket API ──► app + partners
                                    ▲                            │
                             dedicated RPC                    WS push (new coins, trades, graduations)
```
- **Ingester** (`src/ingest.ts`): backfills from the curve deploy block, then live-polls. Tracks each
  curve's reserves directly from `Traded` events (no per-trade RPC), so it scales.
- **Products**: the legacy **V3** product (`CensusCurve` at `CURVE_ADDRESS`, graduated coins trade in a
  locked Uniswap V3 pool) and the **V4** product (`CensusCurveV4` at `CURVE_V4_ADDRESS`, graduated
  coins trade in a canonical Uniswap V4 pool with the Census hook; `POOL_MANAGER_ADDRESS` and
  `HOOK_ADDRESS` add the post-graduation coverage). Either or both can be configured; every coin
  carries `product: "v3" | "v4"`.
  V4 events indexed: curve `Registered` (with `reflectionBps`), `Traded`, `FeeAllocated` (per-trade
  protocol/creator/holder/penalty split stored on the trade), `Graduated(coin, poolId, ...)`;
  PoolManager `Swap` filtered by the coin's `poolId` (venue `pool`, price from `sqrtPriceX96` oriented
  by which currency is the coin) paired with the hook's `FeeAccrued` of the same transaction (gross
  quote volume + fee split; `fee` = protocol + creator + holder); vault `Distributed`/`Claimed` and hook
  `FeesClaimed` to a vault (reward kind `collected`). Fee logs are annotations of their trade, so an
  inconsistent pairing stops ingestion instead of writing a partial trade.
- **API** (`src/api.ts`): Fastify. `/coins`, `/coins/:address`, `/coins/:address/trades`,
  `/coins/:address/chart`, `/stats`, and `/ws` (live stream).
- **DB** (`prisma/schema.prisma`): Postgres via Prisma. Everything the board reads is denormalised onto
  `Coin` so hot queries are single-table.

## Run locally
```bash
cp .env.example .env          # set DATABASE_URL to a Postgres, keep the testnet contract defaults
npm install
npx prisma migrate dev        # create the schema
npm run dev                   # ingester + API on :8080
```
No Postgres handy? `docker run -e POSTGRES_PASSWORD=census -e POSTGRES_DB=census -p 5432:5432 -d postgres:16`
then `DATABASE_URL="postgresql://postgres:census@localhost:5432/census?schema=public"`.

## Deploy (company DO / AWS + Prisma Postgres)
1. Provision **Postgres** (Prisma Postgres, RDS, or a DO managed DB). Put its URL in `DATABASE_URL`.
2. Set env (see `.env.example`) — the mainnet `CURVE_ADDRESS` etc. from `contracts/deployments.<net>.json`,
   and a **dedicated RPC** (`RPC_URL`) — the public RPC rate-limits at volume.
3. Ship the container (`Dockerfile`) to DO App Platform / ECS / Fly / Railway. It runs
   `prisma migrate deploy` then the service. One instance is plenty to start.
4. Point the frontend at it: `VITE_INDEXER_URL=https://<indexer-host>` (see `frontend/src/lib/indexer.ts`).
   The app uses the indexer when set and falls back to reading the chain directly when it isn't.

### Scaling notes
- Split web/worker: run `runApi()` on N web instances and `runIngest()` on **one** worker (single cursor
  writer). Front the API with the CDN/edge; add Redis for hot lists + WS fan-out across instances.
- Add a read replica for the API once trade volume is heavy.

## API
| Route | Returns |
| --- | --- |
| `GET /health` | `ok`, `database`, `chainId`, `curve`, `finalizedBlock`, `ingestionError`, `usdPricing`, `products` (`["v3"]`, `["v4"]` or `["v3","v4"]`: the configured curves) |
| `GET /coins?sort=new\|mcap\|volume\|active&limit=&graduated=` | board list |
| `GET /coins/:address` | one coin (curve state + aggregates). Every coin has `product` (`"v3"` \| `"v4"`), `reflectionBps` (V4 holder-reflection fee in bps, 0 on V3), `pool` (V3 graduated pool address, null on V4) and `poolId` (V4 graduated pool id, bytes32, null on V3) |
| `GET /coins/:address/trades?limit=` | recent trades: `venue` (`curve` \| `pool`), `fee` and its split `feeProtocol`/`feeCreator`/`feeHolders`/`feePenalty` (V4 `FeeAllocated` on the curve, hook `FeeAccrued` in the pool; all `"0"` on V3 trades). V4 pool trades: `amountIn` is the gross quote on buys, `amountOut` the net quote on sells |
| `GET /coins/:address/rewards?limit=&holder=` | reward ledger: `kind` `distributed` \| `claimed` \| `converted` (V3) \| `collected` (V4: hook fees pushed to the vault) |
| `GET /coins/:address/chart?limit=` | price points for the chart |
| `GET /stats` | totals (coins, graduated, trades, volume) |
| `GET /ws` | WebSocket stream: `{type:"coin"\|"trade"\|"graduate"\|"reward", data}` |

All amounts are strings (uint256); prices/mcap are numbers or **null**. USD pricing fails closed:
`priceUsd`/`marketCapUsd`/`volumeUsd` are null unless the quote asset has a configured USD price
(`ETH_USD` for WETH, `QUOTE_USD` for others); there is no default ETH price. `/stats.volumeUsd` is null
while any coin is unpriced (`unpricedCoins` says how many) and `/health.usdPricing` reports whether
`ETH_USD` is configured. Company-coin quotes are not USD-priced yet.
