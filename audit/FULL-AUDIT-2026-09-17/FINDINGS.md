# Census audit — findings, tracks A–G

Evidence tags: **PROVEN** (ran it), **DERIVED** (forced by the code/maths), **SUSPECTED** (reason, no proof).
Paths are `contracts/contracts/…` unless noted. All against `main`, commit at audit time `c8fdeb3`+.

---

## CX-C1 — S1 (certain) — Creator + 32-wallet bundle are tax-exempt and uncapped; every launch is a structural insider position

**WHERE** `CensusCurve.sol:278` (creator auto-exempt), `:285-297` (`registerWithExemptions`, up to 32), `:608-618` (tax = 0 for exempt); no per-wallet cap anywhere on the curve (`LaunchToken` maxWallet/maxBuy is **not armed** for curve launches — `LaunchFactory.sol:67`, `LaunchFactoryV2.sol:94`).

**WHAT HAPPENS** At registration the creator is added to `snipeTaxExempt`, and `registerWithExemptions` freezes up to 32 more addresses. Exempt addresses pay only the flat 2% at any moment, including the launch block, while everyone else pays up to 99% for ~3 s. There is no cap on how much an exempt wallet can buy on the curve. So the creator + 32 wallets can accumulate the cheapest supply (curve at starting FDV) at 2% from block zero, then sell into organic demand or graduate and control the pool float.

**PROOF** DERIVED from the exemption logic + the absence of any curve-side wallet cap. The 99%→2% schedule and the exemptions are confirmed in `censusCurve.test.js`/`earlyBuys.test.js`. Worked example: with V0=1.5, G=4 ETH, an exempt creator can fund the curve toward graduation at 2% and receive the bulk of the ~1B supply before any taxed buyer gets a fair price.

**BLAST RADIUS** Not theft — but it makes "fair launch" false for every coin. The creator's downside is that self-buying locks quote into the graduated LP (unrecoverable except as LP fees) and costs 2% in + ~1% out; the upside is a large cheap position and 75% of all trade fees. This is the pump.fun soft-rug shape, inherited.

**WHY IT EXISTS** The anti-snipe was designed to punish *external* bots and to let creators run an authorised launch bundle (the "Pons-V2 factory exemption list"). Nobody set a ceiling on the exempt side.

**FIX** (choose per product intent, needs Jamie/team sign-off) (a) cap exempt wallets' cumulative curve buys (e.g. a per-launch bps cap that applies *even to exempt addresses*); (b) shrink the bundle from 32; (c) vest creator/bundle tokens; (d) at minimum, disclose the bundle and creator allocation in the UI and docs so it is not a discovery. Any of these trades "fair-launch" optics against creators' ability to seed liquidity.

**TEST** A test asserting an exempt creator cannot acquire more than X% of supply before graduation (currently nothing constrains it).

---

## CX-F1 — S2 (easy, needs a mempool watcher) — Launch front-running: vanity address ignores the creator — **FIXED 2026-09-17**

**STATUS: FIXED.** Both factories now deploy the token with `salt = keccak256(abi.encodePacked(userSalt, msg.sender))` (`LaunchFactory.sol:65-71`, `LaunchFactoryV2.sol:82-87`), so the vanity address is bound to the creator; a mempool copy deploys to a different address that is (overwhelmingly) not `…c0de` and reverts. The off-chain grinders were updated to mirror the derivation (`scripts/lib/grindSalt.js`, `frontend/src/lib/c0de.ts` — both now require a `creator`), and `frontend/src/pages/Launch.tsx` grinds/reuses the salt bound to the connected wallet only. `test/audit.frontrun.test.js` now asserts the attacker cannot occupy the victim's address and the victim's launch succeeds (passing). Full suite: 96 passing. Original finding below for the record.


