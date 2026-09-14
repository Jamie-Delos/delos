# Census backend audit and launch readiness

**Repair update, 2026-09-15:** this document preserves the original audit baseline. Several findings now have tested fixes or mitigations on the local branch; see [REPAIR-STATUS.md](REPAIR-STATUS.md) for current status. Remaining-risk tests intentionally still reproduce unresolved behavior. The baseline counts below are historical.

Date: 2026-09-13. Reviewed main revision: `c000052712ea739fde3e8b050769344b9def697b`. Audit branch: `codex/backend-launch-readiness`.

**Decision: NO GO for mainnet funds.** A basic lifecycle works, including on a local fork of the configured mainnet dependencies, but reproduced defects can misallocate liquidity, create unfunded dividend entitlements, lose indexed events, and violate the advertised fee distribution. Passing reproduction tests demonstrate the defects; they are not passing security controls.

This is a first-party source audit and adversarial test pass, not an independent security certification. Production source was not changed. Only audit documentation, test harnesses and a test-only token mock were added. No public-chain deployments, transactions, transfers, load attacks or third-party messages were made. The scheduled PR feedback task was paused. Frontend redesign is outside this work; serverless API handlers and ABI/bytecode compatibility remain backend integration boundaries.

## Scope and evidence

Reviewed the launch factories, ERC-20 transfer restrictions/hooks, shared bonding curve, graduation, locked Uniswap positions, treasury contracts, dividend accounting, keeper and legacy reward/buyback scripts, indexer, Prisma schema, API/WebSocket handlers, metadata/upload/0x serverless handlers, deployment configuration and runbooks. Re-ran the earlier audit reproductions and added external-pool, issuer-behavior, accounting, workload and fault-injection cases.

| Check | Result | What it proves / does not prove |
| --- | --- | --- |
| Full local contracts suite | 36 passing; 3 opt-in fork cases skipped | Includes 15 defect reproductions, 20 existing tests and a 500-operation workload. Passing defect assertions mean unsafe behavior persists. |
| Separate Robinhood mainnet fork | 1 passing, pinned at block **62,225,577** | Fresh local V2 launch, buy, one quote-asset dividend claim, graduation, actual configured router swap and locker collection. No live chain writes. Does not test real stock baskets, 0x or fix fee correctness. |
| Curve workload | 500 mixed buys/sells, 10 wallets; reserve identities hold | Standard WETH, one Prima curve, deterministic sequence. Maximum observed trade gas 122,314. Not mainnet TPS or maximum capacity. |
| Indexer fault injection | RPC and DB errors advance cursor; replay inflates state | Actual handlers executed against in-memory RPC/DB adapters. |
| Indexer replay workload | 10,000 unique trades + 1,000 replays produce 11,000 aggregate trades/points | Unique trade rows do not protect derived accounting. No real database benchmark. |
| API injection workload | 1,000 requests, concurrency 50, zero failures for valid empty results | Actual Fastify handlers, empty stub DB, in-process transport. Observed p95 around 6–8 ms is **not a production latency claim**. Invalid pagination produces 500. |
| Keeper planner | Same-asset payout fails on unnecessary self-swap quote | Actual planning code, mocked quoter; no key or network access. |
| Indexer TypeScript build | Pass | Compile compatibility only. |
| Runtime dependency advisory check | Indexer: 2 high-severity affected packages; bot/contracts: 0 reported | See JSON files in this directory. Reachability of each advisory is not established. Solidity/DEX build tooling is excluded by `--omit=dev`. |

No local `docker` or `psql` executable was available. A real PostgreSQL deployment, migration/restart/reorg exercise, database contention, public HTTP/WebSocket load and a sustained production-like soak were not run. Secret inventories, hosting IAM, external audit reports, production service settings and production keeper credentials were not reviewed. These are outstanding release gates, not implicit passes.

## Fee model: the external-liquidity problem is present here

