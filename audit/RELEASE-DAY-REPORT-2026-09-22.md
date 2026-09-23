# Census release-day report — 22 September 2026 (pass 2: V4 product implemented)

**Decision: code-complete for the agreed V4 product; mainnet GO remains gated on non-code items only.**
Every code blocker from pass 1 (below) is closed and proven with executable evidence: new launches graduate into a
hooked Uniswap V4 pool; the base fee is 2% on buys and sells with 90/10 Census/creator on the curve and 30/70 after
graduation; optional 1–4% holder reflection funds an immutable basket of up to three assets including the coin itself
and the pairing asset; the 3-second anti-snipe is mandatory and capped at 99%; the PF virtual reserve and 1B real
supply are preserved; liquidity is permanent; frontend, indexer and keeper speak V4. What still blocks a mainnet
deployment is production configuration, custody/legal/monitoring gates, an independent review of the new contracts,
and a funded testnet rehearsal. None of those can be closed from this workstation.

Scope: branch `codex/v4-fee-migration` at `2ca17a0` plus uncommitted work in the main checkout (42 files changed since
pass 1, +3,515/−1,190). No deployment, broadcast, credential, cloud or remote change was made. Pass 1 (the 08:00
sandbox audit that returned NO-GO) is summarised at the end; its evidence is unchanged.

## 1. What was built (executable launch path)

| Requirement | Implementation | Evidence |
|---|---|---|
| New launches use V4 at graduation | `CensusCurveV4.graduate()` hands reserves to `CensusV4Graduator`, which registers the hook policy, initialises the pool at the curve's exit price and locks a full-range position it cannot remove | `contracts/contracts/v4/CensusCurveV4.sol:372-411`; `v4.lifecycle.test.js` "meme launch", "6-decimal quote" (both orderings); fork run below |
| 2% base on buys and sells | `CensusFeeMath.BASE_BPS = 200` used by curve and hook | `CensusFeeMath.sol`; `FeeAllocated`/`FeeAccrued` assertions in every lifecycle case |
| Curve split 90/10 | `CensusFeeMath.calculate(…, graduated=false)`, `CURVE_PROTOCOL_BPS = 9000` | `CensusCurveV4.sol:42,245-251`; `CensusFeeMath.sol:40`; rehearsal table `audit/V4-LIFECYCLE-RESULTS.md` (0.018 / 0.002 on a 1 ETH buy) |
| Post-graduation split 30/70 | hook `_accrue` with `graduated=true` | `CensusV4Hook.sol:106-115`; rehearsal (0.0012 / 0.0028 on a 0.2 ETH pool buy) |
| Reflection 0 or 1–4% on top | `reflectionBps` validated at registration, charged on buys and sells by curve and hook, paid to the vault | `CensusCurveV4.sol:203`; "company launch with 3% reflection" case: 0.03 to the vault on a 1 ETH buy, 0.006 hook reflection post-graduation |
| Basket ≤ 3 immutable QUOTED assets (pairing asset and/or listed stocks), never the coin | `CensusRewardVault` (`MAX_BASKET = 3`, constructor rejects the launch token); `LaunchFactoryV4` rejects any basket asset that is not the quote or on `CensusCurveV4.allowedRewardAsset` (`AssetNotAllowed`); the list is deployer-managed on-chain (`setRewardAssetAllowed`), additive, and frozen per launch; the vault has no buy/sell/convert routine | `CensusRewardVault.sol:35,87`; `LaunchFactoryV4.sol:102-108`; `CensusCurveV4.sol` `setRewardAssetAllowed`; lifecycle case "reward assets" (coin rejected, unlisted rejected, later-listed stock works, delisting affects only new launches) |
| Anti-snipe 3 s, capped 99% | `CensusFeeMath.rates` (9900 → 618 → 19 → 0 bps, cap 9900 − base − reflection); creator/bundle exempt | "launch window" case: 99% at the launch second with 3% reflection preserved, 11.18% / 5.19% / 5% at +1/+2/+3 s |
| PF virtual reserve, 1B real supply, no dead surplus | curve math unchanged; graduator returns rounding dust to the curve; supply conservation asserted | lifecycle cases; rehearsal `tokenDust` / `quoteDust` |
| Permanent custody | graduator has no removal path; pool cannot be re-initialised or shadowed | "rejects bad launches" case; `v4.adversarial.test.js` |
| Hook fees canonical across routers; bypass disclosed | identical fee via two test routers and the Census router; hookless pool bypass proven and shown in the UI | `v4.fees.test.js`; `v4.adversarial.test.js` DISCLOSURE; `frontend/src/pages/Coin.tsx` hook disclosure copy |
| Holder accounting excludes custody; reserved launch tokens protected | vault excludes curve, factory, PoolManager, hook, router, graduator, vault, dead; `eligibleSupply` asserted equal to circulating; reserved tokens can only leave via claims | `CensusRewardVault.sol:163`; `LaunchFactoryV4.sol:113-121`; lifecycle case |
| Frontend / indexer / keeper agree on pool IDs, events, fees | pool key = sorted(coin, quote), fee 0, tickSpacing 60, hooks; `poolId = keccak256(abi.encode(key))` cross-checked against `curve.poolIds`; V4 events ingested; keeper collects via `hook.claimFor` and distributes via `vault.distribute` | `frontend/src/lib/v4pool.ts`; `indexer/src/ingest.ts`; `bot/src/keeperd.js`; `audit/V4-INTEGRATION-SPEC.md` |
| Protocol-fee liveness | hook no longer halts trading if Uniswap governance enables its ≤0.1% protocol fee (halting would have bricked every pool forever); Census fee still charged in full | `CensusV4Hook.sol:74-76`; `v4.fees.test.js` |

