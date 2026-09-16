# Independent review — branch `BACKEND-NEIL` @ `945dfe2` (2026-09-16)

From Jamie's side: a line-level code review + flow audit of everything in `main..BACKEND-NEIL`, with every test suite re-run independently. Purpose: a findings list to work through so this branch can be **fixed and merged**. Nothing here is a reason to bin the branch — it is a clear improvement over `main`, and **no fund-loss bug was found in the contracts.** The problems are concentrated in the new operational code (keeper / indexer / metadata) and in integration seams.

## Verification (all run on this branch, 2026-09-16)
- contracts — `npx hardhat test --network hardhat`: **56 passing, 3 pending, 0 failing** ✅
- indexer, real PostgreSQL — `npm run test:pg`: **ALL REAL-POSTGRES CHECKS PASSED** (genuine hard-kill + WAL recovery, restore, 11k-event load) ✅
- indexer, in-memory — `npm test`: **PASS** ✅
- bot — `npm test`: **ALL KEEPERD CHECKS PASSED (7/7)** ✅
- frontend metadata — `node api.metadata.test.cjs`: **9 checks passed** ✅; `npx tsc -b` clean ✅

Every test claim in `HANDOFF-JAMIE.md` / `REPAIR-STATUS.md` holds.

## Three statements in the handoff that do NOT hold (please correct the docs)
- "Auto-distributed rewards (claimFor + keeperd)" — only true for vaults whose creator has run `setOperator(keeper)`. By default the keeper cannot convert or distribute for any coin (H1).
- "fails closed when unset" for `CENSUS_CHAIN_ID` — it silently defaults to mainnet `4663` (M10).
- "meme launches … currently both work (Prima and Maxima)" — only Prima is tested; a Maxima meme with a stock basket reverts at launch from the current frontend (M2).

## Severity key
**HIGH** = blocks an advertised flow, or an exploitable availability issue · **MEDIUM** = correctness/ops gap that will bite in production · **LOW** = hardening. None are fund-loss.

---

## HIGH

- **H1 — Automated holder distribution does not work by default (the keeper is not the vault operator).**
  - Where: `contracts/contracts/LaunchFactoryV2.sol:105` (`dv.init(token, ex, msg.sender)` → operator = creator); `contracts/contracts/DividendVault.sol:231,310,362` (operator-gated); `bot/src/keeperd.js:363-372` (one `try` wraps all four steps).
  - Problem: keeperd never reads `vault.operator()`. For any undelegated vault, `convertStep`/`distributeStep` revert "not operator" at `estimateGas` (`keeperd.js:185`); the throw aborts that launch's pipeline, so the permissionless `claimFor` push (`pushStep`) never runs either. Result: no conversion, distribution or push for undelegated coins, every cycle, plus one error alert per launch per cycle.
  - Fix: (a) factory sets the vault operator to a configurable Census keeper address (creator may still override via `setOperator`); (b) keeperd reads `operator()` once, skips convert/distribute when it is not the signer, and runs `pushStep` in its own `try`.

- **H2 — keeperd permanently stalls after a failed broadcast; DRY_RUN is not sign-free.**
  - Where: `bot/src/keeperd.js:185-189` (persists `pending{hash:null}` BEFORE `chain.send`); `:137` (`resolvePending` calls `chain.receipt(p.hash)` BEFORE the nonce check at `:145`); `:361` (`cycle()` calls `resolvePending()`/`discover()` outside any `try`); `:421` (`main` only `console.error`s); `:164` (`resolvePending` can `chain.send` a replacement even when `cfg.dryRun`).
  - Failure: `send` throws (fee below base, RPC 5xx/timeout, SIGTERM between the two persists) → record stays with `hash:null` → next cycle `receipt(null)` → ethers forwards `[null]` → node error → throw → every cycle fatals, console only, no webhook, no discovery. Recovery needs manual state-file surgery. Separately: with a stale `pending` and `DRY_RUN=true`, a fee-bumped replacement is signed and broadcast in "dry run".
  - Fix: when `p.hash == null` skip the receipt lookup and go to the nonce check (clear or resend); route cycle-level exceptions through `raise()`; gate `resolvePending`'s send path on `!cfg.dryRun`.