**WHERE** `LaunchFactory.sol:59-71`, `LaunchFactoryV2.sol:76-101`. The token is `new LaunchToken{salt: salt}(name, symbol, supply, decimals, mintTo=address(this))`. The CREATE2 address = f(factory, salt, keccak(initcode)); `msg.sender` (the creator) is **not** in the initcode.

**WHAT HAPPENS** The frontend grinds a salt for a `…c0de` address from the coin's params and shows the user their reserved address before they launch. An attacker watching the mempool sees the pending `createLaunch(params, salt)`, submits the identical `params, salt` first with themselves as `msg.sender`. They deploy the token to the same address and are registered as its **creator** (the 75%-fee recipient). The victim's transaction then reverts (address already deployed).

**PROOF** **PROVEN** — `contracts/test/audit.frontrun.test.js` (added this audit): attacker reproduces the victim's vanity address, `curves(addr).creator == attacker`, and the victim's identical call reverts. Passing.

**BLAST RADIUS** No user funds lost, but the attacker steals the creator role (perpetual creator-fee stream) and the vanity identity of any launch they can see in the mempool; the victim loses gas and must relaunch with new params/salt. On a public-mempool L2 this is a cheap, repeatable grief against every launch.

**WHY IT EXISTS** The vanity grind was built to make the address deterministic for a nice preview; determinism without binding the creator makes it reproducible by anyone.

**FIX** Bind the creator into the CREATE2 pre-image so only they can produce the address: e.g. `bytes32 s = keccak256(abi.encode(userSalt, msg.sender))` used as the deploy salt (grind `userSalt` against a hash that includes `msg.sender`), or pass `creator` as an (unused-for-mint) constructor arg so it enters the initcode, or a commit-reveal on launches. The frontend grinder must mirror whichever is chosen.

**TEST** After the fix, re-run `audit.frontrun.test.js` and assert the attacker's identical-params call yields a *different* address (or reverts the "not a census address" check), leaving the victim's launch to succeed.

---

## CX-B1 — S2 (needs setup, costly to the attacker) — Graduation griefable by a deep, extremely-mispriced pre-initialized pool

**WHERE** `CensusCurve.sol:485-491` + `_restoreMigrationPrice:534-563`; bound `RECOVERY_MAX_SPEND_BPS=1000` (`:55`), per-coin override cap `RECOVERY_MAX_SPEND_CAP_BPS=5000` (`:57`, `setRecoveryMaxSpendBps:193`).

**WHAT HAPPENS** Graduation restores a pre-initialized pool to the curve price with a swap bounded to ≤10% (default) of one leg, and reverts (`RecoveryFailed`) if that bound can't reach the target. An attacker who initializes the pool at an extreme price backed by enough real liquidity that even 50% (the deployer's max override) can't move it to target makes `graduate()` revert forever.

**PROOF** DERIVED from the bound logic; the "fails closed when liquidity is too deep for the bounded recovery, and the curve keeps trading" test (`graduation.recovery.test.js`) confirms the revert path and that trading continues. I did not build the extreme-cap-exceeding case, but the mechanism forces it.

**BLAST RADIUS** The coin is stuck **pre-graduation** — but **not frozen**: `sell()` still works (it checks `!graduated`), so every holder can exit at the curve price. The harm is denial of the graduated pool, not loss of funds. The attacker must lock real capital in a mispriced pool that the recovery swap (and any arbitrageur) will pick off at a loss to them, so it is expensive and self-punishing.

**WHY IT EXISTS** Correct fail-closed defence against F01; the trade-off is that "fail closed" is a DoS surface when the attacker over-commits liquidity.

**FIX** Accept it as a documented, bounded liveness risk (recommended — the escape hatch + guaranteed sellability make it low-harm), or add an alternative graduation route that mints into a *fresh* canonical pool address the attacker cannot pre-seed (e.g. a salted pool), or allow the deployer to migrate at a deployer-signed fair price with a timelock. Do not remove fail-closed.

**TEST** A test that initializes the pool beyond the 50% cap and asserts `graduate` reverts while `sell` still returns funds.

