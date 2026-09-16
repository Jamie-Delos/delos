# Census repository audit — 11 September 2026

Reviewed `JJ-ME55/Census`, branch `main`, commit `c000052712ea739fde3e8b050769344b9def697b`.

**Assessment: not ready for production funds.** The basic launch/trade lifecycle runs, but local reproductions demonstrate reserve loss at graduation, insolvent dividend accounting, incorrect post-graduation fee allocation, and a broken frontend-to-fresh-deployment bytecode boundary. Passing happy-path tests currently conceal these problems.

This is an initial source and local-execution audit. It does not establish whether deployed contracts match this revision or whether any live deployment has been exploited. No transactions were sent to a public chain, no deployments or account defaults were changed, and no production source files were modified. The added files are this report, audit reproductions, and dependency scan outputs; nothing was committed or pushed.

## What the system currently does

| Component | Responsibility |
| --- | --- |
| `contracts/contracts/LaunchFactory.sol` | Prima launches: fixed-supply token, optional CREATE2 vanity address, all initial supply assigned to CensusCurve. |
| `contracts/contracts/LaunchFactoryV2.sol` | Maxima launches: adds a per-coin DividendVault and a configurable holder share of creator-side fees. |
| `contracts/contracts/CensusCurve.sol` | Shared constant-product trading with virtual quote reserves; 2% trade fee split 25% platform / 75% creator side; ETH wrapping/zaps; permissionless graduation into Uniswap V3. |
| `LaunchToken.sol` / `DividendVault.sol` | Temporary buy restrictions and transfer-hook dividend accounting; operator-controlled basket conversion and holder claims. |
| `LaunchLocker.sol` / treasury contracts | Permanent custody of graduated LP NFTs; LP-fee collection; protocol treasury or immutable two-party splitter. |
| `frontend/` | React/Vite/wagmi app: launch wizard, discovery, coin trading, wallet connection. Vercel functions handle metadata, images, and 0x API access. |
| `indexer/` | Curve event ingestion, denormalized Postgres records through Prisma, Fastify REST/WebSocket API. |
| `bot/` | Dividend keeper plus older creator-reward and protocol-buyback scripts. |

The current implementation has a bonding curve and migration. The root README still describes the former direct-to-Uniswap design and should not be used as the system specification. The current pre-graduation fee split also differs from several historical descriptions in TODO.md.

## Priority findings

P1 means fix before exposing the affected path to production funds or depending on it operationally. P2 means a concrete correctness/security issue that also needs resolution, with a narrower trigger or impact. These are remediation priorities rather than formal CVSS ratings.

### F01 — P1: preinitialized pools can divert graduation reserves to the creator

**Location:** `contracts/contracts/CensusCurve.sol:301–335`.

`createAndInitializePoolIfNecessary` accepts an existing initialized pool without enforcing the intended price. The subsequent mint has both minimum amounts set to zero. Any quote not consumed by the mint is sent to the creator as an alleged rounding leftover.

An actor can initialize an empty pool at a manipulated price before graduation without owning the coin or supplying LP capital. In the local reproduction using real Uniswap V3 contracts, a coin with **4.9 WETH** in raised reserves graduated and refunded **4.899765625000000012 WETH** to its creator. A malicious creator can arrange this themselves. Permanent NFT locking does not protect reserves that never enter the position.

**Fix direction:** validate the existing pool state and enforce price and token-utilization bounds; protect graduation against front-running and preserve a recoverable state on rejection. Do not treat arbitrary mint remainders as creator revenue. Merely rejecting every preexisting pool would allow permanent graduation griefing, so define a recovery strategy too.

**Evidence:** executable reproduction in `contracts/test/audit.repro.test.js`.

### F02 — P1: quote-as-dividend accounting credits the same funds repeatedly

**Location:** `contracts/contracts/DividendVault.sol:188–224`, and available-balance handling at `:255`.

`distribute()` treats the full quote balance as new fees. When a basket member equals `quote`, it credits a dividend without moving those tokens out of the vault. A later distribution includes the already-owed funds again; in a mixed basket it can also swap those reserved funds away. The balance cap in `claim()` masks insolvency rather than preventing it.

Reproduction: two equal holders, one deposit of 10 quote tokens, two distributions, no new deposit. Each holder is recorded as owed 10. The first claims all 10 and the second receives zero, retaining an unfunded entitlement.

**Fix direction:** separately track undistributed quote fees and reserved dividend liabilities. Both distribution engines must spend only unreserved funds. Test repeated distributions, mixed quote/stock baskets, partial claims, and transfers between distributions.

