# Reconciliation with the independent review — 2026-09-16 (evening)

Jamie's review (`INDEPENDENT-REVIEW.md`, branch `BACKEND-NEIL` @ `945dfe2`) confirmed every test claim
below and found no fund-loss bug in the contracts; its findings were operational (keeper/indexer/metadata)
and integration seams. This pass works through that list. **Release decision: still NO GO for mainnet
funds** — what remains is the same set of decisions and external/ops validation, now with fewer code
items; see "Remaining launch blockers" at the end of this section.

## Findings → status

| # | Finding | Status | Where / evidence |
| --- | --- | --- | --- |
| H1 | Auto-distribution only worked for creator-delegated vaults | **Fixed** | `CensusCurve.setKeeper` (deployer-only, `KEEPER_ADDRESS` at deploy); `DividendVault._checkOperator` accepts the operator OR `census.keeper()`; keeperd reads `vault.operator()`/`curve.keeper()`, skips convert/distribute it is not authorized for (no error storm), runs `claimFor` pushes in their own failure domain. `review.fixes.test.js` (H1), keeper harness check 7. |
| H2 | keeperd stalls after a failed broadcast; DRY_RUN could sign a replacement | **Fixed** | `resolvePending` handles `hash:null` (nonce unconsumed → clear), replacement is gated on `!dryRun`, replaced hashes are kept so a mined original still resolves the record, cycle-level failures go through `raise()` (webhook) with dedupe. Harness checks 8, 10, 12. |
| H3 | Discovery stalls on busy block ranges | **Fixed** | Topic-filtered `getLogs`, chunk halves on failure down to `logChunk/16` and grows back; alert at the floor. Harness check 9. |
| H4 | Indexer livelock: RPC calls inside the 60 s serializable transaction | **Fixed** | `ingest.ts` split into `prefetchPage` (all RPC: checkpoint hash, logs, one `getBlock` per block for hash+timestamp, token metadata at `latest`) and `commitPage` (DB only). Adaptive `LOG_PAGE` halves the attempted range on failure. In-memory harness asserts no RPC call runs inside `$transaction`; real-PG harness unchanged and passing. |
| H5 | Zero-cost graduation griefing (parked liquidity vs. fixed 10% bound) | **Lever added; design decision still open** | `CensusCurve.setRecoveryMaxSpendBps(coin, bps)` (deployer-only, hard cap 50%, event) widens ONE coin's bounded recovery swap; every unit still executes better than the migration price. `graduation.recovery.test.js` (H5). Not timelocked: the deployer is already production custody (B21). Continuous migration (the B15 redesign) remains the structural fix. |
| M1 | Fresh deployment cannot launch HOOD-quoted coins | **Fixed** | `deploy.js` `ALLOWED_QUOTES` env → `setQuoteAllowed`; runbook §4 step; deployments JSON records `allowedQuotes`. |
| M2 | Maxima meme with a stock basket reverts at launch | **Fixed (contracts + route builder); UI not exposed** | `memePair.test.js` (M2): WETH-rooted route reverts, coin → WETH → stock route launches. `basketPath` builds that route when given the company coin's pool tier and returns `null` for unknown quotes (wizard refuses instead of guessing). The wizard still offers only ETH/HOOD anchors — exposing company coins is frontend backlog. |
| M3 | Migration dust stranded forever | **Fixed** | `CensusCurve.sweepMigrationDust(coin)` (deployer-only, graduated coins, once, → platform). `graduation.recovery.test.js` (M3). |
| M4 | One frozen basket stock bricks a holder's whole claim | **Fixed** | `DividendVault._claim` pays each asset independently; a refused transfer emits `ClaimDeferred`, leaves that asset reserved and pays the rest. `review.fixes.test.js` (M4). |
| M5 | A blocked fee recipient halts all trading of a coin | **Fixed** | `CensusCurve._payFee`: failed push → `deferredFee[quote][to]` + `FeeDeferred`; `withdrawDeferredFee` (permissionless) pushes later. Reserves stay whole. `review.fixes.test.js` (M5) + rewritten regression in `backend.readiness.test.js`. |
| M6 | Indexer assumes 18-decimal quotes | **Fixed** | `Coin.quoteDecimals` (migration `20260916160000_quote_decimals`, validated on real PG); prices/volumes scale by the quote's decimals; company-coin quotes take theirs from the indexed coin. |
| M7 | `/health` 503 for the whole initial backfill | **Fixed** | `ingestion.lastSuccessAt` advances per committed page. |
| M8 | Rate limit keys on the socket address behind a proxy | **Fixed** | `TRUST_PROXY` = hop count or IP/CIDR list (bare `true` refused); documented in `.env.example`. |
| M9 | Docker image bakes `.env` and host `node_modules` | **Fixed** | `indexer/.dockerignore`. |
| M10 | Metadata `CENSUS_CHAIN_ID` silently defaulted to mainnet | **Fixed** | Required (503 when unset, GET reports `store: "unconfigured"`); the RPC's `eth_chainId` must match. Metadata harness checks 12, 14. |
| M11 | Metadata signatures replayable (rollback) | **Fixed** | Message v2 carries `issued: <unix s>`; 10-minute expiry, future-skew guard, and a write is rejected (409) unless newer than the stored one. Harness checks 6, 10. |
| M12 | 500 path leaks the RPC URL | **Fixed** | Generic message; details logged server-side. Harness check 13. |
| M13 | Metadata write fire-and-forget, no recovery | **Fixed** | `putMetadata` returns `{ok, status, reason, retryable}` and keeps the payload in localStorage; the wizard shows the reason with "Retry saving details" / "Go to coin" instead of navigating away silently. |
| M14 | Stripped revert strings hide every reason | **Fixed for the user-facing paths** | Custom errors in `CensusCurve` (QuoteNotSupported, BadPoolFee, ZeroAmount, CurveLimit, UnsupportedQuote, RecoveryFailed, …) and `DividendVault` (NotOperator, MinOut, Insolvent, Excluded, BadParams, …). `review.fixes.test.js` decodes them. Frontend ABI strings do not list them yet (wallets show the selector). |
| M15 | keeperd state-file robustness | **Fixed** | Corrupt state = hard error; `<state>.lock` single-instance lock (stale locks reclaimed); replaced hashes retained. Harness check 11. |
| LOW | `poolFee` unvalidated at register | **Fixed** | `register` accepts only 100/500/3000/10000 (`BadPoolFee`). |
| LOW | keeperd: holder cursor missed same-block buyers; push starvation; alert storms; tip not bumped; locker not cross-checked | **Fixed** | Holder scan starts at the launch block; per-launch push share of the action budget; alert dedupe (`ALERT_REPEAT_MS`); replacement bumps `maxPriorityFeePerGas` too; `LOCKER_ADDRESS` must equal `curve.locker()` at startup. |
| LOW | `readContract` at a historical block needs an archive node | **Fixed** | Token metadata read at `latest` (immutable). |
| LOW | `test:pg` Windows-only kill; no CI | **Fixed** | Cross-platform hard kill; `.github/workflows/backend.yml` runs contracts, indexer (in-memory + real PG), keeper and metadata suites on every push. |
| LOW | Not addressed this pass | **Open (non-blocking)** | `_credit` floor remainder unsweepable; `setZapPath` for graduated company coins is manual; indexer `onGraduated` keeps the curve price until the first pool swap; migration-recovery `Swap` shows as a `venue=pool` trade; no reorg rewind past finality; `/stats` uncached `COUNT(*)`; no per-IP WebSocket cap; USD blank for non-WETH quotes; smart-wallet creators cannot sign metadata; committed `npm audit` dumps. |

