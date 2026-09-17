# Coverage & honesty ledger — tracks A–G

## Files read in full, line by line

| File | Lines | Verdict |
|------|------|---------|
| `CensusCurve.sol` | 656 | Read fully. Curve/graduation/fee maths derived independently; invariants hold; no fund-theft path found. |
| `DividendVault.sol` | 449 | Read fully. Reward-debt + fractional accounting derived and cross-checked against the 700-iteration ledger test; F02 closed. |
| `LaunchLocker.sol` | 196 | Read fully. F03 split verified (curve positions honour `holdersBps`); `protocolFeeBps` invariant checked against deploy. |
| `LaunchToken.sol` | 113 | Read fully. Transfer hook called on every transfer, correct args; `_earned` cannot underflow; anti-snipe dormant in curve flow. |
| `LaunchFactory.sol` | 75 | Read fully. CREATE2 front-run confirmed (CX-F1). |
| `LaunchFactoryV2.sol` | 112 | Read fully. Exclusions {curve, factory, dead, vault} confirmed; same front-run. |
| `DividendVaultDeployer.sol` | 33 | Read fully. Factory-gated; benign. |
| `FeeVault.sol` | 29 | Read fully. Single-owner holder (CX-G2). |
| `FeeSplitter.sol` | 67 | Read fully. Immutable pull-based split; sound. |
| `interfaces/IUniswap.sol` | 117 | Read fully. Standard V3 shapes. |
| `scripts/deploy.js` | 161 | Read fully. `PROTOCOL_FEE_BPS=2500` matches; FeeSplitter/keeper/quote gates identified. |
| `hardhat.config.js` | — | Read. `viaIR`, revertStrings stripped (custom errors preserved), 0.8.24. |

## Tests run

- Full suite: **95 passing, 3 pending** (`npx hardhat test`, 13 s). The 3 pending are the Base/mainnet **fork** tests (skipped — no `BASE_FORK_RPC_URL`).
- New: `test/audit.frontrun.test.js` — **1 passing** (CX-F1 proof).
- Confirmed the graduation suite deploys **real** Uniswap V3 (`@uniswap/v3-core`, `v3-periphery`, `swap-router-contracts` artifacts), so `graduate()`/recovery/callback run against genuine Uniswap bytecode, not mocks.

## Derived by hand (not just trusted from tests)

- Constant-product conservation on buy and sell, and that integer rounding only increases `k`.
- `virtualQuote − realQuote = V0` invariant → the offset formula `X = S·V0²/(G·(G+2V0))` is exactly what makes pool price = curve price at graduation.
- `_maxBuy` cannot overshoot `graduationQuote` (ceil bound proof) → graduation lands at `realQuote == G`.
- Snipe-tax schedule 99 / 8.18 / 2.19 / 2 % from the bit-shift.
- Fee-split legs sum to the fee exactly; cross-coin quote isolation (every out-flow bounded by the coin's own `realQuote`/amount).
- DividendVault fractional-debt: no underflow, no dust erosion, JIT bounded.

## Tracks H–Z coverage (second phase)

| Track | How | Verdict |
|-------|-----|---------|
| L serverless | Read all 3 `frontend/api/*.ts` in full | Hardened; gaps are rate-limits/cost caps (CX-L1–L4) |
| U secrets | PROVEN: `npm run build` + grep `dist/` for secrets/server-env; `.gitignore`, tracked files, git history | Clean (CX-U1 caution only) |
| P content/XSS | PROVEN: grep for `dangerouslySetInnerHTML`/innerHTML; traced image render sites | No stored XSS (CX-P1/P2 residual) |
| N frontend states | Read `Coin.tsx:233-329` + LIVE dev-server tests (bad address, unregistered address, console) | Robust (CX-N1/N2/N3) |
| O wallets | Read `census.tsx:205-317` + `privy.tsx` | Well-built; live mobile/in-app NOT tested (CX-O1) |
| Q/R/S | LIVE: 375px overflow + tap-target JS audit; build chunk sizes | Responsive; a11y + heavy eager bundle (CX-Q1/S1/S2) |
| K chain | Subagent + web research + cross-checked contracts | Orbit L2, single sequencer/RPC (CX-K1–K5; K6 safe) |
| X legal | Subagent, quoted copy | Securities/impersonation/no-ToS (CX-X1–X6) |
| V/W/Z build/ops/docs | Subagent, cross-checked deploy.js/contracts | No kill switch, no monitoring, non-reproducible build, doc drift (CX-W1/W2, V2–V6, Z1–Z4) |
| I/J economics/MEV | My synthesis (DOOM.md) using A–G + K chain facts | 5 doom paths; MEV downgraded by no-mempool chain |
| H integrations + M data-truth | Subagent (still running at write time) | pending — the one track not yet folded in |

LIVE testing: dev server at localhost:5173; landing/board/coin render, **no console errors**, honest
"pending indexer" states, clean bad-address error, 0px horizontal overflow at 375px. Screenshots timed
out in the headless pane (capture issue, not a page bug) — used `get_page_text`/`read_page`/`javascript_tool` instead.

New repro added: `contracts/test/audit.frontrun.test.js` (CX-F1, passing).

## NOT verified in this pass (see NOT-VERIFIED.md)

- Tracks **H–Z**: front end, wallets/Privy, serverless API, indexer, chain-level (Robinhood block time / reorg / sequencer), MEV in practice, performance, availability/cost, secrets-in-bundle, legal, docs/runbooks. **The A1 slippage finding depends on a front-end check I have not yet done.**
- Real Robinhood Chain Uniswap addresses/fee tiers and the HOOD/USDG zap route on mainnet (fork tests skipped).
- Gas profiling of `collectFees`/`distribute` at realistic holder counts (reasoned O(small), not measured).
- A profitability model for CX-E1 (JIT) and CX-B1 (griefing cost) — reasoned, not simulated.
