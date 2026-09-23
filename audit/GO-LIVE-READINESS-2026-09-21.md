# Census go-live readiness — 21 September 2026

**Decision: NO-GO for the agreed V4 product. Do not deploy the current scripts expecting V4, the new fee splits or the three-asset reflection model.**

Scope: local `codex/v4-fee-migration`, based on `2ca17a0611bc70a4a19d8bb4cd01d4e832af2cd8`, including uncommitted V4 implementation and readiness tests. Fetched `origin/main` at `ee4ac67`: its only intervening change is 12 integration-document files, not executable code. This is a readiness assessment, not a claim that all vulnerabilities have been excluded.

Robinhood Chain (4663) was used because it is the repository's current mainnet target. A different target requires its own network rehearsal. No public-chain transaction, deployment, remote push, or production service mutation was performed.

## Release blockers, in execution order

| Priority | Blocker and evidence | Required closure |
|---|---|---|
| P0 | **The deployed product would still be V3 with old economics.** `contracts/scripts/deploy.js:10` sets 25% protocol; lines 72–85 deploy the legacy curve/factories. `CensusCurve.sol:47` still uses 25/75 on curve, and `graduate()` still calls the V3 position manager. The frontend defaults to the V3 1% pool tier (`frontend/src/config.ts`). | Wire a production V4 curve/factory/deployment path. Prove 2% buy/sell, 90/10 Census/creator on curve and 30/70 after graduation using the actual launch entry point and UI. Preserve PF virtual reserves, refunds and 1B real supply. |
| P0 | **The requested holder rewards are not implemented end to end.** V4 fees accrue to a beneficiary address; this is not a three-asset proportional holder distribution. Browser launch form still selects up to four stocks and allocates the creator's existing fee share (`frontend/src/pages/Launch.tsx:558,644`). | Independent 0% or 1–4% surcharge; immutable basket of up to three supported assets/weights; launch-token and quote-token modes; conversion, claims and transfer checkpoint tests. Do not reuse `convertLaunchFees()` without protecting launch tokens already reserved for claims. Exclude PoolManager and other custody balances before transfers. |
| P1 | **Application services still understand V3 pools/NFTs.** No production V4 integration in frontend, indexer or keeper. The new V4 router is ERC20 exact-input only; it is not connected to the app. | V4 pool IDs and events, net-of-fee quotes, routing, wrap/unwrap UX, keeper collection/distribution, profile claims/history, canonical venue display, and user fee breakdown. Update Sumo/Ghost integration packets before partners implement the obsolete path. |
| P1 | **Price and fee liveness need completion.** V4 has no replacement wired for the current V3 TWAP. `CensusV4Hook.sol:79` rejects all swaps if an additional Uniswap protocol fee is enabled. | Implement manipulation-resistant pricing/keeper conversion bounds; resolve and test the protocol-fee liveness policy. Exact-output and partial-fill restrictions must be understood by routers and UI. |
| P1 | **A clean frontend build is not deployment-configured.** Local build has no Census factory/curve/locker, quoter, indexer or Privy environment values. It renders empty markets rather than proving a usable release. `indexer/src/config.ts:18` defaults ETH/USD to 3000, and `ingest.ts:83,242` values other quotes at zero. | Versioned, chain-validated deployment manifest; verified V4 addresses and CREATE2 hook deployment; real pricing feeds; configured indexer/API/keeper. Validate the final production-configured bundle, not only a default build. |
| P1 | **Security/operations approvals are not evidenced here.** The prior GATES document still contains treasury/keeper custody, incident response, monitoring, RPC fallback, KV/spend limits and legal/privacy requirements. | Team provides deployment custody and operational evidence; check real permissions/configuration, backup restore, alert delivery and outage behavior. No assumption that an old audit's code fixes close these gates. |
| P2 | **Hidden failing legacy fork suite.** Enabling `test/integration.fork.test.js` fails at line 49: obsolete three-argument `LaunchFactory` constructor. Its two test bodies never execute. | Replace with the current lifecycle or explicitly retire it and retain current target-chain coverage. Do not count skipped cases as verified. |
| Review | **Published dependency advisories remain.** Frontend runtime tree: 4 high + 29 moderate entries; full contracts tooling tree: 23 high + 11 moderate + 18 low. These counts include transitive/parent entries, not that many proven exploitable application bugs. | Assess reachable paths and make targeted locked upgrades with regression tests. No automatic major-version `audit fix --force`. Indexer and bot runtime scans returned zero reported advisories. |

## Checks completed