New files: `contracts/contracts/LaunchFactoryV4.sol` (compiled with the legacy 0.8.24 settings so the embedded LaunchToken
bytecode, and therefore every predicted `…c0de` address, is byte-identical; `exportTokenBytecode.js --check` passes),
`contracts/contracts/v4/{CensusCurveV4,CensusRewardVault,CensusRewardVaultDeployer,CensusHookDeployer}.sol`,
`contracts/scripts/{deployV4.js,rehearseV4Lifecycle.js,lib/hookSalt.js}`, `contracts/test/{v4.lifecycle,v4.lifecycle.fork}.test.js`,
`frontend/src/lib/{curves,v4pool}.ts`, `indexer/prisma/migrations/20260922100000_v4_product`, `MAINNET_RUNBOOK_V4.md`,
`audit/V4-INTEGRATION-SPEC.md`, `audit/V4-LIFECYCLE-RESULTS.{md,json}`. Legacy V3 contracts, scripts and tests are untouched.

## 2. Tests run (final state; logs `audit/readiness-2026-09-22-v4-*.log`)

| Suite | Result |
|---|---|
| contracts compile + `exportTokenBytecode.js --check` (now also sizes all V4 contracts) | pass |
| contracts `npx hardhat test` (all suites, final policy) | **121 passing, 3 pending** (the three opt-in fork suites, each run separately below), 0 failing |
| `npm run test:v4` (lifecycle 8 + isolation 1 + fees 4 + readiness 5 + adversarial 5) | 23 passing; the isolation case runs four coins with different reflection rates and baskets on one stack and proves fees, vault balances, eligible supply, claims and hook claimables never cross between launches (`test/v4.isolation.test.js`) |
| `npm run rehearse:v4` | ALL V4 LIFECYCLE SCENARIOS PASSED; per-step fee tables in `audit/V4-LIFECYCLE-RESULTS.md` |
| `npm run rehearse:bonding` (legacy V3) | ALL THREE BONDING LIFECYCLES PASSED |
| `npm run deploy:v4:local` | pass: hook salt mined (60,098 iterations), wiring and fee-constant assertions pass, `deployments.v4.hardhat.json` written |
| PF indexer parity (V3 fixtures) | 3/3 pass |
| Robinhood V3 lifecycle fork (`AUDIT_MAINNET_FORK=1`) | pass, pinned block 69778521 |
| Robinhood V4 component fork (`AUDIT_V4_FORK=1`, readiness suite) | pass, pinned block 69778903 |
| **Robinhood V4 product fork** (`AUDIT_V4_FORK=1 … v4.lifecycle.fork.test.js`): launch → curve → capped fill → graduation into the **official PoolManager `0x8366a39c…`** → hook trades (0.003/0.007/0.01 on 0.5 ETH) → `claimFor` → distribute (coin bought in the V4 pool) → claim | pass, **pinned block 69988991** (final policy; earlier run 69930892), all transactions local |
| indexer prisma generate / typecheck / build / `npm test` | pass: API, ingest, pricing, **v4** (both currency orderings, fee pairing, exactly-once, foreign pools ignored) |
| indexer `npm run test:pg` (real embedded PostgreSQL, 7 migrations incl. `usd_fail_closed` and `v4_product`) | 8/8 pass incl. a V4 coin in the reference stream; ALL REAL-POSTGRES CHECKS PASSED |
| bot `npm test` | 20 checks pass: 13 legacy + 7 V4 (discovery, pre/post-graduation minOut planning, hook claims once each, no-quoter skip with alert, authority, wiring refusal, combined V3+V4 process) |
| frontend `tsc`, `npm run build`, API tests (23/18/all/10) | pass |
| frontend `release-check.test.cjs` | 62 checks pass; this checkout's source passes the V4 presentation check |
| frontend `npm run release:check` | fails closed without env (8 missing V4 values); "configuration complete" with a full V4 env |
| dependency audit (runtime, `--omit=dev`) | contracts 0, indexer 0, bot 0, frontend 2 high / 27 moderate, all transitive under Privy/wagmi/WalletConnect and `@vercel/blob`→`undici`; only semver-major upgrades remain (not applied) |
| browser smoke | **not performed**: the Claude in Chrome extension is not connected in this session. HTTP smoke of the production preview passed in pass 1; a human click-through of the new wizard, coin page and rewards panel is required before cutover |

