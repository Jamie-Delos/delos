# Census V4 mainnet deploy runbook (CensusCurveV4 + Uniswap V4 stack)

Target: Robinhood Chain mainnet, chainId 4663. This deploys the V4 product every NEW launch uses:
FeeSplitter (treasury) -> CensusCurveV4 -> CensusV4Graduator -> CensusV4Hook (CREATE2, mined salt) ->
CensusV4Router -> CensusRewardVaultDeployer -> LaunchFactoryV4. Legacy V3 launches keep their existing
contracts; nothing here migrates or touches them.

Economics baked into the contracts (verified by `contracts/test/v4.lifecycle.test.js`):
- 2% base fee on every buy and sell (curve and canonical V4 pool).
- On the curve 90% Census / 10% creator; after graduation 30% Census / 70% creator (the hook).
- Optional 1-4% holder reflection on top, paid to the launch's CensusRewardVault as up to three QUOTED
  assets: the pairing asset and/or tokenised stocks listed on-chain (never the coin itself). Frozen per launch;
  the stock list is extended later with `curve.setRewardAssetAllowed(stock, true)` from the deployer, with no
  contract change.
- 3-second anti-snipe penalty (99% at the launch second, 618 bps at +1s, 19 bps at +2s), capped so the
  combined charge never exceeds 99%; creator and declared bundle wallets exempt.
- 1B real supply, PF-style virtual reserve, capped final fill with refund, permanent full-range V4 liquidity.

## Verified Uniswap V4 on Robinhood Chain (official deployment list; code presence checked 2026-09-21)
| Contract | Address |
| --- | --- |
| PoolManager | 0x8366a39cc670b4001a1121b8f6a443a643e40951 |
| V4Quoter | 0x8dc178efb8111bb0973dd9d722ebeff267c98f94 |
| StateView | 0xf3334192d15450cdd385c8b70e03f9a6bd9e673b |
| WETH | 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 |
| SwapRouter02 (V3, only for the HOOD ETH-zap and stock routes) | 0xCaf681a66D020601342297493863E78C959E5cb2 |

Re-verify before deploying: `cast code`/Blockscout on each address, and the fork rehearsal below.

## 1. Rehearse locally and on a fork (no funds)
```
cd contracts
npm ci && npx hardhat compile && node scripts/exportTokenBytecode.js --check
npm run test:v4                                   # 21 local cases incl. the full lifecycle
AUDIT_V4_FORK=1 npx hardhat test test/v4.lifecycle.fork.test.js --network hardhat   # against the official PoolManager
npm run deploy:v4:local                           # script rehearsal; writes deployments.v4.hardhat.json
```
Pin a fork block for a reproducible run with `AUDIT_FORK_BLOCK=<block>`.

## 2. Deployer, treasury, keeper (mainnet gates G1-G3)
- Dedicated mainnet deployer key in `contracts/.env` (`PRIVATE_KEY`), funded with ~0.02 ETH (the hook
  deployment plus seven contracts; salt mining is off-chain).
- `FEE_SPLIT_A`, `FEE_SPLIT_B` (+ optional `_BPS`): the immutable FeeSplitter legs (multisig/treasury).
  The script REFUSES a mainnet run without them. The treasury address becomes `platform` on the curve and
  `protocol` on the hook and graduator, and cannot be changed later.
- `KEEPER_ADDRESS`: the keeperd signer (HSM/multisig-backed). Required on mainnet.
- Optional `ALLOWED_QUOTES=<HOOD>` and the zap route env (`ZAP_QUOTE`, `ZAP_MIDS`, `ZAP_FEES`) if HOOD-quoted
  launches are offered at cutover.
- `REWARD_ASSETS=<stock1>,<stock2>,...`: the tokenised-stock contract addresses creators may put in reward
  baskets. The script checks each has code. Add more at any time later: `curve.setRewardAssetAllowed(addr, true)`.

## 3. Deploy
```
cd contracts
FEE_SPLIT_A=0x... FEE_SPLIT_B=0x... KEEPER_ADDRESS=0x... npm run deploy:v4:robinhood
```
The script mines the hook salt (address low 14 bits = 0x20cc), deploys through the owner-only
CensusHookDeployer, checks `hook.registrar() == graduator`, `hook.protocol() == treasury`, wires
graduator <-> hook <-> curve, binds the vault deployer to the factory, authorises the factory, registers the
keeper, asserts `FEE_BPS == 200` and `CURVE_PROTOCOL_BPS == 9000`, and writes `deployments.v4.robinhood.json`
(commit it: G11). It prints the frontend/indexer/keeper variables.

## 4. Verify on Blockscout
```
npx hardhat verify --network robinhood <address> <constructor args from deployments.v4.robinhood.json "verify">
```
for every entry in `verify` (the hook's constructor args are `[PoolManager, graduator, treasury]`).

## 5. Cut the site over
`frontend/.env` (production): the V4 set printed by the script plus
`VITE_STATE_VIEW=0xf3334192d15450cdd385c8b70e03f9a6bd9e673b`, `VITE_V4_QUOTER=0x8dc178efb8111bb0973dd9d722ebeff267c98f94`,
`VITE_INDEXER_URL=https://...`, `VITE_FROM_BLOCK=<factory deploy block>`. Then:
```
cd frontend && npm ci && npm run release:check && npm run build
```
`release:check` must print "configuration complete"; it fails closed on any missing V4 address.

## 6. Indexer and keeper
- Indexer `.env`: `CURVE_V4_ADDRESS`, `FACTORY_V4_ADDRESS`, `POOL_MANAGER_ADDRESS`, `HOOK_ADDRESS`, `ETH_USD`
  (and `QUOTE_USD` for HOOD) from a verified source; `START_BLOCK=<factory deploy block>`.
- Keeper `.env`: the same addresses plus `V4_ROUTER_ADDRESS`, `V4_QUOTER_ADDRESS`, `DRY_RUN=true` first.
  The curve's `keeper()` must equal the keeper signer (set by the deploy script from `KEEPER_ADDRESS`).

## 7. Smoke test (real funds, small)
1. Launch a coin with reflection 2% and basket [ETH 40%, a listed stock 60%] through the UI; confirm the
   `...c0de` address matches the prediction.
2. Buy 0.01 ETH after the window: `FeeAllocated` shows 0.00018 to the treasury and 0.00002 to the creator,
   0.0002 to the vault.
3. Do NOT force a graduation with real funds unless the team decides to fund the 4 ETH target.

## Rollback / safety
Contracts are immutable. If a wiring assertion fails the script aborts before the factory is authorised,
so nothing can launch on a half-wired stack. A broken deployment is abandoned (redeploy a fresh stack); the
frontend only knows the addresses in its env.
