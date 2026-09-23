# Security checklist — V4 launch stack (2026-09-23, launch day)

Scope: `contracts/contracts/v4/*` (CensusCurveV4, CensusFeeMath, CensusV4Hook, CensusV4Graduator, CensusV4Router, CensusRewardVault + deployers, CensusStateView), `LaunchFactoryV4.sol`, `LaunchToken.sol`, `scripts/deployV4.js`. Read-only review of the working tree on `codex/v4-fee-migration` (HEAD 2ca17a0 plus uncommitted changes) against the six-section checklist Neil supplied, with each item verified against the code (file:line) and, where one exists, an automated test. Three independent read-only reviewers covered (a) hook/graduator/router, (b) curve/fee math/vault/token, (c) factory/privilege map/deploy guard/test coverage; the two substantive findings below were re-verified by hand.

Evidence run: `npm run test:v4` (lifecycle, isolation, fees, readiness, adversarial) — **23 passing, 1 pending** (the local-fork test, needs a live RPC), exit 0. Log: scratchpad `test-v4.log`.

## Verdict

| Area | Verdict |
|---|---|
| Curve, hook, graduator, router custody (user funds, reserves, graduated liquidity) | **GO** — no exploitable path found by any reviewer; every privileged lever is one-shot or new-launch-only; no pause, proxy, delegatecall or admin withdraw |
| Reward vault distribution (Maxima launches with a stock basket) | **FIXED same day → GO** — F1 closed: distribution is now keeper-only, the creator is never an operator and no delegation path exists (see F1 status). Residual trust is the Census keeper, which already held it |
| Deployer-only ETH zap route (`setZapPath`) | **Fix before deploy, or accept as key-custody risk** (F2) |
| Verification pipeline | Hardhat unit/adversarial tests only; no fuzzing, no static analysis, four coverage gaps (section 6) |

There is no `deployments.v4.robinhood.json` in the repo, so mainnet has not been deployed from this tree yet. F1 and F2 are both contract changes that can still go in before the first mainnet deploy.

## Findings

### F1 — Vault operator can extract undistributed reflections (Medium; affects Maxima launches with a stock in the basket)

**Status: FIXED 2026-09-23 (same tree, before mainnet deploy).** `CensusRewardVault` no longer has an `operator` storage slot or `setOperator`; `_checkOperator` accepts only `CensusCurveV4.keeper()`, and `operator()` is now a view returning that keeper so the bot's existing ABI keeps working. `init` and `CensusRewardVaultDeployer.create` drop the operator argument; `LaunchFactoryV4._createVault` no longer passes the creator. Test added in `test/v4.lifecycle.test.js` (creator `distribute` and `distributeVia0x` revert `NotOperator`, `operator() == keeper`, no `setOperator` fragment). `npm run test:v4`: 23 passing, 1 pending. Follow-up still open: an on-chain `minOut` floor so a compromised keeper key is also bounded.

- Operator = launch creator by default (`LaunchFactoryV4.sol:126` passes `msg.sender`; vault `init`), or the curve `keeper` (`CensusRewardVault.sol:138-142`). Operator is transferable (`setOperator`, L132-136).
- `distribute(minOut[])` (L205-227): `minOut` is caller-supplied, only `minOut != 0` is enforced (L218). With `minOut = 1` the operator can sandwich the vault's own swap on the fixed V3 route with their own two transactions and take the difference.
- `distributeVia0x(sellAmounts, swapData, minOut)` (L245-278): after `forceApprove(allowanceHolder, sellAmt)` (L267) it calls the 0x AllowanceHolder with **arbitrary caller calldata** (L268). AllowanceHolder.exec lets the caller name the `operator` and `target`, so a creator-controlled contract can pull `sellAmt` of quote from the vault and hand back 1 wei of the stock. Post-checks are only `spent == sellAmt` (L271) and `got >= minOut` (L273). `ALLOWANCE_HOLDER` is hard-coded to the canonical singleton (`scripts/deployV4.js:18`); if it has no code on Robinhood Chain the call succeeds as an EOA call and `Unspent` reverts, so the route is dead but fail-safe. Nobody checks which it is.
- Bounded to `availableQuote()` — reflections collected since the last distribution. Already-credited holder balances (`reserved`) cannot be touched: no withdraw/rescue function exists (PASS on that half). Quote-only baskets do no swap and are not exposed.
- Why it matters: the reflection is marketed as "holders earn". A creator can launch with a 4% reflection, then drain each distribution.
- Recommended fix (smallest): make distribution keeper-only — drop the creator from `_checkOperator` (or initialise `operator` to the keeper and remove `setOperator`). Census then bears the trust, which it already does as keeper. Follow-up: an on-chain `minOut` floor (V3 TWAP or quoter-based) and restricting the 0x calldata to `exec` with a known Settler `operator`/`target`. Redeploy touches CensusRewardVault → CensusRewardVaultDeployer → LaunchFactoryV4 wiring only.

