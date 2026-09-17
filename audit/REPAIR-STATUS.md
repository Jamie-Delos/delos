# PF graduation update — 2026-09-17

The team approved PF-style virtual token reserves. Implemented on top of `dda7794`; see
[PF-GRADUATION.md](PF-GRADUATION.md) for math, refunds, event/schema changes and deployment requirements.
The earlier B15 accept-versus-redesign decision below is superseded. Standard 1B supply is preserved;
there is no permanently parked economic surplus. Initial virtual quote stays 1.5 ETH, graduation 4 ETH;
the resulting starting FDV is about 1.38843 ETH. The last buy is capped with excess refunded.

Validation: 78 local contract tests passed; 3 opt-in/legacy cases pending. The explicit local mainnet-fork
lifecycle passed at block 65,273,142. Real contract/indexer parity passed for 121 trades. Keeper,
in-memory indexer, bytecode parity and contract-size checks passed. Frontend and indexer typechecks passed.
Real PostgreSQL passed: clean migrations, PF offset persistence/pricing, duplicate replay, two concurrent
workers, hard-kill/WAL recovery, logical restore, 10,000 unique + 1,000 duplicate events, and 1,000 API
requests at concurrency 50. The load run took 48.6 seconds on the local single-node test environment;
it is not a production capacity measurement. Production pg_dump/restore remains a separate gate.

**Release status:** implementation candidate for Jamie's review. No public deployment or push. Existing
contracts remain unchanged. External validation, custody, existing-funds inventory and production
operations gates below remain open. The hostile-pool recovery bound can still fail closed.

---

# Reconciliation with the independent review — 2026-09-16 (historical)

Jamie's review (`INDEPENDENT-REVIEW.md`, branch `BACKEND-NEIL` @ `945dfe2`) confirmed every test claim
below and found no fund-loss bug in the contracts; its findings were operational (keeper/indexer/metadata)
and integration seams. This section separates three different kinds of status that were previously
mixed together, and keeps **merge readiness** apart from **mainnet readiness**.

- **A. Completed code fixes** — implemented on this branch and covered by a test that runs locally and in CI.
- **B. Unverified integrations** — code exists and is tested against mocks/local chains, but has NOT been
  exercised against the real external system (live RPC, real 0x, real issuers, production Postgres tooling,
  Vercel KV/Blob). A green CI does not close these.
- **C. Pending design decisions** — the code offers a lever or a default, but the team has not decided
  the policy. These are handed to the core team (see `HANDOFF-JAMIE.md` §1 and the list at the end).

The exact contract diff for Jamie's re-review, annotated by topic, is `CONTRACT-DIFF-FOR-REVIEW.md`.

## A. Completed code fixes (tested)

| # | Finding | Fix | Evidence |
| --- | --- | --- | --- |
| H1 | Auto-distribution only worked for creator-delegated vaults | `CensusCurve.setKeeper`; `DividendVault._checkOperator` accepts operator OR `census.keeper()`; keeperd skips convert/distribute it is not authorized for and isolates pushes | `review.fixes.test.js` H1; keeper harness 7 |
| H2 | keeperd stalls after a failed broadcast; DRY_RUN could sign | `hash:null` recovery, dry-run never replaces, replaced hashes retained, cycle failures alert (deduped) | keeper harness 8, 10, 12 |
| H3 | Discovery stalls on busy ranges | Topic filter; chunk halves to `logChunk/16`, regrows | keeper harness 9 |
| H4 | Indexer RPC inside the serializable transaction | `prefetchPage` (all RPC) / `commitPage` (DB only); adaptive `LOG_PAGE` | in-memory harness asserts no RPC in `$transaction`; real-PG harness |
| H5 (lever only) | Graduation griefing by parked liquidity | `setRecoveryMaxSpendBps(coin, ≤5000)` deployer-only; swap still exact-price-limited | `graduation.recovery.test.js` H5; `review.invariants.test.js` #3 |
| M1 | Fresh deploy cannot launch HOOD coins | `ALLOWED_QUOTES` in `deploy.js`; runbook §4 | manual (deploy script) |
| M2 (contracts + route builder) | Maxima meme reverts at launch | coin→WETH→stock routes accepted; `basketPath` builds them or returns `null` | `memePair.test.js` M2 |
| M3 | Migration dust stranded | `sweepMigrationDust` → platform, once, graduated only | `graduation.recovery.test.js` M3; invariants #1 |
| M4 | One frozen stock bricks a claim | per-asset `_claim`, `ClaimDeferred` | `review.fixes.test.js` M4; invariants #2 |
| M5 | Blocked fee recipient halts trading | `_payFee` defers + `withdrawDeferredFee` | `review.fixes.test.js` M5; invariants #1, #2 |
| M6 | 18-decimal quote assumption | `Coin.quoteDecimals` + migration | real-PG harness (migration applied) |
| M7 | `/health` 503 during backfill | per-page `lastSuccessAt` | in-memory harness |
| M8 | Rate limit behind proxies | `TRUST_PROXY` hop count / CIDR list | config validation |
| M9 | Docker bakes `.env` | `.dockerignore` | file |
| M10 | Chain id defaulted to mainnet | required + RPC cross-check | metadata harness 12, 14 |
| M11 | Replayable metadata signatures | timestamped v2 message, expiry, monotonic writes | metadata harness 6, 10 |
| M12 | 500 leaks RPC URL | generic message, server log | metadata harness 13 |
| M13 | Fire-and-forget metadata write | result + retry in the wizard | frontend typecheck (UI, no automated test) |
| M14 | Stripped revert strings | custom errors on user-facing paths | `review.fixes.test.js` |
| M15 | keeperd state robustness | corrupt = hard error; lock file; replaced hashes kept | keeper harness 11 |
| gate | `upload.ts` unauthenticated | wallet-signed uploads bound to the image bytes (10-min expiry), per-wallet daily quota via KV, fail-closed without chain id/KV/Blob, generic errors | `frontend/api.upload.test.cjs` 16 checks |
| LOW | pool-fee validation, holder cursor, push fairness, alert dedupe, tip bump, locker cross-check, `readContract` at latest, cross-platform `test:pg`, CI | as listed in the previous version of this section | contract suite / keeper harness / CI workflow |