Structural change enabling the contract fixes: `LaunchFactoryV2` no longer embeds the vault creation code —
its constructor deploys a `DividendVaultDeployer` that creates and wires each vault. The factory runtime
dropped from 24,413 to 11,259 bytes (EIP-170 limit 24,576), so vault changes no longer compete for ~160
bytes of headroom. Constructor arguments and the launch ABI are unchanged; `vault.factory()` is now the
deployer (which is what calls `init`/`setCensus`), and every vault excludes its own address.

## Verification (this pass)

- contracts: `npx hardhat test --network hardhat` — **65 passing, 3 pending, 0 failing**; `node scripts/exportTokenBytecode.js --check` passes; mainnet-fork lifecycle passes (`AUDIT_MAINNET_FORK=1`).
- indexer: `npm run typecheck`, `npm test` (adds the no-RPC-in-transaction guard and adaptive paging), `npm run test:pg` — **ALL REAL-POSTGRES CHECKS PASSED** with the new migration (load: 11k events in ~51 s on this laptop).
- bot: `npm test` — planner check + **13/13 keeperd checks**.
- frontend: `npx tsc --noEmit` clean; metadata harness **21 checks passed**.

## Remaining launch blockers (2026-09-16 evening)

1. **B15 / H5 decision** — the pool still opens ~23% below the curve exit price. Accept-and-disclose, or the continuous-migration redesign (which also removes the arbitrage-free parking band behind H5). The recovery-bound lever is a stopgap, not the answer.
2. **External validation** — real 0x routes per pair/direction, issuer behavior of the actual stock tokens, live price feeds (indexer USD still static ETH-only), dedicated RPC.
3. **Ops rehearsal** — production pg_dump/pg_restore, managed-Postgres settings, real ingress load, **keeper live rehearsal on a fork/testnet with `curve.setKeeper` set and a funded capped signer**, `upload.ts` still unauthenticated.
4. **Deployment & custody (B21)** — release manifest, treasury/keeper/deployer custody (the deployer now also holds the keeper, recovery-bound and dust-sweep levers), whether any existing deployment holds real funds (still unconfirmed), then re-run Jamie's review on the diff of this pass (contracts changed again: fee deferral, claim resilience, keeper authority, vault deployer).
5. **Frontend follow-ups (non-blocking)** — custom-error strings in the ABI list, company coins in the anchor picker (gold highlight), rewards tab.