### F2 — `setZapPath` is unvalidated and `_swap` trusts the router (Low-Medium; deployer-key custody risk; non-ETH quotes only)

- `setZapPath` (`CensusCurveV4.sol:168-173`): deployer-only, any time, no endpoint or shape validation. `_swap` (L300-304) uses `amountOutMinimum: 0` and credits the router's returned `amountOut` as `quoteIn` (`buyWithETH`, L293-297) with no balance-delta check.
- A compromised deployer key can (a) route users' ETH through a pool it controls, and (b) set a path whose last token is not `c.quote`, so `realQuote` is credited (L321) with quote the curve never received — the curve becomes insolvent for every coin on that quote. Users' own `minTokensOut`/`minEthOut` still bound what each trader accepts, so a live user is not silently sandwiched below their tolerance.
- ETH-anchored coins never touch the zap (`c.quote == weth` short-circuits). Only HOOD-anchored (and any future non-ETH quote) launches are affected.
- Recommended fix: validate `pathIn` first hop == WETH and last hop == quote (and the reverse for `pathOut`) exactly as the vault constructor already does (`CensusRewardVault.sol:93-100`), and measure `balanceAfter - balanceBefore` in `_swap` instead of trusting the return value. If not fixed: keep the deployer key cold after deploy and treat `setZapPath` as a multisig-only operation.

### F3 — Launch parameters are not bounded on-chain (Low)

- `LaunchParams.totalSupply/decimals/virtualQuote/graduationQuote` are caller-chosen (`LaunchFactoryV4.sol:50-57`); the curve checks only non-zero and a non-zero offset (`CensusCurveV4.sol:218-223`). The "fixed 1B supply" lives in the frontend only.
- A direct caller can launch a coin whose `graduate()` reverts forever (tick bounds `CensusV4Graduator.sol:76`, 99.99% two-leg check L110, `sqrtRatio` overflow curve L405-408). Buyers are not trapped — `sell` keeps working — but the coin never reaches V4. No theft path.
- Recommended: enforce the canonical supply/decimals and a `graduationQuote`/`virtualQuote` range in the factory, or have the indexer flag non-canonical launches.

### F4 — Sells allowed on a filled, not-yet-graduated curve (Low)

**Status: FIXED 2026-09-23, together with the graduation-liveness gap found while answering it.** Nothing in the stack called `graduate()` (no bot step, no UI button), so a filled coin would have waited for a manual transaction. Now the buy that fills the reserve graduates the coin in the same transaction (`_autoGraduate` → self-call `graduateFromBuy` → `_graduate`), a filled curve is frozen (`_sell` reverts `CurveFilled`), a `GRADUATION_GAS_FLOOR` of 1.5M keeps wallet gas estimates from converging on the deferred outcome, and if the PoolManager or quote token rejects the seeding the fill still succeeds, `GraduationDeferred(coin, reason)` is emitted and the permissionless `graduate()` is retried by the keeper (`graduateStepV4`). Same two-phase shape as Pons' crossing buy. Tests: lifecycle meme test asserts `Graduated` inside the fill receipt and gas under 1.4M; new test covers the deferred path (blocked quote recipient → frozen curve → sells/buys revert → retry succeeds → `graduateFromBuy` rejects outsiders).

- `_sell` has no filled check, so between the capping buy that sets `realQuote == graduationQuote` and the permissionless `graduate()` call, a seller can push the curve back under the threshold. Costs the griefer at least 2% per attempt and any buy refills it. Consider graduating in the same transaction as the filling buy, or rejecting sells once filled.

### F5 — No deadline on curve trades (Low)

