# Backend handoff — branch `BACKEND-NEIL` (2026-09-16)

For: Jamie (JJ-ME55). From: Neil's backend repair pass.

This branch contains two repair passes on top of main `c000052`: the 2026-09-15 audit-driven fixes and the 2026-09-16 pass (this one). **Nothing here is deployed and no deployed contract inherits these fixes.** Current release decision: **NO GO for unrestricted mainnet funds** until the checklist below is worked through — what remains is mostly decisions, external validation and ops rehearsal, not known unfixed fund-safety defects.

Read in this order:

1. This file — what to do next.
2. [REPAIR-STATUS.md](REPAIR-STATUS.md) — authoritative fixed/open/tested record (2026-09-16 section on top).
3. [BACKEND-READINESS.md](BACKEND-READINESS.md) — original audit findings (B01–B22); many now repaired.

## What this branch delivers (all regression-tested)

| Area | Change |
| --- | --- |
| Contracts | Graduation recovery from adversarially pre-initialized pools (bounded price-restoring swap, fail-closed); reward-reserve accounting; graduation fee splits honoring `holdersBps`; taxed-deposit rejection; launch-token LP fee conversion (`DividendVault.convertLaunchFees`); push payouts (`claimFor`); deployer-managed quote-collateral allowlist; **meme pairing** — launches quoted in a *graduated* company coin (`isPairableCompanyCoin`), meme-on-meme blocked. |
| Keeper | `bot/src/keeperd.js` production daemon: log-based discovery, collect → convert → distribute → push pipeline, durable atomic state file, one managed in-flight tx with nonce/stuck-replacement recovery under a fee cap, signer balance floor, webhook alerts, DRY_RUN default. |
| Indexer | Transactional exactly-once ingestion (serializable + advisory lock), finalized-only reads, canonical-hash checks; **post-graduation coverage**: pool swaps (venue=pool trades, spot price from the pool) and a RewardEvent ledger (`/coins/:address/rewards`); meme pairs flagged (`quoteIsCoin`); committed migrations validated on real PostgreSQL. |
| API | Input validation, real health/liveness split, rate limiting, bounded WebSocket buffers, venue-tagged trades, rewards route. |
| Frontend backend handlers | `api/metadata.ts` writes now require an EIP-191 signature from the coin's on-chain creator (RPC-verified), chain-scoped keys, atomic writes. Wizard signs with the connected wallet. |
| Team decisions implemented | Auto-distributed rewards (claimFor + keeperd). Fee model unchanged and final: 2% curve fee, 25% platform, 75% creator side split by `holdersBps`. No MarketGuard / permissioned-token redesign. |

Test evidence: contracts **56 passing / 3 pending** (`npx hardhat test`); mainnet-fork lifecycle passing (read-only fork, block 64,510,174); real-PostgreSQL harness passing incl. two concurrent workers, hard-kill WAL recovery and restore (`indexer: npm run test:pg`); keeper harness (`bot: npm test`); metadata auth harness (`frontend/api.metadata.test.cjs`).

## What you (Jamie) need to do

### 1. Decisions (blockers — nothing ships without these)