Nothing on this branch is deployed; no deployed contract inherits these changes.

---

# Backend repair status — 2026-09-16 (supersedes 2026-09-15 below)

Branch: `codex/backend-launch-readiness`. Second repair pass; all changes local, nothing pushed or deployed.

**Current release decision: still NO GO for unrestricted mainnet funds** — but the blocker list has shrunk materially. What remains is dominated by decisions, external validation and deployment/ops rehearsal, not by known unfixed fund-safety defects.

## Fixed and tested today (2026-09-16)

| Area | What changed | Evidence |
| --- | --- | --- |
| B01 graduation blocking (was OPEN) | An adversarially pre-initialized pool no longer blocks graduation: a bounded (≤10% of one leg), exact-price-limited recovery swap restores the migration price — every unit executes better than the migration price, so mispricing funds the curve. Hostile liquidity too deep for the bound fails closed with all reserves intact and the curve still trading. Mint minimums are price-consistent; recovery surpluses are recorded as migration dust. | `graduation.recovery.test.js`: empty-pool poisoning above/below price recovered exactly; real-liquidity attacker paid the arbitrage; deep-liquidity attack fails closed; at-price pool needs no swap. Poisoned-graduation audit repro updated to assert recovery. |
| Launch-token LP fees (gate 2 part) | `DividendVault.convertLaunchFees` (operator-gated, mandatory minimum output) sells locker-forwarded launch-token fees into the quote asset; proceeds fund the next distribution instead of stranding. | Lifecycle test: fees accrued in both pool assets, converted, distributed, claimed by holders. |
| Auto-distribution (team decision) | `DividendVault.claimFor(holder)`: anyone can push a holder their own earned basket; keeper delivers rewards automatically. | Push/idempotency/exclusion tests; keeper daemon integration. |
| Supported collateral (gate 3 part) | Deployer-managed quote allowlist enforced at registration (WETH enabled at deployment; e.g. HOOD after review). Arbitrary/malicious collateral can no longer enter shared custody via a new launch. | Allowlist refusal/enable/authorization tests. |
| Meme pairing (new product feature) | Launches may be quoted in a GRADUATED Census company coin (`isPairableCompanyCoin`); meme-on-meme chains are not eligible. Indexer flags pairs (`quoteIsCoin`) and resolves the pair's quote symbol. | `memePair.test.js` full $MEME/$XYZ lifecycle incl. XYZ-denominated fee split and locked MEME/XYZ pool; suite 56 passing, 3 pending. |
| Production keeper (gate 5, was OPEN) | New `bot/src/keeperd.js` daemon: log-based discovery of all launches/graduations, per-cycle pipeline (collect → convert → distribute → push), durable atomically-written state, ONE managed in-flight transaction with intent recorded before broadcast, nonce/superseded/stuck-replacement recovery under a fee cap, signer balance floor, webhook alerts, DRY_RUN default. | `keeperd.readiness.cjs` against a fake chain: dry-run signs nothing; pipeline order + sequential nonces; restart resume; mined/superseded/stuck recovery; underfunded-signer refusal; atomic state. |
| Real PostgreSQL (gate 4, was OPEN) | `indexer/postgres.readiness.cjs` runs the ACTUAL ingest/API against embedded real PostgreSQL 18 (no Docker): clean `migrate deploy` onto 5 fresh DBs; exactly-once ingestion through real serializable transactions + advisory lock; digest-stable replay; RPC-outage resume; TWO concurrent workers exactly-once; postgres hard-killed mid-ingest → WAL recovery → resume to identical digest; logical export/restore; API under concurrency 50 on real data; 11,000-event load (~300 events/s local single node). | `npm run test:pg`. |
| Post-graduation indexing (gate 6 part, was OPEN) | Ingester also covers each coin's graduated pool (Swap → venue=pool trades, spot price from sqrtPriceX96) and vault reward events (Distributed/Claimed/LaunchFeesConverted → RewardEvent ledger, `/coins/:address/rewards`). Same receipts/finality/transactional guarantees. Additive migrations validated on real Postgres. | Real-PG harness asserts exactly-once pool-swap/reward ingestion and API serving. |
| Metadata authorization (gate 6 part, was OPEN B18) | Writes require an EIP-191 signature by the coin's ON-CHAIN creator (verified against `CensusCurve.curves().creator` over RPC); chain-scoped keys; atomic single-command KV writes; creator-only corrections; fail-closed when unconfigured. Unregistered/predicted addresses can no longer be squatted. Launch wizard signs with the connected wallet. | `frontend/api.metadata.test.cjs`: 9 checks against mock RPC/KV with real signatures. |