- `buy/buyWithETH/sell/sellForETH` take `minOut` but no deadline (`CensusCurveV4.sol:297, 317, 357, 375`). The V4 router does enforce one (`CensusV4Router.sol:45`). Bounded by `minOut`; low on a sequencer chain.

## Checklist results

### 1. Uniswap v4 hook & PoolManager

| Item | Verdict | Evidence |
|---|---|---|
| Hook permission mask | PASS | `REQUIRED_FLAGS = 0x20cc` = 1<<13 (beforeInitialize) \| 1<<7 (beforeSwap) \| 1<<6 (afterSwap) \| 1<<3 \| 1<<2 (returns-delta) — exactly the callbacks implemented (`CensusV4Hook.sol:25, 63, 68, 84`; flags per `@uniswap/v4-core Hooks.sol:29-47`). Constructor enforces equality, not superset (L45). Salt mined off-chain with the same mask (`scripts/lib/hookSalt.js:6-17`), cross-checked in `deployV4.js:92-95`; deployer is owner-only so the mined address cannot be squatted. |
| Reentrancy via PoolManager | PASS | Only external call inside callbacks is `manager.take` (L109), after all state writes (L105-108). Callbacks are `onlyManager` (L49); `register` is registrar-only (L52); `claimFor` is `nonReentrant` and zeroes before transfer (L115-119). Graduator/Router use hash-checked `activeCallback` + `nonReentrant` (`Graduator.sol:90-92, 102-103`; `Router.sol:52-61`). Quotes are deployer-allowlisted, so no ERC777-style callback surface. |
| Transient storage | N/A | No tstore/tload in Census contracts; PoolManager scopes its own per `unlock`. `activeCallback` is regular storage, cleared and asserted consumed. |
| Delta accounting | PASS | Buy: `beforeSwap` returns `+fee` on specified and `take`s `fee` (L79-81, 109) → net hook delta 0; `afterSwap` recomputes and rejects a price-limited partial fill (`PartialBuy`, L93-95). Sell: `afterSwap` takes `fee` from the positive quote delta and returns `+fee` unspecified (L98-100). Both currency orderings handled (L77, L88-90). Exact-output and `int256.min` rejected (L73); fee bounded to int128 (L80). Tests: `v4.fees.test.js:55`, `v4.adversarial.test.js:44-80`, `v4.readiness.test.js:93`. |

### 2. Reflection token & fee-on-transfer

| Item | Verdict | Evidence |
|---|---|---|
| What "reflection" is here | N/A (by construction) | LaunchToken is plain OZ ERC20, single constructor mint, no mint/burn/pause/blacklist/owner (`LaunchToken.sol:22-52`). The anti-snipe `_update` branch is never armed on the V4 path (factory never calls `initAntiSnipe`). The only hook is a balance-notification to the vault (L111) that never changes amounts. The "holder reflection" is a **quote-asset** fee share paid to the vault (`CensusFeeMath.sol:36`, `CensusCurveV4.sol:262`, `CensusV4Hook.sol:107`). Classic AMM desync and recursive-reflection risks do not apply. |
| Accounting desync on the quote side | PASS (ERC20) / see F2 (zap) | `buy` checks `balanceAfter - balanceBefore == quoteIn` and rejects otherwise (`CensusCurveV4.sol:282-284`); reserves are storage-tracked, never balance-derived. Test: adversarial "sell whose quote output is taxed on transfer" reverts cleanly. `buyWithETH` zap trusts the router return (F2). |
| Infinite loop / recursive fees | N/A | No token-level tax; vault excludes curve, factory, PoolManager, hook, router, graduator, itself, DEAD from eligible supply (`CensusRewardVault.sol:118-126`, `LaunchFactoryV4.sol:113-126`). |
| Rounding & precision | PASS | Curve buy/sell both floor against the trader (L315, L365); k is non-decreasing; zero and dust inputs revert (`ZeroAmount`/`CurveLimit`, L281, 316, 343, 366); fee components sum exactly (`CensusFeeMath.sol:35-41`, creator takes remainder); capped final buy lands exactly on `graduationQuote` with refund (L310-311, 327-336). Vault uses a per-share accumulator with fractional carry and an `Insolvent` guard (L161-191, 301). Test: "1 wei buy rounds the fee to zero without breaking custody". |

### 3. Base protocol fees & skimming

