# Claude / Fable release-day handoff

You are working in the Census-Core-Repo workspace. Today is the release day. Run the complete readiness pass below and return a decision backed by command output and file/line references. Do not claim launch readiness from component tests alone.

## Source of truth

Read these first:

1. `audit/GO-LIVE-READINESS-2026-09-21.md`
2. `audit/V4-MIGRATION-SPEC.md`
3. `audit/FULL-AUDIT-2026-09-17/GATES.md`

The current decision is NO-GO for the agreed V4 product. The central question is whether your work closes that decision with executable evidence.

## Required execution

Work in a disposable sandbox/worktree. Do not deploy, broadcast transactions, rotate credentials, change cloud access, or push to a remote. Do not treat a skipped test as a pass. Keep existing user changes and report unrelated dirty files.

Run and capture output for:

- `contracts`: install from the lockfile if needed; compile; `npm test`; `npm run test:v4`; `npm run rehearse:bonding`; `node scripts/exportTokenBytecode.js --check`; PF indexer parity.
- `contracts` target-chain forks: Robinhood V3 lifecycle and V4 PoolManager compatibility on a local fork only. Pin block numbers. Run the Base legacy fork too and either repair the obsolete setup or mark it explicitly retired with a replacement.
- `indexer`: Prisma generate, build, in-memory tests, real PostgreSQL readiness, crash/WAL recovery, concurrent exactly-once ingest, restore rehearsal and load. Replace hardcoded ETH/USD and zero non-ETH prices with a release-safe feed or fail closed.
- `bot`: keeper readiness, dry-run, nonce replacement/restart recovery, custody/authority checks and V4 event/reward compatibility. Do not sign or broadcast.
- `frontend`: locked install, typecheck, production build, API tests, configured production manifest check and browser smoke. Treat missing `VITE_*` addresses, missing `VITE_QUOTER`, empty indexer URL and old V3 fee labels as release failures.
- Dependency audit: report direct versus transitive issues, reachability, and safe locked upgrades. Do not run a blind major-version audit fix.

## Required implementation audit

Verify the executable launch path, not just isolated files:

- New launches actually use V4 at graduation.
- Base fee is 2% on buys and sells for meme and company launches.
- Curve split is 90% Census / 10% creator.
- Post-graduation split is 30% Census / 70% creator.
- Optional holder reflection is 1–4% on top, including disabled mode.
- Creator reward basket supports up to three immutable assets/weights, including launch token and pairing asset.
- Mandatory three-second anti-snipe tax preserves the launch-window decay and caps total charge safely at 99%.
- Pump.fun-style virtual token reserve keeps 1B real supply with no dead surplus.
- Graduation permanently custodies liquidity and returns only explicit rounding dust.
- V4 hook fees are canonical across routers, while external LP bypass is disclosed honestly.
- Holder accounting excludes custody addresses and protects reserved launch-token rewards from conversion/buyback spending.
- Frontend, indexer and keeper agree on V4 pool IDs/events and fee presentation.

## Adversarial and stress pass

Exercise at minimum: both token orderings; 6/18 decimal quote assets; buys/sells through at least two routers; launch-second, +1s, +2s and +3s taxes; partial final fill; slippage/deadline failure; taxed/rebasing/blocked recipient assets; unauthorized callbacks and registration; pre-initialized or manipulated pools; repeated claims/transfers; 500+ mixed swaps across 10 wallets; concurrent indexers; RPC failure; process restart; and external-pool fee bypass disclosure.

## Output required

Return a concise release report with:

1. GO / NO-GO and the exact reason.
2. Tests run, pass/fail/skip counts, pinned fork blocks and relevant command output.
3. Every remaining blocker mapped to owner, file/line, risk and the smallest safe fix.
4. Changes made in the sandbox, with diffs and regression tests.
5. Deployment configuration still required: chain, addresses, multisig/treasury, keeper custody, RPC fallback, indexer, KV/spend alerts, legal/ToS/GDPR and monitoring.
6. A final “do not deploy” list if any P0/P1 remains.

If the implementation is incomplete, stop at a precise NO-GO report. Do not silently downgrade requirements or call the old V3 flow a V4 release.