**Fund-safety invariants added for the new contract code** (`contracts/test/review.invariants.test.js`, real Uniswap V3, blocklisting quote):
1. `balance(curve) == Σ realQuote + Σ deferredFee + Σ migrationQuoteDust` holds through buys, sells, graduation, dust sweep and deferred-fee withdrawal; graduation migrates only `realQuote`; the sweep pays exactly the recorded dust to the immutable platform and nothing to the deployer; `withdrawDeferredFee` pays the recipient even when a stranger calls it.
2. With the vault blocked, platform and creator are still paid; with the creator blocked, platform and vault are still paid; deferred holder fees fund a later distribution; a blocked claimant's basket stays reserved while the other holder is paid in full and the vault stays solvent.
3. With the recovery bound widened to the 50% cap: only the deployer can set it and only up to the cap; setting it moves no balances; after a permissionless graduation the pool sits exactly at the migration price, the swap's value change at that price is ≥ 0, the curve holds exactly its recorded dust, and deployer/platform/creator balances are unchanged.

Structural change: `LaunchFactoryV2` deploys a `DividendVaultDeployer` in its constructor (factory runtime 24,413 → 11,259 bytes); constructor args and launch ABI unchanged.

## B. Unverified integrations (code present, not validated against the real system)

| Area | What exists | What has NOT been done |
| --- | --- | --- |
| 0x routes / Uniswap quoter | keeper planners, `probe` command, mock-router tests | No real 0x quote or execution for any supported stock; no quoter address confirmed on Robinhood Chain |
| Stock-token issuers | blocklist/tax/pause behaviour modelled with `AuditQuote` | Real issuer contracts never exercised (pause, blacklist, corporate actions, legal eligibility) |
| Price feeds | static `ETH_USD`; non-WETH quotes report 0 USD | No production feed chosen or wired |
| RPC | public RPC defaults; adaptive paging | No dedicated provider; log caps/timeouts of the real provider unmeasured |
| Keeper live path | 13 harness checks on a fake chain; dry-run only against real chains | No live run with a funded capped signer, `curve.setKeeper` set, replacement/recovery observed on chain |
| Indexer production DB | embedded PostgreSQL 18 harness incl. crash/WAL/restore | No managed-Postgres run; no `pg_dump`/`pg_restore` with production tooling; no real ingress/WebSocket load |
| Metadata / upload stores | Vercel KV (Upstash REST) + Blob mocked in tests | Never run against provisioned KV/Blob; KV `INCR`/`EXPIRE` semantics assumed from the Upstash REST API |
| Frontend flows | typecheck clean; metadata retry and signed upload wired | No browser run of the wizard with a real wallet (signature prompts, retry UI) |
| Deploy script | `ALLOWED_QUOTES`, `KEEPER_ADDRESS`, deployer address recorded | Not executed against any network since the changes (no testnet deploy in this pass) |
| CI | `.github/workflows/backend.yml` | Never run on GitHub yet (branch not pushed since it was added) |

## C. Pending design decisions (handed to the core team)

1. **B15 graduation discontinuity / H5** — accept-and-disclose the ~23% pool-below-curve opening, or redesign to continuous migration. The recovery-bound lever is a stopgap.
2. **Recovery-bound and dust-sweep custody** — both are deployer-only with no timelock, hard cap 50%. Decide whether the deployer key moves to a multisig/timelock before these levers exist on mainnet.
3. **Deferred-fee policy** — deferred fees stay in the curve indefinitely and can only go to the original recipient. Decide whether they should expire/redirect to the platform after N days, or stay as is.
4. **Keeper authority model** — the curve keeper can run distributions for every vault with operator-level trust (chooses `minOut`). Confirm this matches the "rewards auto-distributed" decision and decide who holds the keeper key.
5. **Meme-pair policy** — automatic vs per-coin opt-in; Prima-only vs Maxima; whether to expose company coins in the anchor picker (contracts support it, UI does not).
6. **Launch fee** — none exists; decide whether to add one (small factory change).
7. **Upload policy** — wallet-signed, 20/day/wallet default (`UPLOAD_DAILY_QUOTA`), no per-IP limit. Confirm the quota and whether smart-contract wallets (no EIP-191) need a path.
8. **Prima/Maxima naming**, **price-feed provider**, **RPC provider**, **treasury/keeper custody (B21)**.

## Merge readiness (code) — READY, with one condition

The branch compiles, typechecks and passes every suite locally (contracts 68/3/0 + parity/size + fork lifecycle; indexer in-memory + real PG; keeper 13/13; metadata 21; upload 16). Docs and env examples are updated; CI is defined. **Condition:** the contracts changed again in this pass (keeper authority, fee deferral, claim resilience, dust sweep, recovery lever, vault deployer) — Jamie should re-review `CONTRACT-DIFF-FOR-REVIEW.md` before the merge is treated as reviewed code. Merging does not deploy anything.

## Mainnet readiness — NOT READY

Independent of the merge: every item in **B** must be exercised against the real system and every
item in **C** decided, then the deployment/custody gates (release manifest, key custody, whether any
existing deployment holds real funds — still unconfirmed) and a joint go/no-go. Nothing on this branch
is deployed; no deployed contract inherits these changes.

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