- **Graduation price discontinuity (B15).** The pool still opens ~23% below the curve exit price with tested settings (virtual reserve drops out at migration). Options: (a) accept + disclose it as designed behavior, or (b) redesign to a continuous migration (migrate at the curve exit price and burn/retain the virtual-side tokens — a tokenomics change). Pick one explicitly; it is currently the biggest open economics item.
- **Launch fee.** Your note suggested "take launch + curve fees too". There is currently no launch-creation fee. Decide if you want one (flat, in quote asset); it's a small factory change once decided.
- **Meme-pair policy.** Pairing is enabled for graduated company coins automatically. Confirm you want it automatic vs. per-coin opt-in, and confirm meme launches should be allowed as Prima only or also Maxima (currently both work; a Maxima meme's vault is quoted in the company coin).
- Prima/Maxima renaming — open, non-blocking.

### 2. Review (independent eyes on the new code)

Focus the contract review on what changed this pass:

- `CensusCurve.sol`: `_restoreMigrationPrice` + `uniswapV3SwapCallback` (recovery swap; check the bound, the exact-price-limit logic, callback authorization), `_migrationMinima`, `allowedQuote`/`isPairableCompanyCoin` gates.
- `DividendVault.sol`: `convertLaunchFees`, `_sell` (shared measured-swap helper), `claimFor`/`_claim`.
- `LaunchLocker.sol` fee routing (unchanged this pass but part of the money path).
- `bot/src/keeperd.js` transaction management (`sendManaged`/`resolvePending`).
- Note: `LaunchFactoryV2` deployed size is **24,413 of 24,576 bytes (EIP-170)** — ~160 bytes headroom. Any DividendVault/factory change must re-check size (the suite's parity/size test covers it).
- Revert strings are stripped globally (hardhat config) to stay under EIP-170 — tests assert `.to.be.reverted`, and on-chain failures decode via custom errors only.

### 3. External validation (cannot be done from local tests)

- Executable **0x routes** for every supported stock, both directions, real slippage behavior; keeper `probe` command helps (`node src/keeper0x.js probe`).
- **Issuer behavior** of the actual stock tokens: pause/blacklist/trading windows/corporate actions; legal eligibility per jurisdiction.
- **Price feeds**: the indexer still uses a static configured ETH/USD and reports 0 USD for other quotes. Decide the production feed and wire it.
- Dedicated RPC providers (public RPCs are rate-limited and unsuitable for production).

### 4. Ops rehearsal (isolated infra, before any funds)

- Managed PostgreSQL: run the committed migrations, then rehearse **pg_dump/pg_restore on the production toolchain** (the local harness's restore is SQL-level; the embedded binaries ship without pg_dump).
- Real network load: the harness load is in-process; run HTTP/WebSocket load through the actual ingress.
- **Keeper live rehearsal on testnet/fork**: funded capped signer, real 0x/quoter, alerts wired (`ALERT_WEBHOOK_URL`), then observe replacement/recovery behavior. All keeperd knobs are documented in `bot/.env.example`.
- `frontend/api/upload.ts` is still **unauthenticated** — add quota/auth before public exposure (metadata.ts is done and is the pattern to follow).
- Metadata env for the serverless functions: `CENSUS_RPC_URL`, `CENSUS_CURVE_ADDRESS`, `CENSUS_CHAIN_ID` (fails closed when unset), plus the existing KV vars.

### 5. Deployment & custody (B21)

- Build a verified release manifest: chain id, code hashes, constructor args, fee configuration, treasury/operator addresses, ABI hashes; fail closed on mismatch.
- Decide treasury/operator custody (multisig/hardware, rotation, incident plan). The curve deployer address controls factory and quote allowlists — treat it as production custody.
- **Confirm whether any existing deployment holds real funds** — still unverified. Do this before any migration or announcement.
- New deployments must include the new operational steps: `setQuoteAllowed` for each approved collateral (WETH is auto-enabled), `setZapPath` for non-ETH quotes (including graduated company coins you want ETH-zap buys for).

### 6. Go/no-go

Joint evidence-based review at the end. A calendar date or passing happy-path tests must not override open fund-safety items.

## How to run everything

```powershell
# contracts (from contracts/)
npx hardhat test --network hardhat                      # full local suite: 56 passing
$env:AUDIT_MAINNET_FORK='1'; npx hardhat test --network hardhat test/backend.mainnet-fork.test.js

# indexer (from indexer/)
npm run test        # in-memory fault-injection harness
npm run test:pg     # REAL PostgreSQL: migrations, exactly-once, 2 workers, crash/WAL recovery, restore, load

# bot (from bot/)
npm test            # keeper planners + keeperd daemon harness
node src/keeperd.js # dry-run cycle (signs nothing)

# frontend metadata auth (from frontend/)
npx esbuild api/metadata.ts --bundle --platform=node --format=cjs --outfile=.test-build/metadata.cjs --external:viem
node api.metadata.test.cjs
```

No Docker needed anywhere; the real-Postgres harness uses the `embedded-postgres` dev dependency (Windows/macOS/Linux binaries via npm).

## Frontend backlog (out of scope for this backend pass)

- Gold-highlight pairable company coins in the launch wizard's quote picker (`quoteIsCoin` + `isPairableCompanyCoin` are ready server/chain-side).
- Rewards tab per coin from `/coins/:address/rewards`; venue badge on trades.
