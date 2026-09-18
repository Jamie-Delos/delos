# Census Core Repo re-audit — `713fbfb`

**Repository:** `adminofcensus/Census-Core-Repo`  
**Commit reviewed:** `713fbfb7525800a4c7299686ec725cf4cba6193c` on `main`  
**Date:** 18 September 2026  
**Purpose:** independent verification of the changes reported after the 17 September production-readiness audit.

## Outcome

The claimed **code fixes are substantially real**. I found no reversal of the previously verified contract protections, and the important new post-graduation price-impact failure has a proper regression test using real Uniswap V3 components.

The product remains **not ready for public mainnet funds**. The remaining blockers are largely decisions and operations, but some are configuration-dependent technical gates. They cannot be called closed merely because the code has a fallback path.

The updated GitHub Actions [`backend` run](https://github.com/adminofcensus/Census-Core-Repo/actions/runs/35282901440) passed on this exact commit. The contract log reports **98 passing** tests; three fork tests remain pending because no target-chain fork RPC is configured.

## Re-verified as closed in code

| Area | Re-audit result | Evidence |
|---|---|---|
| CREATE2 launch front-running | **Closed.** Both factories bind the salt to `msg.sender`; a watcher cannot reproduce the creator's vanity deployment. | Existing `audit.frontrun` regression test and factory implementation. |
| Manipulable graduated-pool display price | **Closed in code.** Pool display pricing is TWAP-first, graduation grows the oracle observation cardinality, and a direct trade is blocked once spot is more than 10% from TWAP. | `audit.twap` test and `pool.ts` / `Coin.tsx`. |
| Normal shallow-pool swaps reverting from an impact-free quote | **Closed only when QuoterV2 is configured.** `poolQuoteOut` simulates the actual V3 swap via QuoterV2 and `Coin.tsx` derives the minimum output from it. The new test proves the old 2%-below-linear-estimate floor reverts while the 2%-below-Quoter floor fills. | `contracts/test/audit.priceimpact.test.js`; CI passes it. |
| User slippage | **Implemented.** The trade UI offers 0.5%, 2%, 5%, and 10% minimum-output tolerances. | `Coin.tsx`. |
| Legacy `minOut: 0` bots | **Closed for normal operation.** `bot/src/index.js` and `bot/src/buyback.js` stop immediately when `DRY_RUN=false`, before creating a signer or broadcasting. | Direct source review; keeper tests passed in CI. |
| 0x and metadata/upload abuse controls | **Implemented conditionally.** 0x has per-IP limiting and a configured-chain check; metadata writes have per-IP limits; upload adds a global daily-byte cap. | `api.zeroex.test.cjs`, `api.metadata.test.cjs`, `api.upload.test.cjs`, CI green. |
| Wrong-chain Uniswap fallback | **Closed.** Off-mainnet WETH/router values now resolve to zero unless explicitly configured, causing a loud trade failure instead of silently using mainnet addresses. | `frontend/src/config.ts`. |
| Phishing/identity presentation | **Improved.** An unregistered address presents an honest failure state, and launch input removes control/bidi characters and warns on duplicate or company-like names. | `useCoinQuote`, `names.ts`, dedicated tests. |
| Anchor recursion | **Closed.** The recursive pricing function has an explicit `seen` set and returns an unpriceable result for a cycle. | `anchors.ts`. |
| Documentation and stale launch helpers | **Materially improved.** README/runbooks describe the curve system; stale launch scripts now fail fast; verification iterates the deployment manifest. | Current docs and scripts. |

## Conditions that must be treated as open

### 1. QuoterV2 is not active until it is configured and verified

`CONTRACTS.quoter` defaults to the zero address. When `VITE_QUOTER` is absent or the quote reverts, the UI deliberately falls back to the old impact-free estimate and depends on user-selected slippage. The code labels this route `pool (est.)`, which is honest, but it does not make it suitable for a shallow mainnet pool.

**Go/no-go proof:** confirm the Robinhood Chain QuoterV2 address and ABI with a read-only call, set `VITE_QUOTER` in the actual production build, and execute the `0.01`, `0.1`, `0.5`, and `1` ETH presets against a fork/canary. `VITE_QUOTER` should also be documented in `frontend/.env.example` and the mainnet runbook; it is currently not.

### 2. Rate limiting is only a limit when Vercel KV is provisioned

The API controls intentionally fail open if KV is unavailable so that a KV outage cannot stop trading. That means an unprovisioned, misconfigured, or unavailable KV instance leaves `/api/zeroex` unthrottled. The global upload cap is fail-closed, but does not protect the 0x proxy in that state.

**Go/no-go proof:** production KV health checks, exact environment variables, a controlled 429 test through the deployed Vercel endpoint, a Vercel spend alert, and a second RPC. Tighten the 0x handler to require an exact `chainId` match when `CENSUS_CHAIN_ID` is configured; today it rejects a mismatched string but does not explicitly reject a missing/non-string value.

### 3. Deployment safety is still optional in source

`contracts/scripts/deploy.js` still deploys a deployer-owned `FeeVault` whenever `FEE_SPLIT_A` / `FEE_SPLIT_B` are absent, and it only logs a warning when `KEEPER_ADDRESS` is absent. This is the clearest remaining code-adjacent mainnet risk.

**Go/no-go proof:** decide treasury recipients and keeper custody, then make the deploy script reject a mainnet run without an approved immutable FeeSplitter/multisig, keeper, quote allowlist, and verified zap configuration. Archive the signed deployment manifest and have a second operator reproduce the release.

### 4. The indexer remains unsuitable for production display data

The indexer still uses a fixed ETH/USD configuration and assigns every non-WETH anchor a USD price of zero. It still defaults to start block zero and CORS `*`. This is explicitly acknowledged in the gates and must remain disabled from the production frontend until corrected and staged.

### 5. Fairness, legal, and continuity gates remain genuine blockers

- Creator plus up to 32 bundle wallets remain tax-exempt and uncapped during the launch window. This needs a cap, vesting, or launch-level disclosure.
- The actual tax schedule is a sharp decay across three seconds, not a flat 99% for three seconds. Public language must state it accurately.
- External pools can bypass Census curve/canonical-LP fees. Routing and documentation must not promise that every trade funds creators or holders.
- There is no pause/kill switch. Monitoring, alerting, key rotation, a status page, and an incident process are required before value is locked.
- Legal review, Terms, Privacy, risk disclosure, Privy consent/deletion, and an impersonation report/takedown owner are not implementation details; they are release gates.

## CI qualification

The exact commit's CI is green for contracts, indexer, keeper, and metadata/upload API tests. It does **not** run a frontend `vite build` or lint job. The reported clean frontend build is useful developer evidence, but it is not independently enforced by the repository's CI yet. Add it before mainnet.

## Re-audit verdict

Jamie’s statement is accurate if read as: **the identified source-level fixes have been implemented and the remaining list is known.** It is inaccurate if read as a mainnet go-ahead. The release should stay blocked until the activation/configuration gates above have direct production evidence, along with the team fairness, custody, legal, monitoring, and indexer decisions.