**Evidence:** executable reproduction with the real LaunchToken transfer hook.

### F03 — P1: Maxima graduation discards the configured holder/platform split

**Location:** `contracts/contracts/CensusCurve.sol:321–322`; `contracts/contracts/LaunchLocker.sol:120–140`.

Before graduation, holders receive the configured fraction of the creator's 75% share. At graduation the vault becomes the locker's *protocol-share recipient*. The locker then pays 75% to the creator, 25% to the vault, and nothing to the platform, regardless of `holdersBps`.

For a Maxima launch with `holdersBps=10000`, the local post-graduation swap produced **0.0075 WETH for the creator, 0 for the platform, and approximately 0.0025 for holders**. The intended split of that LP fee, if preserving the configured shares, is 0 creator / 0.0025 platform / 0.0075 holders.

**Fix direction:** persist the three-way split in the graduated position and route platform and holder shares separately. Define what happens to fees collected in the launched token as well as the quote; the vault currently only converts quote balances.

**Evidence:** executable reproduction, including real post-graduation swap and fee collection.

### F04 — P1: committed frontend bytecode does not match a fresh contract build

**Location:** `frontend/src/lib/launchTokenBytecode.ts`; `frontend/src/lib/c0de.ts:12–18`; factory vanity-address enforcement.

The frontend hashes embedded creation bytecode to grind CREATE2 salts. With the committed lockfile and Hardhat settings, compiled LaunchToken creation bytecode is **4,861 bytes**, while the committed frontend copy is **4,907 bytes**. They differ in executable bytecode, not just metadata.

A salt that predicts a `...c0de` address in the frontend generally produces a different, noncompliant address in a factory freshly built from this revision. The reproduction grinds using the frontend bytes and confirms the fresh factory rejects that launch. Existing deployed factories were not checked; compatibility with those remains unknown.

**Fix direction:** generate the embedded artifact from the exact deployment build and enforce equality in CI. Associate frontend configuration with a deployment manifest and compiler/artifact hashes.

### F05 — P1: trading UI can submit swaps with no slippage floor

**Location:** `frontend/src/pages/Coin.tsx:128–129,199`.

The pool fallback explicitly uses `amountOutMinimum: 0n`, including the direct path for non-WETH quotes. Curve trades also use zero if an indicative quote has not loaded or has failed. A 2% slippage label is displayed even in those cases. Old quote state can also remain visible while an input/side change is waiting on the debounce.

**Impact:** the transaction can execute at a much worse price than the displayed tolerance, including through adversarial ordering.

**Fix direction:** obtain a fresh quote for the exact side, token, amount, chain, and route at submission; require a nonzero minimum and suitable validity bound, or refuse submission. Clear stale quote state. Use the coin's recorded fee tier for pool fallback instead of the global default. The older reward/buyback scripts also submit zero-minimum swaps (`bot/src/index.js`, `bot/src/buyback.js:59`).

### F06 — P1: failed RPC reads or handlers permanently skip indexed data

**Location:** `indexer/src/ingest.ts:185–196`.

Both `getLogs` failures and individual handler exceptions are caught and logged, then the page cursor is committed anyway. The range-shrinking branch is empty. A transient outage can therefore lose launches/trades permanently and corrupt subsequent reserve reconstruction.

**Fix direction:** retry/back off without cursor advancement; split oversized ranges; make successful processing and cursor movement atomic at a defined boundary. Expose ingestion lag/failure through health reporting.

**Evidence:** actual `scan()` executed with a throwing RPC adapter still commits cursor 5 for failed blocks 1–5.

### F07 — P1: event replay is not idempotent

**Location:** `indexer/src/ingest.ts:129–150,207`.

The unique trade row is upserted with an empty update, but reserves, volume, count, and price points are updated regardless of whether the trade was new. Startup scans from the saved cursor inclusively, so a last indexed block containing a trade can trigger this on a normal restart. A crash within a page presents the same problem.

**Fix direction:** atomically deduplicate the event and apply its effects, with an event identity that supports reorg handling. Resume from the first unprocessed block after completing a page; do not rely on that alone for crash safety.

**Evidence:** replaying one actual handler twice produces one unique trade, `tradeCount=2`, two price points, and reserve 196 instead of 98.

### F08 — P2: graduation introduces an unintended price drop

**Location:** `contracts/contracts/CensusCurve.sol:288–302`.