- **H3 — keeperd discovery stalls on busy block ranges.**
  - Where: `bot/src/keeperd.js:213` and `:253` (`getLogs` with no `topics` filter over `LOG_CHUNK` = 5000 blocks); the cursor only advances after a whole chunk succeeds.
  - Failure: one chunk over the RPC's log cap throws in `discover()` → cursor unchanged → same chunk next cycle → permanent stall, console-only.
  - Fix: filter by `topics` (`launchTopic`/`gradTopic`/Transfer), halve the chunk on failure, alert.

- **H4 — Indexer can livelock on a busy page: RPC calls run inside the 60 s serializable transaction.**
  - Where: `indexer/src/ingest.ts:269-322` — inside `prisma.$transaction(..., {timeout: 60000})` it awaits ext `getLogs` (:297), `getBlock` per event block for the hash check (:307) plus a second un-shared `getBlock` for the timestamp via `blockTime` (:48, called at :142/:199/:228), 4× `readContract` per Registered (:82-85), and `getBlock` at :277/:317. Page = 5000 blocks (`config.ts:15`).
  - Failure: a page with a few hundred trade blocks on public RPC exceeds 60 s → Prisma expires the tx → the loop retries the identical page forever; `/health` 503; the advisory lock is held across network I/O. Both harnesses use instantaneous RPC mocks, so tests cannot see this.
  - Fix: prefetch block hashes/timestamps/token metadata before opening the transaction (one `getBlock` per block, reused); adaptive `LOG_PAGE`.

- **H5 — Graduation can be griefed at ~zero cost (availability, not funds).**
  - Where: `contracts/contracts/CensusCurve.sol:52` (`RECOVERY_MAX_SPEND_BPS` is a 10% constant); `:399-410` (bounded recovery; `require(current == target)` reverts the whole graduation).
  - Problem: because a failed recovery reverts the entire tx, the griefer's parked liquidity is never touched. With the B15 gap (migration target ≈ 23% below the curve's marginal price) an attacker can park concentrated liquidity AT the curve price — arbitrage-neutral against the curve — and block a hot coin's graduation indefinitely. No admin/creator lever exists. Fail-closed is the right fund-safety choice; the product needs an escape hatch.
  - Fix: a per-coin adjustable recovery bound (deployer/creator, timelocked) or fallback to an alternate fee tier; best: resolve B15 with continuous migration, which removes the arbitrage-free parking band.

## MEDIUM