| Check | Result and limits |
|---|---|
| Contract regression suite | **107 passing, 4 pending** in the final local run, recorded in `readiness-2026-09-21-contracts.log`. Two pending Robinhood fork cases were run separately and passed; the two pending legacy Base cases fail at suite setup when enabled. Includes 98 existing local cases and nine V4 cases. |
| Legacy curve workload | 500 deterministic mixed buy/sell operations across 10 actors pass in the contract suite. This is local accounting/gas validation, not chain throughput certification. |
| PF lifecycle rehearsal | All three existing V3 modes pass: buys, sells, final-fill refund, graduation, subsequent pool trades, fee collection and holder distribution. Updated `BONDING-LIFECYCLE-RESULTS.*` are generated by the rehearsal. These use OLD economics. |
| Contract/indexer parity | 121 real curve trades plus separate Prima and Maxima launch-tax event exports match indexer reserves, fee handling, price and supply. |
| V4 fee/authorization components | Both token orderings, both swap directions, independent routers, 2% + 4% fee collection, exact-input/minOut/deadline checks, unauthorized callbacks/registration, reserve mismatch rollback, claims and protocol-fee rejection pass. |
| V4 launch-window integration | Same-block graduation and buy charges 99% total with 4% reflection preserved. At elapsed seconds 1, 2 and 3, totals are 12.18%, 6.19% and 6%. This preserves the existing decay plus surcharge; it is not a fixed 99% rate for all three seconds. |
| V4 realistic reserves | Fixed 1B-supply token and approximately 214M tokens/4 quote units in permanent liquidity; both six- and eighteen-decimal quote variants graduate, buy, sell and reconcile balances. The curve caller is simulated: this does not close the missing production-curve integration. |
| V4 workload | 500 mixed swaps across 10 wallets; independent fee ledger, receiver balance changes, periodic claims, final total-supply/custody reconciliation. Targeted run: 5,937ms, max gas 279,830. Sequential local test, not TPS or MEV certification. |
| V4 adversarial assets | Taxed input settlement reverts atomically; a blocked creator's claim remains backed and does not stop trading or another beneficiary's claim. Broad arbitrary-token support is not implied. |
| Robinhood V3 fork | PASS at block **69078436**: current factory launch, curve trade, dividend, graduation and post-graduation trade against actual V3 dependencies; all transactions local. |
| Robinhood V4 fork | PASS at block **69082016**: new hook registration, graduation, buy, sell and fee claim against the actual deployed PoolManager; all deployments/transactions local. This tests V4 components, not the missing app/factory/reward integration. |
| Indexer build / in-memory tests | Build passes. 10,000 unique + 1,000 duplicate events, failure rollback, replay, reorg/hash rejection, adaptive paging; API validation/rate-limits pass. |
| Real PostgreSQL | Migrations on five fresh databases; concurrent workers exactly once; RPC-failure recovery; hard-kill/WAL recovery; logical restore; 10,000 unique + 1,000 duplicates in 40,033ms; 1,000 API requests at concurrency 50 in 1,065ms. Uses deterministic mock chain and in-process HTTP injection. Production network latency, provider limits and `pg_dump` restore remain untested. |
| Keeper | Readiness suites pass: dry-run does not sign; nonce/replacement/pending recovery; restart/state lock; signer floor; authority checks; mocked alert delivery and RPC pagination. Real custody, monitoring/webhooks and V4 wiring are not verified by mocks. |
| Frontend build | TypeScript + production Vite build pass with locked dependencies. Bundle warning remains: Privy chunk ~1.97MB uncompressed / 564kB gzip. |
| API/user input | Metadata authorization 23 checks; upload authorization 18 checks; 0x endpoint/chain/rate-limit assertions; name validation 10 checks all pass. Local mock services, not hosted KV/Blob/Privy verification. |
| Browser smoke | Production build at loopback: landing, companies, market, disconnected profile, paper, and launch Company → Anchors → Economics render. Empty-name continuation is disabled; selecting a basket unlocks continuation. Confirmed OLD four-stock/creator-share model. Paper is “Coming soon.” With the Census curve address unset, a non-coin address renders an “Unknown token” trading shell showing “Fee (1%)” alongside “Trade fee 2%”; release configuration and fee presentation need fail-closed handling. No wallet-funded browser transaction or populated profile/reward end-to-end test was possible without integration/deployment configuration. Temporary audit tab and preview server were closed. |
| Build integrity | Legacy frontend creation bytecode matches compiled LaunchToken; existing EIP-170 size checks pass. New V4 sizes rechecked: hook 5,743; router 3,420; graduator 7,520 bytes. |

## External dependency verification

Official [Uniswap V4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments) list Robinhood Chain 4663. Read-only RPC checks at block **69078172** returned chain ID 4663 and non-empty code:

| Contract | Address | Code bytes |
|---|---|---:|
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | 24,009 |
| Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | 6,118 |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | 3,531 |

Code presence alone is not bytecode/source equivalence. The separate fork test establishes the exercised PoolManager operations work with these components. Quoter/StateView app integration, routing-provider compatibility and alternate-RPC behavior remain open.

Independent external LPs can still bypass the Census hook. The local regression suite demonstrates external-pool fee bypass for freely transferable tokens. V4 canonical-pool enforcement does not eliminate that economic limitation.

## Re-run

- `contracts/`: `npm test`, `npm run test:v4`, `npm run rehearse:bonding`, `node scripts/exportTokenBytecode.js --check`.
- Set `AUDIT_MAINNET_FORK=1` and run `npx hardhat test test/backend.mainnet-fork.test.js --network hardhat` for the current V3 fork test.
- Set `AUDIT_V4_FORK=1` and run `npx hardhat test test/v4.readiness.test.js --grep "V4 Robinhood fork" --network hardhat` for the V4 component fork test.
- `indexer/`: `npx prisma generate`, `npm run build`, `npm test`, `npm run test:pg`, `node pf.parity.cjs`.
- `bot/`: `npm test`.
- `frontend/`: `npm run build`, then the API bundle/test commands in `.github/workflows/backend.yml`.

The final release must be one pinned commit plus a verified deployment manifest, with the complete flow tested again: create both launch types → ordinary and launch-window buys/sells → capped final fill → V4 graduation → direct and routed swaps → reward conversion → transfers → holder claims → profile/indexer reconciliation → restart and failure recovery.
