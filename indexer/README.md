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
| `GET /coins?sort=new\|mcap\|volume\|active&limit=&graduated=` | board list |
| `GET /coins/:address` | one coin (curve state + aggregates) |
| `GET /coins/:address/trades?limit=` | recent trades |
| `GET /coins/:address/chart?limit=` | price points for the chart |
| `GET /stats` | totals (coins, graduated, trades, volume) |
| `GET /ws` | WebSocket stream: `{type:"coin"\|"trade"\|"graduate", data}` |

All amounts are strings (uint256); prices/mcap are numbers. `priceUsd`/`marketCapUsd` are populated for
ETH-quoted coins; HOOD/other-quoted coins report `priceQuote` (in the quote asset) until a price feed for
that quote is wired.