- **M1 — A fresh deployment cannot launch HOOD-quoted coins.** `contracts/scripts/deploy.js` never calls `setQuoteAllowed`; only WETH is allowed at construction (`CensusCurve.sol:121`). The frontend offers HOOD as an anchor → `register` reverts "quote not supported" (`CensusCurve.sol:175`), opaquely (M14). `MAINNET_RUNBOOK.md` only mentions `setZapPath`. Fix: env-gated `setQuoteAllowed(HOOD)` in `deploy.js` + a runbook step.
- **M2 — A Maxima meme-pair with a stock basket reverts at launch.** `frontend/src/lib/stockRoutes.ts` `basketPath()` (unchanged on this branch) roots swap paths at WETH or HOOD only and falls back to the WETH route for any other quote; `DividendVault.sol:100-107` now requires `first == quote_` → "endpoints" revert for a company-coin quote. `contracts/test/memePair.test.js` covers Prima only. Fix: policy decision (Prima-only, or passthrough basket `[quote]`), or build company-coin → WETH → stock paths.
- **M3 — Recovery surplus and migration dust are stranded forever.** `CensusCurve.sol:380-381` records `migrationTokenDust`/`migrationQuoteDust`; nothing can ever move them, so value captured from an attacker's mispriced pool is stuck. Fix: deployer-only sweep to `platform` (or add it to the locked position).
- **M4 — One paused/blacklisted basket stock bricks ALL claims for a holder.** `DividendVault.sol:391-405` `_claim` loops every basket asset atomically; a `safeTransfer` revert on one asset reverts the whole claim, including the keeper's `claimFor` push. Fix: per-asset claim, or continue on failure and leave that asset reserved.
- **M5 — An issuer blacklist of platform/creator/vault halts ALL trading of a stock-quoted coin.** `CensusCurve.sol:194-196` `_distributeFee` pushes fees on every trade; a blocked recipient reverts every buy/sell (this branch's own test "blocked fee recipient halts trading" demonstrates it). Fix: accrue fees in-contract (pull model) so a bad recipient cannot halt trading.
- **M6 — The indexer assumes every quote asset has 18 decimals.** `indexer/src/ingest.ts:62` (`10 ** (coin.decimals - 18)`), `:139-141`, `:197-198`, `:211-213`. A company coin with creator-supplied decimals ≠ 18 (`LaunchFactoryV2.sol:38`) used as a meme-pair quote mis-prices by 10^(18−d). Fix: use the quote's decimals (already stored).
- **M7 — `/health` is 503 for the entire initial backfill.** `ingest.ts:344-346` sets `lastSuccessAt` only after the whole range; `api.ts:39`. Orchestrators that restart unhealthy containers loop the backfill. Fix: mark success per committed page; document `/live` for liveness.
- **M8 — Rate limiting keys on the socket address with no `trustProxy`.** `indexer/src/api.ts:30,33`. Behind any load balancer all users share one 300/min bucket. Fix: `trustProxy` with the correct hop count / CIDR (not a bare `true`).
- **M9 — The Docker image bakes `.env` and the host `node_modules`.** `indexer/Dockerfile:6-9` `COPY . .` after `npm ci`; there is no `.dockerignore`. Fix: add one (`node_modules`, `.env`, `.test-build`, `*.log`).
- **M10 — Metadata `CENSUS_CHAIN_ID` silently defaults to mainnet.** `frontend/api/metadata.ts:40` (`|| 4663`). On the testnet project without the var every write is 400 "wrong chain" and silently swallowed (M13). Fix: require it (503 when unset) and cross-check `client.getChainId()`.
- **M11 — Metadata signatures are replayable (rollback).** `frontend/api/metadata.ts:55-57` signs chain/token/content-hash only — no nonce, timestamp or expiry. A captured signature for v1 can overwrite a later v2 forever. Fix: include a nonce or timestamp + expiry; keep the last-seen nonce per coin.
- **M12 — The metadata 500 path leaks the RPC URL.** `metadata.ts:123-124` returns `e.message`; viem request errors embed the URL and request body. Fix: generic message; log details server-side.
- **M13 — The metadata write is fire-and-forget with no recovery path.** `frontend/src/lib/metadata.ts:43-53` swallows every failure; `frontend/src/pages/Launch.tsx:252` discards the result. Rejecting the second wallet prompt, RPC lag → 403 "unknown launch", or unprovisioned KV → the description is silently lost and there is no UI to retry or correct. Fix: surface failure + a "save details" retry on the coin page; ask for the signature only after the server confirms KV is provisioned.
- **M14 — Global `revertStrings: "strip"` hides every `require` reason.** `contracts/hardhat.config.js:17` (pre-existing, not from this branch). All new reasons ("quote not supported", "insolvent", "minOut", "recovery failed", …) reach users as a bare "execution reverted". Fix: convert the important `require`s in `CensusCurve`/`DividendVault` to custom errors (4 bytes; those contracts are not near EIP-170).
- **M15 — keeperd state-file robustness.** `keeperd.js:107-111` treats a corrupt state file like a missing one (the in-flight record is dropped → nonce reuse replaces a live tx; cursor resets); no single-instance lock (two daemons on one file corrupt `pending`, `:113-118`); replacement overwrites the original hash (`:166`), so a mined original is reported as "superseded". Fix: fail loudly on parse error; lock file; keep replaced hashes.

## LOW / hardening
- `CensusCurve.register` does not validate `poolFee` ∈ {100, 500, 3000, 10000} (`:169-186`); an invalid tier makes `graduate` revert forever (pre-existing).
- `DividendVault._credit` floor remainder is reserved but unclaimable and unsweepable (`:222-225`).
- `convertLaunchFees` takes `poolFee` from the operator (`DividendVault.sol:357`); keeperd should pin it to `curves(coin).poolFee`.
- `setZapPath` for each graduated company coin is a manual deployer step; could be auto-set at graduation for WETH-quoted graduates.
- keeperd: holder cursor starts at launch block + 1 (`:224/:250`) so same-block bundle buyers are never pushed; `MAX_ACTIONS_PER_CYCLE` (10) < `PUSH_MAX_PER_CYCLE` (25) lets one launch starve the rest (`:342`); unbounded holder scan (`withdrawableOf` × basket per holder per cycle); alert storms with no dedupe (`:285/:320/:161/:178`); replacement bumps `maxFeePerGas` only (ethers re-fills the tip, which can be rejected as underpriced where the tip is non-zero); no revert backoff; `LOCKER_ADDRESS` is not cross-checked against `curve.locker()`.
- indexer: `onGraduated` (`ingest.ts:170-177`) leaves the curve price/reserves in place although the pool opens ≈ 23% lower; the migration-recovery `Swap` inside the graduation tx is recorded as a phantom `venue=pool` trade (`:292`); the `finalized` tag means L1 finality lag on a Nitro chain and there is no pending layer; a reorg past finality is detected but never rewound (`:276-278`, `:343`); `readContract` at a historical block (`:82-85`) needs an archive node (token metadata is immutable — read at `latest`); `/stats` runs an uncached `COUNT(*)` (`api.ts:100-106`); no per-IP WebSocket cap (`:110`); `quoteSymbol`/USD are blank/0 for every non-WETH quote (`:64`, `:91`, `:211`).
- metadata: the KV `SET` result is never checked (`:118-120`, an `{error}` reply becomes 200); smart-wallet creators (`creator = msg.sender`) can never write metadata; the parity guard `npm run artifacts:check` is not wired into deploy or CI.
- repo: ~1,200-line `npm audit` dumps are committed (`*/audit-dependencies.json`); `test:pg` uses `taskkill` (Windows-only); there is no CI, so none of the five suites run automatically.

## Residual risks this branch documents deliberately (open by design — not bugs)
- External pools bypass Census fees before AND after graduation (B09): bought tokens are transferable; the primary market (new supply) is captive, secondary trading is not.
- Third-party LPs in the canonical pool dilute the locked position's fee share.
- Unrecognized external pools accrue dividends they never claim (B16) — those rewards are stranded.
- B15: the pool opens ≈ 23% below the curve's exit price — needs the explicit decision requested in `HANDOFF-JAMIE.md`; continuous migration is recommended (it also closes H5).

## Flow verdicts
- **Launch coin (ETH quote):** works end-to-end.
- **Launch via HOOD:** contract OK; blocked on a fresh deploy by M1; one-tap ETH additionally needs `setZapPath`.
- **Launch via stock basket (Maxima, ETH/HOOD quote):** works; quoted in a company coin: M2.
- **Meme pair (Prima, quoted in a graduated company coin):** works — full lifecycle tested (fees in the company coin, locked MEME/XYZ pool).
- **Fees:** 2% → 25% platform / 75% creator-side by `holdersBps`, correct pre-grad (curve) and post-grad (locker split tested at 0/40/100%); caveats M5, M14.
- **Distribution to holders:** contract accounting, conversion and `claimFor` are correct; the automation is unreliable as delivered (H1–H3).
- **Liquidity / graduation:** locked full-range LP and poisoned-pool recovery are fund-safe; H5, M3, B15.

## What is solid — do not "fix"
- `_restoreMigrationPrice` + `uniswapV3SwapCallback`: bounded, exact-price-limited, callback locked to the graduating pool, shared-custody balance deltas attributed correctly, fail-closed.
- `DividendVault` reserve/fraction accounting (a 700-operation independent ledger agrees), measured-delta swaps, strict 0x allocation, idempotent `claimFor`.
- `LaunchLocker.registerGraduated` + `collectFees` split for curve positions (protocol → `feeVault`, holders' share of both assets → vault, remainder → creator).
- keeperd `sendManaged` ordering (estimate → persist intent → send → persist hash), one in-flight tx, fee cap, signer floor; every on-chain step is idempotent, so a duplicate send only wastes gas.
- Indexer: curve replication mirrors `_buy`/`_sell` exactly; receipts + aggregates + cursor commit in one serializable transaction (exactly-once holds); all seven event ABIs match the Solidity; migrations match the schema.
- Metadata: the on-chain creator check ends predicted-address squatting; message canonicalisation is mirrored exactly between client and server; the regenerated bytecode matches a fresh compile (`main`'s hex was stale).

## Suggested order of work
1. H1, H2, H3 — small and mechanical; after these, "auto-distribution" is real.
2. H4 — prefetch RPC data outside the transaction.
3. Decide B15 → then add the H5 lever.
4. M1, M2, M14, M10–M13, then the rest.
5. Add CI that runs all five suites on every push.