| Item | Verdict | Evidence |
|---|---|---|
| Fee double-dipping | PASS | Pool key `fee == 0` enforced at register (`Hook.sol:55`), router (`Router.sol:48`), graduator (`Graduator.sol:71`). Uniswap governance can add at most 0.1% protocol fee on top; the hook deliberately keeps trading live (L74-76) and the Census fee is never charged twice. Test: `v4.fees.test.js:143-150`. |
| Fee withdrawal access control | PASS | Hook `claimFor` pays only `claimable[asset][recipient]` to that recipient, no redirect (L115-121); `protocol`/`registrar` immutable; per-pool creator/rewards written once. Curve `withdrawDeferredFee` pays only the named recipient (L190-196). `platform` is immutable everywhere. Consequence: a lost creator key cannot be rotated (design). |
| Trapped funds | NEEDS ATTENTION (design) | Pull-based claims, so one blocked recipient cannot strand others. Curve defers a failing fee push instead of reverting (L268-273). But a quote issuer pausing/blacklisting the **hook** makes `manager.take` revert and halts every pool on that quote with no recovery path; stray ETH/ERC20 sent to curve, hook or vault is stuck forever (no sweep by design). Vault `_claim` reverts on `Insolvent` for any one basket asset, blocking the others. |

### 4. Launchpad logic

| Item | Verdict | Evidence |
|---|---|---|
| Oracle / price manipulation | PASS | Curve price is purely `virtualQuote/(tokenReserve+offset)` from storage, no oracle; graduation price derived from the same reserves and the pool can only be initialised by the graduator at that price (`Hook.sol:63-65`). A flash loan can fill the curve in one tx (intended) but cannot move the graduation price or open an arbitrage gap. |
| Slippage & deadline | PASS (minOut) / F5 (deadline) | Every trade takes a user minimum; V4 router adds deadline, rejects `minOut == 0`, requires full fill and re-checks the recipient's actual balance change (`Router.sol:45-48, 66-78`). |
| Liquidity lockup immutability | PASS | Graduator's only manager interaction is `modifyLiquidity` with a positive delta inside its guarded callback (`Graduator.sol:105`); no removal, collect, take, owner or upgrade path; `setHook` is one-shot pre-wiring (L59-64). Test: `v4.fees.test.js:9-41`. |
| Full supply to curve / hidden allocation | PASS | Single constructor mint to factory (`LaunchToken.sol:51`); factory forwards all of `totalSupply` (`LaunchFactoryV4.sol:110`); curve requires `balanceOf(curve) >= tokenSupply` (`CensusCurveV4.sol:219`). |
| Vanity address front-running | PASS | CREATE2 salt bound to creator, must end in `0xC0DE` (`LaunchFactoryV4.sol:96-98`). |
| Snipe-tax exemptions | Accepted design, disclose | Creator always exempt plus up to 32 frozen addresses (`CensusCurveV4.sol:232, 242-248`). Worst case: 33 wallets fill the curve fee-light in the launch block while others pay 99%. Penalty decays 99% → 6.18% → 0.19% → 0 over 3 s (`CensusFeeMath.sol:24-27`), so on 2-second blocks it is effectively a launch-block tax. Not carried into the post-graduation hook (inert there). |
| Basket validation | PASS on shape / see F1 | 1-3 assets, no coin, no duplicates, weights sum 10000, route endpoints validated (`CensusRewardVault.sol:82-104`); reward assets deployer-allowlisted (`LaunchFactoryV4.sol:103-105`). Route interior hops are not allowlisted (only matters via F1). |
| Launch parameter bounds | F3 | — |

### 5. Core Solidity