Team decisions received 2026-09-16: rewards are distributed automatically (implemented via claimFor + keeperd); no extra holder-incentive mechanics; fee setup final (2% / 25% Census / 75% creator-side by holdersBps — matches implementation); standard 1B supply (frontend default; not contract-enforced); no MarketGuard/permissioned-token redesign (matches this branch); renaming Prima/Maxima is open but non-blocking.

## Remaining mainnet gates (2026-09-16)

1. **Graduation price discontinuity (B15)** — unchanged by design: the pool still opens ~23% below the curve exit price with tested settings. Recovery/blocking is fixed; the discontinuity itself needs an explicit team decision (accept + disclose, or a continuous-migration redesign that burns/retains the virtual-side tokens — an economics change).
2. **External validation**: real 0x routes for every supported pair/direction, issuer behavior of actual stock tokens (pause/blacklist/corporate actions), fresh price/deviation feeds (indexer still uses a configured static ETH/USD; other quotes report zero USD), dedicated RPC providers.
3. **Deployment/ops rehearsal**: pg_dump/pg_restore on the production toolchain (embedded binaries ship without pg_dump; the harness's restore is SQL-level), managed-Postgres settings, real network/WebSocket ingress load (harness load is in-process), keeper live rehearsal on a fork/testnet with a funded capped signer, upload quota/authentication (`upload.ts` still unauthenticated), deployment manifest + treasury/operator custody review (B21).
4. **Independent review** of the modified contracts (CensusCurve recovery swap + callback, DividendVault conversions/push, allowlist/pairing) and an explicit joint go/no-go. Passing tests here are first-party evidence, not certification.
5. **Existing deployments**: whether any deployed contracts hold real funds is still unconfirmed — establish before any migration/announcement.

---

# Backend repair status — 2026-09-15 (historical)

Branch: `codex/backend-launch-readiness`, based on main `c000052712ea739fde3e8b050769344b9def697b`. GitHub main was checked before editing and remained at that revision. Production deployments have not been changed. This status supersedes the original audit's claim that production source is unchanged; that claim described the September 13 audit pass.

**Release decision at that date: NO GO for unrestricted mainnet funds.** This is a reviewed local repair candidate, not a completed security certification. Code changes are intended for new deployments; existing immutable contracts do not inherit them.

## What has changed

| Audit area | Implemented repair | Status / remaining limitation |
| --- | --- | --- |
| B02 quote reward recredit | Explicit per-asset reserves; only unallocated quote can be distributed; claims debit reserves; insolvency reverts rather than favoring early claimants. | Regression passes. Reserved amounts include conservative rounding dust; dust has no sweep path. |
| B03 duplicate baskets / rounding | Reject duplicate, zero-code and zero-weight basket entries. Retain fractional debt and earned fractions across transfers, using full-precision multiplication. | Regression passes; 700-operation independent entitlement model agrees. |
| B07 wrong payout path | Validate route shape and quote/payout endpoints; credit actual received output rather than trusting a router's reported amount. | Regression passes. Asset admission and intermediate-route policies still require review. |
| B04/B05 migrated fee split | Explicit irreversible migrated registration; honor holdersBps; platform receives its share independently of the holder vault. | Both fee assets tested at 0/40/100% holder-side allocations, plus a live-dependency local fork. Launch-token fees arriving at the dividend vault still need a conversion/disposition policy. |
| B01 graduation diversion | Both mint legs require at least 99.99% of intended input. Failed migration rolls back; bounded leftovers remain recorded in the curve, never refunded to creator. Graduated event reports actual minted amounts. | Funds-protection mitigation passes. An adverse preinitialized pool can still block graduation; the recovery design is OPEN. Dust retention has no withdrawal path. |
| B06 taxed collateral | Reject deposits whose actual received quote differs from declared input. | Reproduction now reverts without a reserve deficit. This does not address subsequent rebases, blacklists, malicious token behavior or all zap-route concerns. |
| B08/B17 execution / keeper | Positive swap floors; exact quote spend checks; reset approvals; full weighted batches; same-asset legs skip swapping. Keeper reads unallocated balance, rejects invalid slippage/chain/0x target/token/amount/value, and uses HTTP timeouts. | Tested contract guards and same-asset planning. Operator-set prices remain a trust boundary; actual 0x route integration and recoverable keeper orchestration remain OPEN. |
| B10/B11 event durability | Transactional event receipts, trade/aggregate/point writes and cursor; advisory lock with serializable transactions; no silent RPC/DB failure skips; startup resumes at next block; historical token metadata required. | Fault injection and replay tests pass with in-memory adapters. PostgreSQL transaction/lock contention and crash recovery require real DB testing. |
| B12 finality | Read finalized blocks; check checkpoint deployment identity and canonical hashes; reject noncanonical event hashes; publish only committed state. | Safer fail-closed behavior. Finalized-only data may arrive later than user transactions. No automatic rollback/rebuild, pending activity stream or post-graduation event coverage yet. |
| B13 deployment schema | Initial PostgreSQL migration, migration lock, Docker `npm ci`. | SQL generated and Prisma client/build pass. Clean-container migration/restore NOT executed. Existing DBs must not blindly apply a fresh schema migration. |
| B14 build parity | Regenerated client LaunchToken creation bytecode; added artifact equality and EIP-170 size check. | Fresh vanity-address launch and size checks pass. Only a generated integration artifact changed under frontend; no UI redesign. |
| B19/B20 API | Reject invalid limits/filters with 400; DB+ingestion readiness and separate liveness; recent chart window; per-process IP rate limit and bounded WebSocket buffers/connections. | API injection tests pass. Deployment ingress, shared limits, quote/upload authentication and genuine network/WebSocket load remain OPEN. |
| B22 HTTP advisories | Updated Fastify and compatible plugins; added rate limiter. | Runtime npm audit reports 0 known vulnerabilities. Does not certify application security or build-time dependencies. |

Other original audit findings remain open unless explicitly addressed above. The freely transferable token and external-pool economics are unchanged. No V4 migration, transfer tax, trading restrictions or new admin custody model has been introduced.

## Validation

- Full local contracts: **44 passing, 3 skipped opt-in/legacy fork cases**. Some passing tests deliberately demonstrate remaining external-pool, issuer-freeze and migration-price risks. See `repair-contract-results-2026-09-15.txt`.
- Local mainnet-fork lifecycle: **1 passing**, pinned at block **63,177,954**; launch, buy, dividend claim, graduation, actual configured Uniswap swap and correct platform/holder fee collection. No public transactions.
- Curve workload: **500 mixed buy/sell operations**, ten wallets, normal quote reserve identities maintained; observed maximum trade gas 122,358.
- Reward workload: **700 distributions/transfers/claims**, four holders, dust-sized values, checked against an independent cumulative entitlement ledger after each operation.
- Indexer workload: **10,000 unique events + 1,000 duplicates applied once**. RPC failure, failures at coin/point/cursor writes, missing registration and canonical-hash mismatch checked. No premature client notifications.
- API: **1,000 in-process requests at concurrency 50** with a stub database, plus pagination/filter/readiness/chart/rate-limit cases. These are functional workloads, not production throughput results.
- Keeper same-asset planner and syntax check pass; indexer build passes.
- Artifact parity/contract deployment size checks pass; the V2 factory remains close to EIP-170, so retain this check on every contract change.
- Local two-asset V3 rehearsal uses synthetic stock tokens, direct and multi-hop pools. Actual issuer assets and live 0x execution are not validated by it.
- Dependency details: `indexer-dependencies-after-fixes.json`.

## Remaining mainnet gates

1. **Graduation economics and recovery:** an adverse pool safely blocks now; determine how a launch recovers, eliminate/explicitly approve the virtual-reserve price discontinuity, and finalize dust/liquidity-management policy. No silent reserve refunds.
2. **Fees and eligible rewards:** agree that fees cover Census execution/received LP revenue or fund a separately reviewed architecture. Resolve external-contract eligibility, payout timing and nonquote LP fee handling. Universal fees are not achieved by these fixes.
3. **Supported assets and prices:** approved collateral/payout assets, verified issuer behavior, routes, fresh price/deviation protection and no unsafe zero-output fallbacks. Address remaining fixed/unsupported USD prices and cross-asset totals.
4. **Real full-stack rehearsal:** dedicated PostgreSQL, migrations, two workers, crash/restart/replay, provider outages, backup restore, finalized/pending UX and canonical event reconciliation. Add swap/collection/distribution/claim coverage after graduation.
5. **Production keeper and access:** running scheduler, durable jobs, funded/capped signer, nonce/replacement recovery, authorized metadata/uploads, quotas and monitoring.
6. **Deployment/review:** verified new contract manifest and ABI versions, existing-funds inventory and migration plan if needed, treasury/operator ownership, issuer/legal eligibility, independent review of modified contracts and explicit go/no-go.

## Suggested 30-hour schedule

These are time budgets, not assurances that an unresolved security design can be safely completed within them. A stage that misses its acceptance criteria blocks funds launch.

| Window from start | Work | Exit condition |
| --- | --- | --- |
| 0–6 hours | Review this repair candidate; settle graduation, fee scope, supported assets and existing-deployment status. | Jamie agrees the specification and resolves remaining fund-safety design choices. |
| 6–14 hours | Implement/review remaining fund-safety and accounting work; reconcile post-graduation events and keeper execution. | Independent regression/invariant checks; no unresolved high-severity funds defects. |
| 14–22 hours | Run the complete stack on isolated infrastructure; crash/restart/duplicate/reorg exercises and measured load. | Exact accounting after recovery; backed rewards; agreed capacity and recovery targets. |
| 22–28 hours | Independent code/deployment review, target-chain rehearsal, signer/treasury checks and incident drill. | No blocker from reviewers; validated artifacts and operations. |
| 28–30 hours | Release freeze and evidence-based go/no-go. | Launch only if every mandatory gate passes; otherwise keep the demonstration/test environment available and defer funds launch. |

Do not start a V4/custom-token redesign as a presumed quick fix inside this window. If enforced creator revenue outside the present V3 position model is mandatory, the release scope and timeline must account for the new architecture.

## Suggested update to Jamie

> I identified and reproduced launch-blocking backend issues: reward accounting could overstate funds owed, post-graduation fees went to the wrong beneficiaries, manipulated pool initialization could divert liquidity, and RPC failures/replayed events could corrupt the indexer. The first repair branch now has regression-tested accounting and fee fixes, reserve-protection checks, transactional indexing and API hardening. We have also completed a local mainnet-fork lifecycle. I want to use the next 30 hours for the remaining graduation/fee decisions, full-stack recovery and load tests, and a joint release review. I am not calling it mainnet-ready until the remaining gates pass.

This is draft wording only; no message has been sent.