The incident statement supplied by the user is treated as a motivating scenario, not an independently verified account of another project's incident. Census itself was tested using real Uniswap V3 bytecode locally.

1. A holder can seed an alternate pool before graduation. Trades in it do not call `CensusCurve`, emit no Census `Traded` event and pay no Census curve fee.
2. After graduation, another pool can trade the token without generating any fees in Census's locked position.
3. **Even in the canonical pool, another LP can own a separate NFT and collect their own fees.** Routing all buys to the correct pool still does not give Census all pool revenue. LP earnings depend on active liquidity, ticks, price movement and competing positions. A full-range position may earn substantially less than a concentrated competing position.
4. External pools can also accumulate holder dividends because they are not excluded. Those entitlements are generally inaccessible through the pool's contract API.

These are consequences of freely transferable tokens and permissionless liquidity, not bugs in Uniswap. Uniswap describes LP fees as allocated to liquidity providers; its V3 design supports different fee-tier pools. [Uniswap LP fees](https://support.uniswap.org/hc/en-us/articles/20901935681677-What-is-a-liquidity-provider-LP-fee), [V3 whitepaper](https://app.uniswap.org/whitepaper-v3.pdf).

**Recommended product invariant:** promise a defined share of fees actually received by Census's contracts/positions, with auditable receipts and an explicit venue boundary. Do not promise a percentage of all global token volume. If universal collection is essential, redesign the economic and transfer model before launch and independently assess compatibility. Asking aggregators to prefer a venue, detecting pools, or adding a UI fee badge cannot enforce a global levy. A transfer tax is not a drop-in V3 fix: standard V3 routers do not support fee-on-transfer tokens. [Uniswap token integration limitations](https://developers.uniswap.org/docs/protocols/v3/concepts/unsupported-tokens).

For a multi-hop buy, distinguish each pool fee, explicit Census fee, integrator fee, price impact and gas. Fees on sequential hops compound rather than simply adding: under a simplified fee-only model, two rates a and b cost `1 - (1-a)(1-b)` of input. Do not charge or promise payouts based on nominal routed volume when the treasury never received the corresponding asset. Index actual receipts by chain, transaction, asset and recipient.

## Findings and required changes

Severity: **High** means a launch-blocking risk to funds, payouts, essential data or execution. **Medium** means a material integrity/availability/operational issue. Preconditions and test coverage are stated to distinguish permissionless exploits from privileged configuration risks.

### B01 — High: preinitialized graduation pool diverts almost all raised quote

Location: `contracts/contracts/CensusCurve.sol`, `graduate()` (around lines 283–335).

Pool initialization accepts an existing pool's price. Minting uses zero minimum amounts, and unused assets go to the creator. A creator or another party can initialize the pool at an adverse ratio before graduation. The reproduction raised **4.9 WETH** and refunded **4.899765625000000012 WETH** to the creator, despite the intended liquidity lock. An outside attacker does not automatically receive that refund; creator participation/collusion is the direct extraction scenario.

Require a price/liquidity invariant at migration, enforce nonzero economically justified mint minima, bound refund dust and retain/reconcile substantive unused reserves. Rejecting an existing pool alone permits a griefing denial of graduation; design a safe recovery path rather than merely adding that check. Test front-running, preinitialization, existing liquidity and both token sort orders.

### B02 — High: quote-asset dividends can be credited repeatedly

Location: `DividendVault.sol`, `distribute()` and `claim()`.

When a basket asset equals the quote asset, distribution credits a share without spending it. A later call uses the entire balance again, including amounts already owed. Two equal holders funded by 10 units can acquire 20 units of aggregate claims; the first claimant drains the 10-unit pot and the second receives nothing. Capping payouts at live balance hides insolvency instead of fixing it. Also applies to mixed baskets containing quote.

Maintain an explicit per-asset liability ledger and distinguish new fee receipts from reserved claim balances. Distribution must be idempotent when no new fees arrive. Test repeated distribution, partial claims, additional deposits, dust and mixed quote/nonquote baskets.

### B03 — High: duplicate basket assets inflate transfer-settled entitlements

Location: `DividendVault.sol`, constructor and `_settle()`.

Duplicate assets are accepted. Settlement loops over the same asset twice while rebasing debt using the new balance. Reproduction: a sole holder has a valid 10-unit claim; transferring half their launch tokens changes the claim to **15 units**, while the vault still holds 10. This is distinct from B02 and uses a nonquote payout asset.

Reject duplicate/zero/unsupported basket assets at creation and assert asset-level total liabilities never exceed backed receipts across arbitrary transfers and claims.

### B04 — High: post-graduation V2 fees use the wrong beneficiaries and ratio

Location: `CensusCurve.sol:318`, `LaunchLocker.sol:111–139`.

Curve fees use 25% platform plus a 75% creator side split by `holdersBps`. Graduation instead wires the dividend vault as the locker's protocol recipient. The locker sends 25% there and 75% to the creator, with no holder-share parameter. A 100%-holders launch reproduced creator **0.0075 WETH**, platform **0**, vault **0.0025 WETH** rather than creator 0/platform 0.0025/vault 0.0075. LP fees can arrive in both assets; launch-token fees sent to a quote-only vault also need a disposition policy.

Use an explicit shared fee specification and accounting implementation across both phases. Test holdersBps 0/partial/10000, both received fee assets, all treasury variants and cumulative rounding.

### B05 — High: migrated position can revert to a pre-graduation fee split

Location: `LaunchLocker.sol`, `register()`, `isGraduated()`, `collectFees()`.

Registration sets `graduated=false`; the first collection latches based on current tick. A sale moving price below the migration tick before that collection causes an already migrated position to send 100% of collected fees to the creator. Reproduced against local real V3 contracts.

Register migrated positions with an explicit irreversible phase flag. Economic phase must not be inferred from an immediately manipulable spot tick.

### B06 — High: arbitrary quote behavior breaks shared reserves or freezes trading

Location: `LaunchFactoryV2.sol:createLaunch`, `CensusCurve.sol:buy`, `_distributeFee`.

The factory permits arbitrary quote tokens. The curve credits nominal input rather than measured receipt. A test quote charging 10% on transfer created a **10-unit shortfall** against the sum of two launches' reserve ledgers. Shared custody spreads the solvency risk across launches using that quote. Separately, blacklisting a fee recipient caused otherwise valid buys to revert because fee transfers happen synchronously.

Define supported collateral explicitly, validate token implementation/upgrade risks, account by measured deltas where appropriate, and test negative rebases, transfer fees, pauses and blacklists. Consider isolated collateral custody and pull-based fee balances to reduce unrelated-recipient failures. Delta measurement does not solve subsequent issuer rebases/freezes.

### B07 — High: unvalidated payout paths credit assets never received

Location: `DividendVault.sol`, constructor and Uniswap `distribute()`.

A stored path can end in a different token from the basket entry. The router's returned amount is credited to the intended stock without checking its actual balance delta. Reproduction delivers 10 X to the vault and credits a 10 S claim with zero S backing. A malformed creator-configured route can therefore silently misrepresent payout backing.

Validate path encoding, endpoints, enabled fee tiers and supported tokens. Credit measured output-asset deltas, and enforce a coherent slippage/price policy.

### B08 — High trust boundary: operator controls economically unsafe 0x execution

Location: `DividendVault.sol:distributeVia0x`, `bot/src/keeper0x.js`.

Pinning an allowance target limits the call destination, but does not guarantee output value, weights or recipient economics. A privileged operator can pass zero minimum output. A **mock AllowanceHolder** reproduction spends all quote and creates no payout; this establishes the trust boundary, not an exploit against the deployed 0x implementation. Contract comments claiming a rogue quote can never drain funds overstate the protection.

Validate the returned transaction target, allowance spender, chain, tokens, recipient and amounts against approved dependencies. Enforce bounded nonzero slippage and an independent price/deviation guard where feasible, caps and monitoring. Document operator custody powers. A spot quoter is an execution estimate, not a manipulation-resistant fair-price oracle. Separate transaction signing from arbitrary route acquisition and test compromised/stale/malformed provider responses.

### B09 — High if universal fees are promised: external liquidity bypasses revenue

Locations: `LaunchToken.sol:_update`, `CensusCurve.sol`, `LaunchLocker.sol`.

Three real-V3 reproductions confirm alternate pools before/after graduation and outside LP fees in the same pool. This is the architectural issue discussed above. Resolve the product invariant, attribution and liquidity-economics model before launch. Do not attempt to repair it solely through router outreach.

### B10 — High: ingester advances beyond failed RPC pages and failed writes

Location: `indexer/src/ingest.ts:scan`, `onRegistered`, `onGraduated`.

Errors are caught and logged, but the cursor advances. An unavailable RPC page is treated like an empty page. A DB failure is also skipped permanently; registration metadata failures persist fabricated defaults, potentially including zero supply. RPC and DB fault injections both reproduce cursor advancement.

Commit complete pages/blocks and cursor in a database transaction only after durable success. Retry with bounded backoff/range splitting, quarantine undecodable events, expose a stalled/unhealthy state and provide replay/reconciliation tooling. Never silently replace required economic metadata with defaults.

### B11 — High: replay, restart and parallel writers corrupt derived accounting

Location: `indexer/src/ingest.ts:onTraded`, `getCursor`, `runIngest`; Prisma models.

Trade upsert is unique, but reserves, counts, volume and price points update again on duplicates. Startup begins inclusively at the saved block. The workload produced 11,000 aggregate trades from 10,000 unique events. Writes are not transactional and read-modify-write updates can race. Each API instance also starts an ingester, with no demonstrated single-writer lease.

Use chain/block/transaction/log identities, atomic event application, one writer or partitioned ownership, transactional derived updates and rebuildable projections. Test crash after every write and two simultaneous workers; require an identical state digest after replay.

### B12 — High: no reorg/finality handling or post-graduation accounting coverage

Locations: `indexer/src/ingest.ts`, `indexer/prisma/schema.prisma`.

Only Census Registered/Traded/Graduated events are ingested. No pool swaps, NFT fee collections, distributions or claims are reconciled; there is no block-hash rollback journal or finalized cursor. Post-graduation prices/volume are consequently incomplete, and a fork can leave orphaned trades in published state.

Add canonical block lineage, separate provisional/finalized views, rollback/replay and onchain balance reconciliation. Cover the official venue and clearly label external-venue coverage limits. A holder payout ledger should account for received, converted, owed and claimed assets independently of UI volume.

### B13 — High: a clean database deployment lacks migrations

Location: `indexer/Dockerfile` and `indexer/prisma/`.

The container invokes `prisma migrate deploy`, but there are no committed migration files to create the schema. A fresh deployment is not reproducible. The image installs from package.json rather than a locked `npm ci` build.

Commit reviewed initial/evolution migrations, build from the lockfile, rehearse clean deployment, upgrade, interrupted migration and backup restore on real Postgres. Provision readiness probes that validate the database and ingestion lag.

### B14 — High integration blocker: committed client bytecode disagrees with fresh factory

Location: committed frontend LaunchToken creation-bytecode helper versus current compiled `LaunchToken`.

The earlier audit reproduction still rejects a vanity salt generated from the bundled bytecode on a fresh factory. This is a backend release/artifact issue even while visual frontend work is paused. Existing deployed versions may have different artifacts; this run does not assert all historical factories are identical.

Generate ABI/creation-bytecode/address metadata from a versioned build, verify predicted CREATE2 address against the target factory and test client-produced transaction payloads against that exact release.

### B15 — Medium: migration price drops when virtual quote disappears

Location: `CensusCurve.sol:graduate`.

The curve exit spot price includes virtual quote, while the pool starts from real quote only. With tested settings the pool/curve price ratio was **0.765625**, a **23.4375% drop** before additional trading costs. This is a deterministic economic discontinuity, not slippage protection. It creates an arbitrage/loss and disclosure issue distinct from pool poisoning.

Specify a continuous migration mechanism or explicitly model and accept the discontinuity. Simulate reserve sizing, final-buy overshoot, concentrated competition and immediate exits across parameter ranges.

### B16 — Medium: external custody accrues inaccessible dividends; timing is economically gameable

Locations: `DividendVault.sol:eligibleSupply`, exclusions and distribution timing.

Only predefined addresses and the migrated pool are excluded. An alternate pool earns unclaimable dividends in the reproduction. Bridges, exchange omnibus accounts and other contracts need an explicit policy. Additionally, ownership at distribution determines entitlement, not time held while fees accumulated. Buying before a visible keeper distribution and selling afterward deserves a dedicated economic/MEV test; such a profitable attack was not reproduced in this pass.

Choose and document eligible ownership and accrual timing. Do not assume all holders can call `claim()`, nor that enumerating known pools solves every custody case. Test distribution sandwiches, dust transfers and four-asset hook gas/overflow bounds.

### B17 — Medium: keeper orchestration and recovery are incomplete

Location: `bot/src/keeper0x.js`, legacy `index.js`, `buyback.js`, `lib.js`.

The quote-equals-basket case unnecessarily asks Uniswap to quote a same-token swap and fails (reproduced). Forced 0x mode permits partial baskets and recomputes weights from remaining balance next run, potentially distorting allocations. There is no demonstrated multi-vault scheduler/collection pipeline, durable job idempotency, transaction replacement handling or bounded provider timeout policy. The modern keeper does refuse live Uniswap execution without a quoter and checks that the signer is the operator—retain those controls.

Legacy reward tools use zero minimum output, nondurable sequential airdrops and incomplete holder eligibility. The legacy buyback can spend the signer's whole available WETH rather than a dedicated job allocation. Dry-run amounts can mix token units. If these tools are retired, remove them from the supported release path; otherwise harden and test them. POSIX environment assignments in package scripts also require a portable launcher for Windows use.

### B18 — Medium: metadata writes are unauthenticated and non-atomic

Location: `frontend/api/metadata.ts` (backend handler).

Anyone can be first to write metadata for a syntactically valid token address, including a predicted address. There is no creator signature or onchain existence/ownership check. Separate GET and SET calls race, and keys lack chain ID. This can impersonate/squat launch descriptions. This is source-confirmed; the hosted KV was not mutated.

Require a domain/chain/address/nonce-bound creator authorization, validate launch ownership, use atomic conditional writes and an explicit authorized correction policy. Treat branding/company verification as a separate authenticated attestation, never as a user-controlled description field.

### B19 — Medium: public API resource controls and health checks are insufficient

Locations: `indexer/src/api.ts`, `bus.ts`, upload and 0x handlers.

Invalid pagination becomes a 500; health reports success without consulting DB/ingestion. WebSocket sending lacks bounded buffering/backpressure. Uploads have a per-file size limit but no caller quota/authentication; a public 0x proxy can consume provider quota. No application rate limits or service budgets were found. Deployment-layer controls may exist but were not supplied. The proxy's fixed upstream and parameter allowlist are useful, but clients can select fee parameters; enforce backend policy if these are intended as mandatory Census fees.

Add request schemas, pagination/cursors, timeouts, connection/resource caps, storage quotas, authenticated writes, upstream budgets, structured redacted logs and liveness/readiness separation. Load-test the actual ingress and real DB; do not extrapolate from the stub API benchmark.

### B20 — Medium: prices, charts and statistics can mislead

Locations: `indexer/src/ingest.ts:derive`, API chart/stats routes.

Quote decimals are assumed to be 18; WETH/USD uses a configured static price, other quote USD values are zero. Cross-asset quote volume is summed despite incompatible units. Floating-point aggregates lose precision. Charts select the earliest N points, so an active asset's chart can stop showing current activity. Launch timestamps are ingestion-time defaults rather than historical creation times.

Store exact monetary values and asset IDs, ingest verified decimals and time-qualified price feeds, represent unavailable prices as unavailable, and use recent-window/time-bucket chart queries. Keep finalized financial accounting separate from display approximations.

### B21 — Medium: deployment and key-management checks are too weak

Locations: `contracts/scripts/preflight.js`, deploy/launch/verify scripts, network configuration.

Preflight checks only signer/balance. Some launch/verify/fork scripts still target older ABIs. Deployment provenance is written at the end, so partial failure loses the structured journal. Partial treasury configuration silently selects a different treasury type. Curve deployer permissions remain on an immutable deployer address; treasury withdrawal and operator permissions need an explicit custody model. Indexer defaults target testnet while other components default to mainnet.

Create one validated release manifest with chain ID, block, code hashes, constructor args, links, fee configuration, route endpoints, treasury/operator ownership and ABI hashes. Fail closed on inconsistent configuration. Journal each deployment transaction, support resume and verify a dry rehearsal. Review multisig/hardware-backed signing, role rotation and incident containment. Because deployed contracts/LP locks are largely immutable, define the replacement/migration response before accepting funds.

### B22 — Medium: affected runtime dependencies and absent release automation

The npm advisory check flags Fastify and find-my-way in the indexer at high severity; the suggested Fastify update is a major upgrade requiring compatible plugins and regression tests. Some listed advisories depend on features this service may not use (for example HTTP/2 or streamed response handling); the audit does not claim all are remotely exploitable here. No tracked CI workflow was found.

Triage advisories against actual deployment configuration; update supported versions with lockfiles, build a reproducible image and add compile, invariant, replay/recovery, API and release-manifest checks to CI. Review build-time Solidity dependencies separately; a zero runtime npm count does not audit Solidity semantics.

## External dependencies and launch gates

Read-only RPC verification returned chain ID **4663**. Configured factory, NPM, router and WETH addresses all contained code; NPM and router `factory()` matched the configured factory. The separate fork test exercised those actual dependencies. These checks are not code-hash/source verification of every deployed dependency or an audit of any existing Census deployment.

| External factor | Evidence / risk | Required release gate |
| --- | --- | --- |
| Aggregator availability | 0x currently lists Robinhood 4663 as supported. Chain support does not establish support/liquidity/permissions for each stock or quote asset. | Obtain executable routes for every supported pair and direction; verify token/target/spender, simulate at a pinned state, handle no-route/429/timeout/stale quote. [0x supported chains](https://docs.0x.org/docs/introduction/supported-chains) |
| Public RPC limits | Official docs describe public RPCs as rate-limited and unsuitable for production. | Dedicated primary/secondary providers; archive retention, log limits, chain-ID validation, failover and quota/lag alarms. [Robinhood connections](https://docs.robinhood.com/chain/connecting/) |
| RWA issuer rules | Official stock-token documentation describes debt securities providing economic exposure, trading/tokenization windows, multiplier-based corporate actions and jurisdiction restrictions. ERC-20 compatibility is not a blanket permission or liquidity guarantee. | Verify each token's issuer/proxy/admin behavior, permitted distribution and holder eligibility with qualified counsel; test pause/blacklist/market closure, stale feed, corporate action and delisting handling. [Stock tokens](https://docs.robinhood.com/chain/stock-tokens/) |
| Price/market availability | A DEX can remain open while underlying issuance/redemption is closed or liquidity is thin. | Independent freshness/deviation checks, price-impact limits, no forced zero-output fallback and a well-defined stalled-distribution state. |
| L2/sequencer/bridge | Soft inclusion is not the same as settled/finalized economic history. | Define finality thresholds, sequencer downtime recovery, gas spikes, bridge delays and reorg replay. Confirm chain-specific behavior against release-time documentation. |
| Outside liquidity | Pool substitution, same-pool liquidity competition and custody are permissionless. | Quantify expected revenue from owned active liquidity; route monitoring is informational, not collection enforcement. |
| Operational custody | Creator/operator availability and treasury keys are part of the payout trust model. | Dedicated capped signers, alerting on balance/operator changes, recoverable jobs, incident contacts and documented immutable-contract limitations. |

Source-specific legal/market descriptions above are integration constraints requiring validation, not a legal conclusion about Census. No test used an actual stock-token investment or a live payout.

## Work sequence and acceptance criteria

1. **Agree the accounting specification before patching:** venue-limited revenue; pre/post-graduation beneficiaries; handling both LP fee assets; eligible holders; supported collateral/baskets; custody and route trust. Write examples in base units including partial holder allocations and multi-hop swaps.
2. **Fix funds correctness first:** B01–B08, with particular priority on graduation reserve retention, quote/duplicate basket insolvency and phase-independent fee splits. Convert every defect test into an assertion of safe behavior. Fuzz many seeds, decimals, supplies, weights, dust, claims/transfers and multiple concurrent launches. Invariants: collateral backs each liability, no recredit without receipts, no migration value disappears, fee distributions match specification.
3. **Fix backend durability:** transactional event application, reorg rollback, idempotency, migrations and independent API/worker scaling. For every crash boundary, restart and compare final state with a clean replay. Verify exact onchain receipt/distribution/claim reconciliation.
4. **Rehearse a complete release:** production-like database + API + worker + keeper against the selected fork/testnet; both Prima and Maxima; supported real asset routes; reverted/successful receipts; claims by many wallets; bytecode/version parity. The current one-case fork run is only a starting point.
5. **Run real stress and failure testing:** agree expected peak volume first, then sustain at least 2x that peak and test a short 5x burst in isolated infrastructure. Measure p50/p95/p99, error rate, CPU/RAM, DB connections, ingestion lag, RPC budget and WebSocket buffer growth. Add slow consumers, disconnect storms, provider429/timeout, DB restart, worker termination, gas spikes and keeper replacement. Require zero silent event loss/duplication, backed payouts and bounded recovery; agree numerical latency/RTO/RPO budgets before calling it a pass.
6. **Independent release review:** review patched contracts, deployment artifacts and economic assumptions; close high findings; resolve or explicitly accept medium risks with owners. Rehearse backups and incident response. A calendar date or passing happy-path tests must not override open funds-safety findings.

## Reproduction commands

Run from the indicated package directories on Node with existing dependencies. Hardhat must remain local. No key is required.

```powershell
# contracts directory: local-only complete suite
$env:BASE_FORK_RPC_URL=''
$env:AUDIT_MAINNET_FORK=''
npx hardhat test --network hardhat

# contracts directory: optional read-only mainnet fork, all transactions remain local
$env:AUDIT_MAINNET_FORK='1'
npx hardhat test --network hardhat test/backend.mainnet-fork.test.js
$env:AUDIT_MAINNET_FORK=''

# indexer directory
node audit.repro.cjs
node backend.readiness.cjs
npm run build

# bot directory
node backend.readiness.cjs
```

Audit additions: `contracts/test/backend.readiness.test.js`, `contracts/test/backend.mainnet-fork.test.js`, `contracts/contracts/mocks/AuditQuote.sol`, `indexer/backend.readiness.cjs`, `bot/backend.readiness.cjs`. Earlier reproductions remain in `contracts/test/audit.repro.test.js` and `indexer/audit.repro.cjs`. Fork test prints its block on every run; results may vary with dependency state/RPC availability. Test-only mocks must not be included in production deployment scripts.
