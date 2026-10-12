# Jamie handover — Delos review branch (12 October 2026)

**Branch:** `codex/delos-team-test-2026-10-12` in `JJ-ME55/Census`, based on `CensusV4`. The latest feature commit before this note is `d14b26c`. Compare: https://github.com/JJ-ME55/Census/compare/CensusV4...codex/delos-team-test-2026-10-12

## First: the GitHub emails

The pushes were accepted. The commits are visible on GitHub; the emails saying a push/workflow failed refer to **GitHub Actions checks**, not a rejected Git push. Several incremental pushes generated several separate workflow emails. Do not deploy or merge merely because the indexer/frontend jobs are green: the complete workflow still has two failing jobs.

At `d14b26c`, the **indexer** job (Prisma generation, typecheck, in-memory tests, real Postgres migration/integration/load tests) and **metadata/frontend** job (TypeScript, Vite build and frontend tests) pass. The **bot** and **contracts** jobs fail. Their failures were also present at parent commit `c07b2c9` before the profile/chart/callout additions.

- Bot failure: `bot/keeperd.readiness.cjs:476` asserts `the distribution was planned in dry run`. Inspect why `keeper.cycle()` emits no `[dry] would send distribute:` for the V4 fake-chain fixture. Fix the behavior or fixture according to the intended keeper semantics, then rerun the whole bot suite. Job: https://github.com/JJ-ME55/Census/actions/runs/38306862690/job/115002908074
- Contracts failure: `contracts/test/v4.devbuy.test.js:6` imports `../../frontend/node_modules/esbuild`. The contracts CI job installs only `contracts` before running Hardhat tests, so that cross-package path is missing. Make the test declare/use an available dependency, or install frontend dependencies in the workflow before this test; prefer removing the implicit sibling-`node_modules` dependency. Then run all Hardhat/rehearsal steps. Job: https://github.com/JJ-ME55/Census/actions/runs/38306862690/job/115002907729
- Latest full run: https://github.com/JJ-ME55/Census/actions/runs/38306862690

## What this branch adds

- Delos UI/team-test work and the first-party indexed trade feed.
- Holder callouts: a wallet with at least **0.5% of total supply** can write one thesis per coin and edit it every 24 hours; everyone can like others' callouts. Official company status comes only from the explicit `COMPANY_CALLOUT_WALLETS` token/wallet allowlist. Top holders are indexed from ERC-20 `Transfer` events and shown beneath the chart. Older coins need a verified holder backfill; the API intentionally refuses to show partial rankings.
- Editable public wallet profile: display name, bio, X/Telegram/website, avatar and banner. Edits are wallet-signed and nonce/replay protected. The images use the existing signed/quota-limited Vercel Blob upload path. Public profile rows can be suppressed with `WalletProfile.hidden` in Postgres.
- Real OHLCV endpoint, `/coins/:address/candles`, aggregating the indexed canonical curve and graduated-pool `Trade` rows. The token page shows 1m/5m/15m/1h/4h/1d candles, quote volume, SMA 20/50, crosshair values, zoom, older windows and the buy/sell feed. Postgres integration coverage exercises the SQL. This is first-party data; no external chart API is assumed to index Robinhood Chain or the hooked V4 pool.
- The token page already executes buys/sells on Delos: curve before graduation and `CensusV4Router` through the canonical hooked pool afterward. The action button now names the side and token. This branch does not deploy contracts or change their trade math.

Implementation/deployment detail: [DELOS_CALLOUTS.md](DELOS_CALLOUTS.md) and [DELOS_PROFILES_AND_CHARTS.md](DELOS_PROFILES_AND_CHARTS.md).

## What is still needed for an end-to-end working site

1. **Restore full CI green.** Resolve the two failures above. Keep the frontend/indexer jobs green; do not dismiss red checks as a push error.
2. **Deploy the indexer and database together.** Apply both new Prisma migrations (`20261012000100_delos_callouts`, `20261012000200_wallet_profiles`) to the intended Delos Postgres database and deploy the matching indexer code. Configure mainnet `RPC_URL`, `CHAIN_ID`, the exact deployed curve/pool/hook addresses, `START_BLOCK`, and a restricted `CORS_ORIGIN`. Set `COMPANY_CALLOUT_WALLETS` only after verifying company control. Preserve the social/profile tables during any chain-data rebuild.
3. **Connect the site to that indexer.** Set `VITE_INDEXER_URL` in the Vercel project and rebuild. Confirm that `/profiles/:wallet`, `/coins/:address/callouts`, `/holders`, `/candles` and `/trades` return real data on the deployed site. The chart/profile/callouts visibly report unavailable until this is done.
4. **Provision image storage.** Existing `/api/upload` requires `CENSUS_CHAIN_ID`, `KV_REST_API_URL`, `KV_REST_API_TOKEN` and `BLOB_READ_WRITE_TOKEN` on Vercel. Test avatar/banner uploads and the existing coin-logo upload. Never put these secrets in `VITE_` variables or the repo.
5. **Exercise real wallet and trading flows in an isolated team deployment.** Verify signed EOA and Safe/company profile edits, bad/replayed signatures, social links, images, 0.5% threshold boundaries, 24-hour edit limit, likes, top-holder transfers, chart before/after graduation, and direct buy/sell on both curve and hooked pool using ETH/WETH as applicable. Check actual fee receipts and `minOut` protection. The remote CI does not replace this wallet/mainnet rehearsal.
6. **Only then review deployment gates.** Match frontend/indexer env to a single verified V4 manifest, check `frontend/release-check.cjs`, and have the team confirm custody, multisig, monitoring, RPC redundancy and rollback. This branch has not been deployed to a public Delos domain.

The workstation owner explicitly requested that untrusted repository scripts, installs, builds and tests **not run on this PC** because of wallet/file safety. Work here used static inspection and GitHub-hosted CI only. Jamie should use an isolated runner or his own trusted environment for further execution.