---

## CX-G1 — S2 (certain if key lost) — One keeper key holds distribution rights over every vault

**WHERE** `DividendVault._checkOperator:170-174` (accepts `ICensusKeeper(census).keeper()`), `CensusCurve.setKeeper:185-189` (single address), `distribute`/`distributeVia0x`/`convertLaunchFees` are operator-gated and take caller-supplied `minOut`.

**WHAT HAPPENS** The keeper registered on the curve is an authorised operator on *all* vaults. Distribution swaps are protected only by the `minOut` the operator itself supplies. A compromised (or malicious) keeper can call `distribute`/`distributeVia0x` with a low `minOut` and sandwich the swap, extracting most of each pending distribution across every vault. It also gains `setKeeper` power indirectly if the deployer key is the same custody (see CX-G3).

**PROOF** DERIVED. The "must be trusted for price bounds" is stated in the code comments (`:169`, `:334`). No on-chain oracle bounds `minOut`.

**BLAST RADIUS** Bounded to *pending, undistributed* dividend fees at the moment of compromise (not principal, not already-claimed dividends). Across many active vaults this can still be material. Curve reserves are untouchable by the keeper.

**WHY IT EXISTS** Deliberate: one keeper auto-distributes so creators don't each delegate. The price-bound trust was moved to that key.

**FIX** Keeper key in an HSM/multisig; rotate on any suspicion (`setKeeper` exists); consider an on-chain sanity bound on `minOut` vs the canonical pool TWAP so even a bad keeper can't set it to dust; per-vault operator override remains for creators who want their own keeper. **Also (Neil's audit): never run the legacy `bot/src/index.js` or `bot/src/buyback.js` — both swap with `amountOutMinimum: 0n` (confirmed `index.js:55`, `buyback.js:59`), i.e. zero slippage protection / full MEV exposure. Use only the operator-`minOut` keeper path (`keeperd.js`/`keeper0x.js`); delete or clearly quarantine the legacy scripts.**

**TEST** A test that a distribution with `minOut` below a TWAP-derived floor reverts (after adding such a floor).

---

## CX-G2 — S2 (gate) — Treasury is a single deployer-owned EOA unless `FEE_SPLIT_A/B` are set

**WHERE** `scripts/deploy.js:32-50`. With `FEE_SPLIT_A/B` set → immutable `FeeSplitter` (trustless). Unset → `FeeVault` **owned by `deployer.address`**, and that address becomes the curve's immutable `platform` and the locker's `feeVault`.

**WHAT HAPPENS** If mainnet is deployed without the split env vars, 100% of protocol fees (25% of every trade + protocol share of LP fees) accrue to a single-key `FeeVault` the deployer can drain via `withdrawAll`. It is baked in immutably at deploy.

**PROOF** DERIVED from the deploy script branch.

**BLAST RADIUS** All protocol revenue under one EOA; and because `platform` is immutable on the curve, it can never be repointed to a multisig/splitter without redeploying the whole stack.

**FIX** Make the split mandatory on mainnet (fail the deploy if `network==robinhood && !FEE_SPLIT_A`); use the FeeSplitter (or a multisig) as `platform`; record the addresses in `deployments.*.json` and check them post-deploy.

**TEST** N/A (deploy gate) — add to `GATES.md`.

---

## CX-C2 — S3 (certain) — The launch tax is effective only for the first block or two

**WHERE** `CensusCurve.currentSnipeTaxBps:608-614`, keyed to `block.timestamp - launchedAt`, `SNIPE_TAX_SECONDS=3`.

**WHAT HAPPENS** Schedule (verified by hand): elapsed 0 → 99%, 1 s → 8.18%, 2 s → 2.19%, ≥3 s → 2%. On an L2 with ~2 s blocks the tax is 99% in the launch block, ~2.19% one block later, 2% after that. A sniper simply waits ~3 s and pays the normal 2%; the tax cannot be made *lower* by manipulating the timestamp, only avoided by patience. So it deters same-block bundles but not a patient sniper, while the creator/bundle (CX-C1) face 2% throughout.