The curve's marginal price is `virtualQuote/tokenReserve`, but graduation initializes the pool using `realQuote/tokenReserve`. These differ by the original virtual reserve. In the reproduction, 5 WETH gross buys leave 4.9 real / 6.4 virtual WETH, so the pool opens at **76.5625% of the curve exit price**, a **23.4375% drop** before any post-graduation trade.

**Fix direction:** choose migration liquidity geometry and backing that preserve the intended price, or explicitly redesign the economic promise. Full-range liquidity using both complete real reserves cannot simply emulate a nonexistent virtual asset.

**Evidence:** reads the initialized real Uniswap pool's `slot0` and compares its price with the final curve state.

### F09 — P2: anyone can occupy a token's metadata record

**Location:** `frontend/api/metadata.ts:32–47`.

POST validates address syntax but does not prove that the caller owns the token's creator wallet. Anyone can write a token record first, including for a predicted address before launch, after which the legitimate creator is refused. The separate GET and SET also do not make first-write-wins atomic under concurrent requests. The key has no chain namespace.

**Fix direction:** require a signed, chain-bound payload, verify its signer against the launch creator, and perform an atomic conditional write. Define an authenticated correction/moderation workflow.

### F10 — P1: production indexer deployment has no committed migrations

**Location:** `indexer/Dockerfile:14`; `indexer/prisma/`.

The container runs `prisma migrate deploy`, but the repository contains only `schema.prisma`, with no migration SQL/history. That command cannot provision the application tables on a fresh database from this checkout. TypeScript compilation and Prisma client generation do not create tables.

**Fix direction:** commit and test an initial migration against an empty disposable Postgres database. Copy the lockfile before dependency installation and use `npm ci` in the Dockerfile. This is a static deployment finding; a Postgres/container integration run was not performed.

### F11 — P2: documented launch/verification tools still target the old contracts

**Location:** `contracts/scripts/launch.js:69–80`; `launchV2.js:34–36`; `test/integration.fork.test.js:47`; `scripts/verifyAll.js:42–44`.

Launch scripts pass the former `fee/sqrtPriceX96/ticks` structure rather than the required `poolFee/virtualQuote/graduationQuote` fields. The fork test constructs LaunchFactory with its old three-argument constructor, so its skipped status is not evidence of current-stack compatibility. The verification script omits CensusCurve, LaunchFactoryV2, and FeeSplitter. The mainnet runbook's manual CensusCurve verification command also omits WETH.

**Fix direction:** update or explicitly retire legacy entrypoints, exercise the documented commands against a fresh local stack, and generate verification calls from the deployment manifest.

### F12 — P2: mined reverts can be shown as successful trades

**Location:** `frontend/src/pages/Coin.tsx:135–136,185–186,203–204`.

The code awaits the viem public client's transaction receipt, discards it, and displays success. The installed viem public action returns receipts whose status may be `reverted`; it is not the wagmi wrapper that explicitly throws for that status. A transaction that reverts after submission can therefore be labeled bought/sold.

**Fix direction:** check receipt status for every approval/wrap/trade and only advance on success. Test a mined revert caused by a price/state change after submission.

### F13 — P1 if enabled: legacy bots can spend unrelated balances and send rewards to inaccessible holders

**Location:** `bot/src/buyback.js:50–59`; `bot/src/lib.js:17–38`.

The buyback script withdraws treasury WETH and then spends the signer's *entire* WETH balance, including any preexisting personal/operational funds. Holder discovery includes every positive balance, including the curve, pool, dead address, and other protocol custody addresses. Reward airdrops to those addresses may be permanently inaccessible. These scripts default to dry-run; the risks apply when operators enable live execution.

**Fix direction:** use the measured withdrawal delta and explicit spend limits; exclude nonclaiming protocol/burn addresses using a documented snapshot policy. Add durable progress tracking for interrupted airdrops before relying on them operationally.

## Additional gaps to address

