# V4 migration: implementation and release checklist

Started 2026-09-20 on `codex/v4-fee-migration`, based on `2ca17a0`.
Status 2026-09-22: the V4 product is implemented end to end at the contract layer: `LaunchFactoryV4` (meme and company launches, identical economics, up to three reward assets incl. the launch token and the pairing asset), `CensusCurveV4` (2% base, 90/10 Census/creator, optional 1-4% reflection, 3-second anti-snipe capped at 99%, PF virtual reserve, capped final fill), `CensusV4Graduator`/`CensusV4Hook` (permanent V4 liquidity, 30/70 after graduation on every router), `CensusRewardVault` (reward-debt checkpoints, custody exclusions incl. the PoolManager, no conversion routine). Proven by `contracts/test/v4.lifecycle.test.js` (local) and `contracts/test/v4.lifecycle.fork.test.js` (official Robinhood PoolManager on a fork). Deploy with `scripts/deployV4.js`; runbook `MAINNET_RUNBOOK_V4.md`; app-layer contract in `audit/V4-INTEGRATION-SPEC.md`. See `audit/RELEASE-DAY-REPORT-2026-09-22.md` for the current decision.

Readiness re-test 2026-09-21: see [GO-LIVE-READINESS-2026-09-21.md](GO-LIVE-READINESS-2026-09-21.md). Expanded local suite: 107 pass; actual Robinhood V3 and V4 component fork tests pass separately; obsolete Base fork setup fails when enabled. No change to the NO-GO decision: production integration remains incomplete.

## Confirmed user requirements

- Migrate new Census launches to Uniswap V4 at graduation.
- Same economics for meme and company launches.
- Base buy fee: 200 bps. Base sell fee: 200 bps.
- On curve: Census receives 90% of the base fee; creator receives 10%.
- After graduation: Census receives 30% of the base fee; creator receives 70%.
- Optional holder reflection rate: 1–4% ON TOP of the base fee; disabled must be supported.
- Creator selects up to three reward assets and weights summing to 100%. Options include the launch token itself, the pairing asset, and other supported assets. Freeze this configuration at launch.
- The three-second anti-snipe mechanism remains mandatory for launches. Preserve the existing decay schedule; cap the combined charge at 99% by reducing only the penalty when reflection is enabled.
- Preserve the Pump.fun-style virtual-token-reserve model and 1B real supply.

For 100 quote units of fee-bearing volume, base-fee allocations are 1.80 Census / 0.20 creator on curve and 0.60 Census / 1.40 creator after graduation. Calculate the base fee once and allocate its integer remainder deterministically so allocations sum exactly to the fee.

## Implemented on this branch

- `CensusFeeMath`: both phase allocations, independent holder surcharge, mandatory-window rate calculation, exact allocation conservation with integer rounding. Penalty follows the phase's Census/creator split.
- `CensusV4Hook`: pairing-asset fees, static zero LP fee, immutable registered policies, protected pool initialization, per-beneficiary pull balances and authenticated manager callbacks. Canonical trades through independent routers pay the same hook fee.
- `CensusV4Router`: exact-input ERC20 swaps with deadline, positive minOut, authenticated one-time unlock callback, full-fill enforcement, exact settlement and actual recipient balance checks. Native ETH wrapping and quoting are not integrated yet.
- `CensusV4Graduator`: one-time hook wiring; authorized curve deposits; registered-pool initialization; full-range permanently custodied liquidity; >=99.99% consumption of both legs; bounded dust returned to the curve. No liquidity removal or arbitrary execution function. This contract has been tested with a simulated curve caller, not yet with the production bonding curve.
- V4 core pinned to `1.0.2`; Solidity 0.8.26/Cancun for V4. Existing V3 sources keep Solidity 0.8.24/settings. Legacy client token bytecode check passes.
- Local integration tests use the actual Uniswap V4 PoolManager, both token orderings, both swap directions and multiple routers; test fee solvency, claims, rollback on slippage, callback authorization and graduation reserve mismatch.

## Incomplete: required before release