**PROOF** DERIVED (arithmetic on the shift schedule). Block time on Robinhood Chain is a track-K item I have not measured; the finding holds for any block time ≥ ~1.5 s.

**BLAST RADIUS** Fairness/marketing: the "3-second tax" protects far less than it sounds. Also, an honest buyer who lands in the launch block pays 99% — make sure the UI surfaces the live `buyFeeBps` before they sign (front-end track N/Q).

**FIX** If stronger protection is wanted, key the decay to *block number* (deterministic per chain) and/or lengthen it; but the bigger lever is capping the exempt side (CX-C1). Document what the tax does and does not do.

---

## CX-E1 — S3 (needs setup) — JIT dividend farming around a distribution

**WHERE** `DividendVault.distribute/_credit:253-285` credit `accPerShare` to whoever is eligible *at distribution time*; post-graduation the token trades freely on Uniswap.

**WHAT HAPPENS** An actor front-runs a known distribution by buying the token, holds across the operator's `distribute` tx, then sells and claims — capturing a pro-rata slice of that distribution for tokens held only momentarily. Pre-graduation the 2% curve fee each way blunts it; post-graduation (Uniswap, ~1% + slippage) it is more feasible for a large pending distribution.

**PROOF** SUSPECTED/DERIVED. Profitable only when the pending distribution is large relative to the cost of acquiring/offloading a big share; the transfer-hook settlement correctly limits earnings to the holding window, so it is bounded, not unlimited. I did not build a profitability model — next step would be to parametrise pool depth vs distribution size.

**FIX** Operator distributes small amounts frequently (dilutes JIT), or snapshots eligibility at a block before the distribution is announced. Low priority given the fee drag.

---

## CX-A1 — S3 (certain, mitigated by caller) — Zap swaps use `amountOutMinimum: 0`

**WHERE** `CensusCurve._swap:355-361` (both zap legs), relying on the final `minTokensOut` (`_buy:375`) / `minEthOut` (`sellForETH:425`).

**WHAT HAPPENS** The intermediate WETH↔quote swap sets no min-out; the only protection is the caller's final min-out. If the frontend passes 0 (or a stale/loose value) as `minTokensOut`/`minEthOut`, the whole zap is sandwichable.

**PROOF** DERIVED. The contract design is sound *iff* the caller sets a real final min-out. Whether the frontend does is a track-N/J item (verify `Coin.tsx` computes slippage-bounded min-out for `buyWithETH`/`sellForETH`).

**FIX** Confirm and enforce a sane default slippage in the UI; consider a non-zero floor in `_swap` as defence-in-depth for direct integrators who call the curve without a UI.

---

## CX-E2 — S3 (low likelihood) — Fee-on-transfer / rebasing basket asset strands dividends

**WHERE** `DividendVault._claim:433` (`balanceOf(s) < reserved[s]` → `Insolvent`), basket set at construction with no transfer-behaviour check (`:112-132`).

**WHAT HAPPENS** `reserved[s]` is credited from measured deltas at distribution, but if a basket stock is fee-on-transfer or rebasing, its balance can later fall below `reserved[s]`, so `_claim` reverts `Insolvent` for the last claimants, or dust is permanently stranded.