- **Indexer completeness:** it reads only CensusCurve events, so graduated-pool trades no longer update its prices/volume. It lacks block-hash/reorg reconciliation. Chart queries select the earliest N samples, which stops providing recent history after the limit is reached. `createdAt` records ingestion time rather than the launch block time.
- **Frontend state:** `useCoinQuote` does not reset all state when the address changes and does not refresh on new blocks or successful trades. Graduation targets and several amounts are displayed using global assumptions despite per-coin parameters. Indexer failures can silently retain the mock catalogue. Claims, history, holders, and creator-fee collection are partly placeholders, rather than a completed holder lifecycle.
- **Reserved addresses:** `Launch.tsx` retains the previous `reserved` value while grinding changed name/ticker/tier inputs. Navigating away can cancel the new grind while `lastGrind` suppresses its restart. Bind reservations to all hashed inputs and clear invalidated state.
- **API abuse controls:** image uploads have a per-file size limit but no authentication, rate limit, or quota in repository code; repeated requests can consume paid storage. The 0x proxy also needs service-level abuse controls. No claim is made about protections configured outside this repository.
- **Trust assumptions:** the vault operator chooses slippage bounds and supplies 0x calldata. Pinning an allowance target does not independently guarantee an honest economic exchange when the operator can choose a zero minimum. Clarify operator trust and test malicious calldata/recipient behavior rather than claiming it can only cause reverts.
- **Quote/basket configuration:** permissionless factories accept arbitrary quote assets, fee tiers, and basket routes without validating standard token behavior, route endpoints, uniqueness, or graduation feasibility. Define supported configurations explicitly and test unsupported-token rejection.
- **Operations:** no committed CI workflow was found. The README, TODO, comments, and runbooks need consolidation around the current model. Permanent LP locking is implemented, but the outstanding findings show why it cannot alone establish fund safety.

## Verification performed

| Check | Result |
| --- | --- |
| Locked dependency installation in all four packages | Passed (`npm ci --ignore-scripts --no-audit --no-fund`). Prisma generation was then run explicitly. |
| Solidity compilation | 31 files compiled with committed settings, Solidity 0.8.24. |
| Original contract tests | 20 passed; 2 Base-fork tests skipped because no fork was configured. |
| Added contract reproductions | 5 passed **by asserting the current defective behavior**, not by proving safety. |
| Added indexer reproductions | Both cursor-loss and replay-corruption assertions reproduced against actual handlers with in-memory adapters. |
| Existing `devnetCurve.js` and `devnetCurveV2.js` | Both completed using local real Uniswap V3 contracts. Their existing assertions do not reject the issues above. |
| Frontend production build | Passed; main JS chunk about 606 kB minified / 186 kB gzip; bundle-size warning. |
| Indexer generation/build | Prisma client generation and TypeScript build passed. No live database verification. |
| Bot JavaScript syntax | All five source files passed `node --check`. No live bots ran. |
| Runtime contract sizes | CensusCurve 10,627 bytes; LaunchFactoryV2 22,158; DividendVault 8,519. These builds are below the 24,576-byte runtime limit. |
| Embedded token bytecode comparison | Failed, as described in F04. |

Production dependency scan (`npm audit --omit=dev`, 11 September 2026):

| Package | High | Moderate | Total flagged package entries |
| --- | ---: | ---: | ---: |
| frontend | 4 | 27 | 31 |
| indexer | 2 | 0 | 2 |
| contracts | 0 | 0 | 0 |
| bot | 0 | 0 | 0 |

Raw results are saved as `audit-dependencies.json` in each package. These are dependency-tree flags, not counts of confirmed exploitable application defects. The frontend flags include transitive axios, socket.io-parser, undici, and ws; the indexer flags include Fastify and find-my-way. Trace runtime reachability and plan compatible upgrades; do not apply forced major-version upgrades blindly. Development dependencies were excluded from this scan.

## Reproduce locally

From `contracts/`, after installing dependencies and compiling:

```sh
npx hardhat test --no-compile test/audit.repro.test.js
npx hardhat run --no-compile scripts/devnetCurve.js
npx hardhat run --no-compile scripts/devnetCurveV2.js
```

From `indexer/`:

```sh
node audit.repro.cjs
```

The contract reproduction file uses an in-process chain and tests both real contract behavior and real Uniswap migration. The indexer harness transpiles the actual ingestion module and replaces only its RPC/database adapters. Neither requires real funds, keys, or an external service.

## Suggested remediation order

1. Resolve reserve protection, dividend liabilities, and the post-graduation fee model; turn the reproductions into safety regression tests.
2. Align generated bytecode, factory ABIs, launch scripts, and deployment manifests; add a fresh-build launch test using the frontend's actual salt generator.
3. Enforce trade quotes/receipt status and authenticate metadata writes.
4. Make indexing atomic, replay-safe, reorg-aware, and deployable from an empty database; ingest graduated-pool activity.
5. Retire or harden old bot paths, update dependencies with reachability review, and add CI plus a complete launch → trade → graduate → distribute → claim rehearsal.

Before deciding what must be redeployed, compare the actual deployed bytecode/configuration with this reviewed revision. This audit did not verify live deployments, perform browser/wallet end-to-end testing, exhaustively scan historical secrets, fuzz economic invariants, or conduct a separate specialist smart-contract audit.
