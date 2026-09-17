# Census — audit fixes, final report. 2026-09-17

Companion to the audit in this folder (README = verdict, FINDINGS = A–G detail, GATES = mainnet go/no-go,
TRACK-* = H–Z detail, DOOM/MONEY-MAP/COVERAGE/NOT-VERIFIED). This page records everything **fixed**,
with proof and commit, and everything that **remains** (and why it can't be closed in code alone).

All work is on `adminofcensus/Census-Core-Repo` `main`, pushed. Commits this session:
`c57156f` → `7d3e5f4` → `a2ffb81` → `93426bf` → `10aeb85` → `b30332a`.

## Verdict (unchanged)

**Contracts are sound — no S0, no path for any privileged role to touch curve principal.** The product
is still **not** mainnet-ready, but everything that blocked mainnet *in code* is now fixed. What's left
is decisions, legal, infrastructure and one mainnet config value — not code I can write alone. An
independent audit by Neil (commit `a2ffb81`) reached the same verdict and the same blocker set, and is
committed alongside this report.

## Fixes landed (with proof)

| ID | Finding | Fix | Proof | Commit |
|----|---------|-----|-------|--------|
| **CX-F1** | Launch front-running — CREATE2 vanity address ignored the creator, so a mempool watcher could hijack a launch | CREATE2 salt bound to the creator (`keccak256(salt, msg.sender)`) in both factories; grinders (`grindSalt.js`, `c0de.ts`) + `Launch.tsx` mirror it | `contracts/test/audit.frontrun.test.js` — attacker can't reproduce the address; victim's launch succeeds | `c57156f` |
| **CX-H1** | Price/mcap/trade min-out from a manipulable `slot0` spot (no TWAP) | `graduate()` grows the pool oracle buffer (`GRAD_OBS_CARDINALITY=30`); display/mcap read a TWAP; a pool trade is blocked when spot deviates >10% from the TWAP | `contracts/test/audit.twap.test.js` — `observe()` serves a TWAP post-graduation | `a2ffb81` |
| **CX-H1 residual** (Neil) | The trade min-out was still derived from an **impact-free** estimate → a normal trade on a shallow pool reverts | Trade estimate/min-out now use **Uniswap QuoterV2** (real, impact-aware; `poolQuoteOut`, gated on `VITE_QUOTER`, falls back to the estimate when unset) + a **user-adjustable Max slippage** | `contracts/test/audit.priceimpact.test.js` — linear-estimate min-out **reverts** on a healthy pool; QuoterV2 min-out **fills** | `b30332a` |
| **CX-L1** | `/api/zeroex` unauthenticated + unthrottled → 0x key exhaustion | Per-IP fixed-window rate limit (KV) + chain cap (rejects foreign `chainId` before spending the key); fail-open without KV | `frontend/api.zeroex.test.cjs` | `93426bf` |
| **CX-L2** | `/api/metadata` POST unthrottled → RPC/function abuse | Per-IP rate limit before the signature-recover + on-chain read | `frontend/api.metadata.test.cjs` (23 checks) | `10aeb85` |
| **CX-L3** | Upload quota per-wallet only → sybil fill of Blob | Global daily byte cap across all wallets (KV `INCRBY`) on top of the per-wallet quota | `frontend/api.upload.test.cjs` (18 checks) | `10aeb85` |
| **CX-N1** | Unregistered address rendered a blank coin *shell* a phishing link could pass off as real | Honest "Not a Census coin" page for a confirmed miss; **distinct** "Couldn't reach the chain" retry for an RPC error (`useCoinQuote` now flags the error instead of conflating it with "not registered") | Live-verified on the dev server | `10aeb85` |
| **CX-G1** (Neil #3) | Legacy `bot/src/index.js` + `buyback.js` swapped with `amountOutMinimum: 0` | Both refuse live execution (dry-run inspection still works) and point to the operator-`minOut` keeper | `DRY_RUN=false` run confirmed refused; `npm test` (keeperd) passes | `b30332a` |
| **CX-H3** | Testnet vs mainnet Uniswap wiring contradicted itself; `config.ts` fell back to **mainnet** WETH/router off-mainnet (silent footgun) | `config.ts` chain-gates `weth`/`swapRouter` (zeroAddress off-mainnet → loud fail); `addresses.js` testnet reconciled with the confirmed JSON; `.env.example` marks the vars required off-mainnet | dev `.env` verified to set the vars (live testnet unaffected); board renders after the change | *(this commit)* |
| **CX-P2** | No name/ticker dedup or impersonation guard; invisible/bidi chars could deceive | Launch wizard strips zero-width/bidi/control chars from the name and shows a non-blocking ⚠ warning on duplicate (existing coin) or impersonation (real company) | `lib.names.test.cjs` (10 checks); live-verified ("Robinhood"→impersonation, "Curve Test"→duplicate, novel→none) | `737c693` |
| **CX-H2** | Company-coin anchor recursion could hang a row on an A↔B cycle (shared promise cache awaits itself) | `anchors.ts` threads a `seen` set that short-circuits a cycle to "—"; depth cap retained | tsc; derived trace (cache would deadlock without it) | *(this commit)* |
| **CX-Q1** | Sub-44px touch targets on the coin page (a11y) | Underline controls switched to text-decoration so they can be 44px tall; `.cx-link-control`/`.cx-quiet` + Buy/Sell toggle sized to ≥44×44 | Live-measured at 375px: **0** sub-44px controls, 0 overflow; desktop screenshot confirms no distortion | *(this commit)* |
| **CX-S1** | Heavy eager bundle (all pages statically imported) | Route-split the inner pages (Coin/Launch/Advanced/Home/Profile/Paper) with `React.lazy` + Suspense + a chunk-error boundary; Landing stays eager | Build shows separate chunks (Coin 27KB, Launch 55KB…); every route verified to load live | *(this commit)* |
| **CX-Z1/Z3/Z4** | README described the superseded design; runbooks failed if followed literally; TODO stale | README rewritten to the curve system; runbooks fixed (paths, 5-arg CensusCurve verify, repointed off stale scripts, false 2% claim removed); TODO retitled + addresses marked superseded | Claims verified against the contracts | *(this commit)* |
| **CX-V6 / CX-V1** | `verifyAll.js` skipped most contracts; `launch.js`/`launchV2.js` used the dead pre-curve ABI | `verifyAll.js` iterates every `deployments.verify` entry; the stale launch scripts fail-fast with a pointer to `demoLaunch.js`/the frontend | `node --check` on all three; `verifyAll.js` reviewed | *(this commit)* |

## Neil's independent cross-audit — how it changed this pass

Neil reviewed commit `a2ffb81` (which already had my CX-F1 + CX-H1 fixes; he confirmed both present and
tested). His findings mapped 1:1 onto this audit's gates — strong cross-validation. He surfaced **two**
things this pass had missed or under-weighted; **both are now closed or folded in**:

1. **CX-H1 price-impact residual — I own this.** My TWAP fix changed the price *source* but left
   `poolSpotOut` estimating output *linearly* (ignoring price impact), so the min-out was still too
   tight and a normal trade on a shallow pool would revert. Now fixed with QuoterV2 + user slippage,
   proven by a test that reproduces the exact revert and the fix.
2. **CX-E3 external-liquidity fee leakage — genuinely new, I missed it.** Launch tokens are freely
   transferable, so after graduation external pools/aggregators can bypass the canonical pool; those
   trades pay **neither** the curve fee nor the locked LP's fee. "Every trade funds creator/holder
   rewards" is therefore false. Folded into FINDINGS (CX-E3), GATES (G21), and the README S1 list — it
   is a disclosure + routing **product decision**, not a patchable bug (short of a non-transferable token).

## Verification (this session)

- **Contracts:** `npx hardhat test` → **98 passing, 3 pending** (the 3 are fork tests needing `BASE_FORK_RPC_URL`). Includes 3 new adversarial repros (`audit.frontrun`, `audit.twap`, `audit.priceimpact`), all against **real** Uniswap V3.
- **APIs:** `api.zeroex` / `api.metadata` (23) / `api.upload` (18) test suites pass; the new L2/L3 paths are genuinely exercised (mocks updated to implement `INCR`/`INCRBY`).
- **Bot:** `npm test` (keeperd/backend readiness) passes; the `index.js`/`buyback.js` live guards confirmed to refuse `DRY_RUN=false`.
- **Frontend:** `tsc --noEmit` clean; `vite build` clean.

## What remains before mainnet — none of it is code I can write alone

Grouped by who owns it. Full detail + proof-of-closure in `GATES.md`.

**Decisions (team):**
- **CX-C1** — creator + 32-wallet bundle are tax-exempt and uncapped: cap, vest, or disclose. *The single biggest fairness/reputation call.*
- **CX-Z2** — sign off one fee number; reconcile the docs (code says 2%, docs say 1%/pending).

**Legal (counsel):**
- **CX-X1** — securities-shaped pitch ("dividend in real stocks", "companies public on-chain").
- **CX-X3/X4** — no Terms/Privacy/risk disclosure; Privy PII with no consent/deletion (GDPR).
- **CX-E3** — external-liquidity disclosure: describe/route the canonical pool, never promise every trade funds rewards.

**Infrastructure / ops (Coolio/Jamie):**
- **CX-W1/W2** — there is **no kill switch** in any contract; add reserve/solvency/keeper/RPC/API-spend monitoring, a status page, and a written incident + key-rotation runbook.
- **CX-M1/M2** — deploy the indexer and fix its placeholder USD ($3000 ETH / $0 anchors) *before* setting `VITE_INDEXER_URL`.
- **CX-K2 / G9** — a second RPC provider (single RPC = single point of failure) and a Vercel **spend alert** (the backstop behind the per-IP/-wallet limits against rotation).
- **CX-V2/V3** — reproducible build (commit prod config / `deployments.json`) and make CI run `vite build` + lint, not just `tsc`.

**Mainnet config / deploy (Jamie):**
- **G1/G2** — treasury = FeeSplitter/multisig (fail the deploy otherwise); keeper key in HSM/multisig.
- **G12/G13** — verify the real Robinhood Chain Uniswap addresses/tiers + the HOOD zap route, and **set `VITE_QUOTER`** to the verified Robinhood Chain QuoterV2 so the impact-aware trade path activates (until then it falls back to the estimate + user slippage).

**Should-fix — now DONE (see table above):** CX-Z1/Z3/Z4/V1/V6 (docs/runbooks/scripts), CX-H2 (anchor cycle guard), CX-Q1 (44px tap targets), CX-S1 (route code-splitting), CX-H3, CX-P2. **CX-S2** was already handled in code (`VITE_FROM_BLOCK` + 30s cache + indexer support); only config/infra remains (set the deploy block, ship the indexer) — now documented in `.env.example`.

**Still open (deliberately not forced — belong to the team):** an external smart-contract audit + fuzz/invariant campaign before meaningful TVL; CX-P2's report/takedown path with a named recipient (product/ops); CX-Q2 (jargon tooltips) and the "quote asset impaired" copy (CX-H2) — minor UX polish; a client swap deadline (CX-H5); measured gzipped TTI (CX-S1 follow-up).

## Honest caveats on the fixes

- The QuoterV2 price-impact fix is **wired and proven** but only **active on mainnet once `VITE_QUOTER` is set** to the verified Robinhood Chain QuoterV2 address (I would not fabricate an address — the Base addresses in `addresses.js` are not Robinhood Chain). Until then the pool path falls back to the impact-free estimate, mitigated by the user-set slippage.
- The API rate limits are **per-IP / per-wallet** — they stop trivial single-source abuse and cap cost, not a determined attacker rotating IPs/wallets. The global **spend alert** (G9) is the real backstop and is an account action, not code.
- The TWAP windows (120/30s) and the 10% deviation guard are first-pass values to **tune on the canary** once real pool depth exists.