**PROOF** DERIVED. Basket assets are tokenised stocks (unlikely to be FoT/rebasing), and each vault is isolated (a bad basket only harms that coin's own holders), so likelihood is low — but nothing validates it.

**FIX** Document that baskets must be standard ERC-20s; optionally gate basket assets to a deployer-curated allowlist (mirrors `allowedQuote`).

---

## CX-E3 — S2 (certain, market structure) — External pools bypass Census fees; "every trade funds rewards" is false (found by Neil's independent audit)

**WHERE** `LaunchToken.sol` (a plain, freely-transferable ERC-20 post-launch — confirmed: the anti-snipe window is dormant in the curve flow and lifts to "zero restrictions"); the canonical locked pool is only one venue.

**WHAT HAPPENS** After graduation the coin is an ordinary ERC-20, so anyone can create another Uniswap (or other DEX) pool for it, and aggregators route wherever execution is best. Trades on an external pool pay **neither** the curve's 2% fee **nor** the canonical locked LP's fee — so the creator/holder-reward stream only captures trades that go through the canonical pool. Adding external liquidity to the *same* canonical pool also dilutes the locked position's fee share. This is a market-structure fact, not a patchable bug (short of making the token non-transferable, which nobody wants).

**PROOF** DERIVED (transferability confirmed in `LaunchToken.sol`; standard V3 permissionless-pool behaviour). Credit: raised by Neil's 17 Sep independent audit; my first pass missed it.

**BLAST RADIUS** The holder-reward value proposition is weaker than "a coin that pays a dividend on every trade" implies — a fairness/disclosure gap that compounds the securities-language risk (CX-X1).

**FIX** (product decision, not code alone) Describe the canonical pool in the UI, preferentially route through it, show the execution venue, monitor alternate pools, and **never** promise that every trade funds creator/holder rewards. Don't portray external-pool volume as recoverable "missing" accounting.

**TEST** N/A (disclosure/routing) — a UI check that reward copy is qualified, and monitoring for alternate pools.

---

## CX-G3 — S3 — Deployer is a single immutable EOA; `platform` can never be rotated

**WHERE** `CensusCurve.sol:161` (`deployer = msg.sender`, immutable, no transfer), `:77` (`platform` immutable). All `setFactory/setQuoteAllowed/setKeeper/setRecoveryMaxSpendBps/sweepMigrationDust/setZapPath` are `deployer`-only.

**WHAT HAPPENS** If the deployer key is lost, all admin levers freeze forever (no `setKeeper`, no new quotes, no zap paths, no dust sweep). If it leaks, the attacker's *maximum* reach is: `setKeeper(attacker)` → MEV-drain pending dividends across vaults (CX-G1); `setFactory`/`setQuoteAllowed`/`setZapPath` → griefing/mis-listing of *new* launches; `sweepMigrationDust` → dust to `platform` (not to the attacker). **They cannot touch existing curve reserves** — there is no function that withdraws `realQuote`. Write that down: *deployer-key leak ≈ loss of pending dividend fees + new-launch griefing, not curve principal.*

**FIX** Deployer = multisig or a 2-step `Ownable2Step`-style handover with a timelock on the sensitive setters; use a FeeSplitter/multisig as `platform` from block one (CX-G2).

---

## CX-B2 — S4 — A tiny sell can delay the graduation trigger

**WHERE** `CensusCurve.graduate:461` requires `realQuote >= graduationQuote`; `sell` is allowed while `!graduated`.

**WHAT HAPPENS** When the curve is exactly full, a griefer sells 1 token (dropping `realQuote` below `G`) right before each `graduate()` call, so graduation reverts `NotReady`. Buys immediately refill it (bounded so it can't overshoot). Net effect: graduation can be delayed, not prevented; the griefer pays the 2% sell fee each time.

**FIX** None needed; the keeper simply re-calls `graduate()` in the same block as the refilling buy, or graduation is bundled with the filling buy. Note in ops.

---

## CX-V1 — S3 (ops) — The CLI launch scripts are stale (pre-curve ABI); only the frontend can launch a coin

**WHERE** `scripts/launch.js`, `scripts/launchV2.js`, `scripts/devnetLaunch.js`, `scripts/devnetV2.js`. They build `createLaunch({ …, fee, sqrtPriceX96, tickLower, tickUpper, graduationTick }, …)` and call `computeLaunchParams`/`computeGraduationTick` — the **old direct-to-Uniswap** shape. The current factories take `LaunchParams{ name, symbol, totalSupply, decimals, poolFee, virtualQuote, graduationQuote }`.

**WHAT HAPPENS** `npm run launch:robinhoodTestnet` / `launch:robinhood` (the runbook's launch command) would fail to encode/revert against the deployed curve factories. `demoLaunch.js` is the only current-ABI script; the real launch path is the frontend (`Launch.tsx`), which is correct.

**PROOF** DERIVED (read the scripts against the current factory ABI). Discovered while fixing CX-F1; I updated their `grindSalt` calls to pass the creator so the grind step stays valid, but did not rewrite them to the curve ABI (out of scope).

**BLAST RADIUS** No funds; a broken documented ops command and a handover trap — someone following `MAINNET_RUNBOOK.md`/`TESTNET_RUNBOOK.md` literally hits a wall.

**FIX** Rewrite `launch.js`/`launchV2.js` to the curve `LaunchParams` (like `demoLaunch.js`), or delete them and point the runbook at the frontend / `demoLaunch.js`. Fold into track Z (docs/runbooks).

---

## CX-Y1 — S4 — Stale skipped fork-test description

**WHERE** `test/integration.fork.test.js` (the pending "post-graduation: fees split 80% creator / 20% vault").

**WHAT HAPPENS** The description says 80/20; the live split is 75/25 (`PROTOCOL_FEE_BPS=2500`). The test is skipped (no `BASE_FORK_RPC_URL`), so nobody notices. Live behaviour is correct and asserted elsewhere (`audit.repro.test.js` → holders = 3× platform).

**FIX** Update the description to 75/25 and wire a fork RPC so the pool-fork tests actually run in CI.

---

# Argue against the premise (required)

**The anti-snipe launch tax cannot make these launches fair, because the only party it never touches is the one best positioned to extract value.** External snipers are taxed for ~3 seconds and can wait it out (CX-C2); meanwhile the creator and 32 wallets buy the cheapest supply at 2% from block zero with no cap (CX-C1). The tax therefore transfers a little value from impatient outsiders to the creator (who receives 75% of it) and does nothing about the creator's own accumulation. A product whose pitch is *fair company launches that pay stock dividends* is, mechanically, a launchpad where the creator can front-load their own coin — the same shape as the meme pads it wants to be more respectable than.

I am not proposing to delete the bundle allowance — seeding liquidity is real. But the honest options are (a) cap the exempt side too, (b) vest the creator/bundle, or (c) drop the "fair" framing and disclose the creator allocation prominently. Pick one on purpose. Shipping the current design silently is the choice most likely to produce the damaging journalist sentence: *"Census's own code exempts the founder's 33 wallets from the anti-snipe tax it charges everyone else."*

# Ranked work (harm-avoided per hour)

1. **CX-F1 fix** — bind `msg.sender` into the CREATE2 salt. ~2–4 h incl. frontend grinder + re-run the repro. Kills a cheap, repeatable launch-hijack. *Highest ratio.*
2. **CX-G2 gate** — make FeeSplitter/multisig mandatory on mainnet, assert post-deploy. ~1 h. Prevents an unrecoverable single-EOA treasury.
3. **CX-C1 decision** — cap exempt buys or vest, or disclose. ~0 h code if "disclose", days if "cap+vest"; but it is the biggest reputational exposure. Decide before launch regardless.
4. **CX-A1 verify** — confirm the UI sets real slippage on the zap. ~1 h (front-end track).
5. **CX-G1 hardening** — keeper key custody + optional TWAP floor on `minOut`. ~0.5 h custody now; ~1 day for the on-chain floor.
6. **CX-C2 / CX-B1 / CX-E1/E2 / CX-G3** — document as accepted risks with the stated mitigations; revisit CX-C2 (block-number keying) only if the tax is a marketing pillar.
7. **CX-Y1** — fix the stale test string and wire a fork RPC into CI. ~30 min.