## 3. Remaining blockers (all non-code)

| Pri | Item | Owner | Smallest safe closure |
|---|---|---|---|
| P0 | Production configuration does not exist: no `frontend/.env`, indexer/keeper env, `deployments.v4.robinhood.json` | ops | Run `MAINNET_RUNBOOK_V4.md` steps 2–6; `npm run release:check` must print "configuration complete" |
| P0 | Treasury/keeper custody (G1–G3): FeeSplitter legs, keeper key in HSM, deployer backup | Jamie | Provide the addresses; the deploy script refuses mainnet without them |
| P0 | Independent review of the new contracts (curve, vault, factory, deployer) and of the hook liveness policy | external auditor | Scope: `contracts/contracts/LaunchFactoryV4.sol`, `contracts/contracts/v4/`; start from `v4.lifecycle.test.js` |
| P1 | Funded testnet rehearsal on Robinhood testnet (real network, real wallets, UI end to end) | team | `npm run deploy:v4:robinhoodTestnet` (deploys a local PoolManager copy if none is official there), then the smoke in the runbook |
| P1 | Legal/ToS/GDPR (G4, G5), monitoring/incident plan (G8), KV + spend alert + second RPC (G9) | Jamie/Coolio | Unchanged from GATES.md |
| P1 | Price display is spot-only in V4 (no TWAP); trade protection comes from the V4Quoter + user slippage and the router's full-fill rule | product | Accept and label (done in UI), or add an off-chain oracle before large-cap launches |
| P2 | Company-coin quotes: indexer USD price null; frontend basket limited to coin + pairing coin (no V3 route out of a V4 pool) | product | Derive USD from the quote coin's own price; add V4 routes for stocks later |
| P2 | Frontend runtime advisories (`ws`, `undici`) need semver-major upgrades of wagmi / `@vercel/blob` | Coolio | Plan the majors; do not `audit fix --force` |

## 4. Deployment configuration still required

Chain 4663; PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`, V4Quoter `0x8dc178efb8111bb0973dd9d722ebeff267c98f94`,
StateView `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`, WETH `0x0Bd7D308…`; `FEE_SPLIT_A/B`, `KEEPER_ADDRESS`; the seven
`VITE_*` V4 values plus `VITE_INDEXER_URL`, `VITE_FROM_BLOCK`; indexer `CURVE_V4_ADDRESS`, `FACTORY_V4_ADDRESS`,
`POOL_MANAGER_ADDRESS`, `HOOK_ADDRESS`, `ETH_USD`/`QUOTE_USD`; keeper the same plus `V4_ROUTER_ADDRESS`, `V4_QUOTER_ADDRESS`;
KV + spend alert; second RPC; legal pages; monitoring. Full procedure: `MAINNET_RUNBOOK_V4.md`.

## Do not deploy until

FeeSplitter/keeper custody is provided, the external review is done, the funded testnet rehearsal and a human browser
click-through pass, and `npm run release:check` is green against the production env. Do not use `scripts/deploy.js`
(legacy V3 stack) for the V4 product; do not `npm audit fix --force`.

---

## Pass 1 summary (08:00, sandbox worktree, before implementation) — NO-GO

The audit found the V4 hook/router/graduator existed only as components: `CensusCurve.graduate()` minted V3, fee
splits were 25/75, reflections and the 3-asset basket were absent, and frontend/indexer/keeper decoded only the V3
`Graduated` topic. It also fixed four contained items that remain in place: indexer USD pricing fails closed
(nullable fields + migration, no hardcoded ETH price), test harnesses exit non-zero on failure, the obsolete Base
fork suite is retired in favour of pinned Robinhood forks (`AUDIT_FORK_BLOCK`), a frontend release gate was added,
and non-major locked dependency upgrades were applied. Evidence: `audit/readiness-2026-09-22-*.log` (without the
`-v4-` infix) and `audit/release-day-2026-09-22.patch`.