- Connect the production PF-style curve to the V4 graduator and shared fee math. The existing `CensusCurve` still uses V3 and its old fee split.
- Build the factory and vault configuration for independent reflection rates and up to three weighted assets. The existing `holdersBps` creator-fee allocation is NOT this new model.
- Implement and test reward conversion and per-holder distribution. Merely accruing a holder fee to a vault address is not holder rewards. In particular, reserved launch-token rewards must never be spent by a buyback/conversion routine; settle transfer checkpoints and claim effects safely.
- Exclude PoolManager singleton custody, curve inventory, vault, adapters and router custody from eligible holder supply before inventory movements. Test company tokens used as another launch's quote.
- Integrate V4 pool IDs, fee-aware quotes, swaps, graduation events, indexer mirror, keeper operations, UI fee breakdown and launch configuration. Existing scripts/frontend are still V3; do not use them as a V4 deployment path.
- Provide production CREATE2 hook salt mining/deployment and address verification; the deployer currently included in mocks is test-only.
- Complete lifecycle, mixed-decimal, adversarial token, anti-snipe integration, reward solvency, concurrent-launch, stress and target-chain rehearsal tests. Current V4 tests are foundation coverage, not a full audit.
- Verify target-chain Cancun support and official deployed V4 infrastructure; complete team/mainnet gates and independent review after integration.

## Validation recorded 2026-09-20

From `contracts/`:

- `npx hardhat test`: **102 passing, 3 pending**. Pending suites require external fork RPC configuration; they did not run. The 98 pre-existing passing cases exercise the legacy V3 implementation; the four new V4 cases do not establish end-to-end migration readiness.
- `npm run test:v4`: four integration/property cases (same file exercised in the full suite).
- `node scripts/exportTokenBytecode.js --check`: passed legacy creation-bytecode parity and size checks.
- New deployed bytecode sizes: hook 5,743 bytes; router 3,420 bytes; graduator 7,520 bytes, all below EIP-170.
- No public testnet/mainnet transactions, frontend migration, production deployment or remote push performed for these changes.

## Explicit current limitations

- Exact-output swaps revert. Price-limited partial buys revert rather than charge fees on unspent input; the Census router also rejects partial sells. Quoting/routing integrations must respect this.
- Protocol-fee policy (decided 2026-09-22): the hook never halts trading. If Uniswap governance enables its protocol fee on a Census pool (at most 0.1%), it applies on top of the Census 2% + reflection and is disclosed as such; the Census fee is still charged in full on the specified input (`test/v4.fees.test.js`). Halting would have bricked every pool forever because neither the hook nor the pool can be replaced.
- V4 pools do not supply the V3 built-in TWAP used by the current app. Replacement oracle/keeper price protection must be implemented; spot prices alone are not an acceptable substitute.
- Independent pools without the Census hook remain able to bypass these fees. V4 does not make a freely transferable ERC20 universally taxed.
- Reward conversions into different assets may themselves incur swap fees/slippage. The UI must distinguish trade taxes from conversion costs.

## Migration work and acceptance criteria

- Shared fee math used by the curve and V4 hook, with explicit buy/sell fee bases and exact-input/exact-output semantics.
- Canonical pool hook must enforce the fee independent of which router calls it; do not add a second LP fee that accidentally increases the advertised total.
- V4 PoolManager settlement, authenticated callbacks, registered pool identity checks, and per-launch escrow accounting must be covered against real V4 core.
- Graduation must preserve price and reserves, permanently lock liquidity, and resist pre-initialization, malicious callbacks, and cross-launch accounting contamination.
- Holder payouts must use bounded per-share accounting and claims, excluding pool custody, curve inventory, vaults, and dead addresses. Define balance-checkpoint timing to prevent new holders claiming previously accrued fees.
- Replace V3-specific canonical pool addresses, position reads, quotes, swap paths, and event ingestion with V4 pool IDs and integrations. Existing external stock/quote routes may still use V3; do not change their fees.
- Update deployment preflight, frontend fee breakdowns, indexer, keeper, and tests together.
- Verify actual target-chain PoolManager, PositionManager, quoting/routing support and protocol-fee settings before deployment.
- Test buy/sell, partial final buys, graduation, post-graduation swaps through multiple routers, reflections, claims, transfers, fee conservation, custody solvency and external-pool bypass.
- Existing immutable V3 positions cannot be assumed movable: handle legacy launches separately rather than implying they can be upgraded in place.

## Pons reference

The published `PonsV2BuybackVault.sol` buys back/holds launch tokens and vests releases over five years to recorded creator and protocol recipients. It does not implement a pro-rata payout to ordinary holders. This source is not proof of every deployed Pons mode or any third-party reward bot.

Reference: https://github.com/ponsdotdev/ponsfamily/blob/main/contractsV2/src/v2/PonsV2BuybackVault.sol

V4 hooks enforce economics inside the canonical pool. Freely transferable tokens can still trade in independent external pools without that hook; do not advertise universal fee enforcement.