| Item | Verdict | Evidence |
|---|---|---|
| Compiler | PASS (minor) | Floating `^0.8.24` / `^0.8.26` pragmas, pinned by `hardhat.config.js` (0.8.24 legacy, 0.8.26/cancun for v4, viaIR, optimizer 200). Recommend pinning in-source before verification. |
| CEI | PASS | Reserves updated before fee pushes, token transfer and ETH refund in `_buy` (L319-336) and `_sell` (L368-370 → 346, 356-360); `graduate` flips `graduated` and zeroes reserves before external calls (L392-397); all entry points `nonReentrant` (OZ 5.6.1). Vault `distribute`/`claim` guarded. |
| DoS / unbounded loops | PASS | Bounded: ≤32 exemptions, ≤3 basket, 9 fixed exclusions; nothing iterates holders. `graduate()` cannot be blocked by a reverting recipient (deferred) or by pool pre-initialisation (hook gate). Only F4 (griefing at cost) and F3 (creator's own bad params). |
| Unsafe patterns | PASS | No `unchecked`, `selfdestruct`, `delegatecall`, `tx.origin`, proxies. Low-level calls limited to fee pushes (deferred on failure), ETH refunds to `msg.sender`, and the 0x call (F1). One `memory-safe` assembly block reading path endpoints, offsets verified. |
| Privileged roles | PASS with disclosure | Full map in reviewer C's table (summarised): deployer is a single immutable EOA with `setFactory`, `setKeeper`, `setQuoteAllowed`, `setRewardAssetAllowed`, `setZapPath`, one-shot `setGraduator`, and dust sweep to the immutable treasury. **No role can** pause trading, drain reserves, change the fee split or recipients, unlock graduated liquidity, alter a launched coin's reflection/basket, or brick graduation. Not transferable, not renounceable, not upgradeable. |

### 6. Verification pipeline

| Topic | Test exists | Where |
|---|---|---|
| Hook delta accounting / partial fills | Yes | `v4.fees`, `v4.adversarial`, `v4.readiness` |
| Fee split 90/10 and 30/70, reflection to vault | Yes | `v4.lifecycle`, `v4.fees`, `v4.isolation` |
| Snipe-tax window, creator + bundle exempt | Yes | `v4.lifecycle:174`, `v4.readiness:45` (32-cap and zero-address rejection untested) |
| Slippage / minOut | Router yes; curve `Slippage` revert not located | `v4.fees:132-136` |
| Graduation lock, unauthorized graduate, re-init | Yes | `v4.fees:9-41`, adversarial "registration" |
| Fee-on-transfer quote, repeated claims, dust, hookless bypass disclosure | Yes | `v4.adversarial` |
| Reentrancy (attacker contract) | **No** | guards exist in code only |
| Curve-level `deferredFee` / `withdrawDeferredFee` | **No** (legacy curve only) | `review.invariants` targets `CensusCurve` |
| V4 factory CREATE2 / front-running | **No** | `audit.frontrun` is legacy; V4 tests use salt 0 |
| Vault distribution slippage (F1) | **No** | — |
| Fuzzing (Foundry), Slither/Mythril, Echidna | **None** | no foundry.toml, no `*.t.sol`, no slither config; CI runs compile + hardhat test + rehearsals only (`.github/workflows/backend.yml`) |

Deploy guard (`scripts/deployV4.js`): requires FEE_SPLIT_A/B and KEEPER_ADDRESS, official PoolManager with code, hook address prediction and flag check, curve↔graduator↔hook wiring and fee constants (L27-29, 46-59, 92-98, 131-133). Gaps: does not check that treasury/keeper are contracts or multisigs, that keeper ≠ deployer, or that the hard-coded 0x AllowanceHolder has code on Robinhood Chain; explorer verification is a separate step. Frontend/indexer V4 addresses come only from env and are blank in the examples — nothing to reconcile until the mainnet record exists.

## Launch-day recommendations, in order

1. **Fix F1 before the first mainnet deploy**: keeper-only distribution (remove the creator from `_checkOperator`). Add a test that a creator-called `distribute`/`distributeVia0x` reverts and that `minOut` below a sane floor is rejected once a floor exists.
2. **Fix F2 in the same pass**: validate zap path endpoints and use balance deltas in `_swap`. If skipped, keep the deployer key cold and document `setZapPath` as multisig-only.
3. Treasury (`FEE_SPLIT_A/B`) and `KEEPER_ADDRESS` should be multisigs or at least hardware-backed; the deploy script cannot check this — verify by hand and record the addresses in the mainnet deployment record.
4. Add F3 bounds to the factory or an indexer flag for non-canonical launches; decide on F4 (graduate-on-fill).
5. Disclose in the runbook/docs: hookless-pool fee bypass, ≤0.1% Uniswap protocol fee on top, quote-issuer pause halts hooked pools, non-rotatable creator/recipient addresses, the 33-wallet launch bundle, stray funds are unrecoverable.
6. After launch: add a reentrancy attacker test, a V4 curve deferred-fee test, a CREATE2 factory test, run Slither once on the compiled artifacts, and fix the stale header in `test/v4.adversarial.test.js:1-3`.
