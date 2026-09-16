# Census Mainnet Deploy Runbook (CensusCurve stack)

Target: Robinhood Chain mainnet, chainId 4663. This deploys the bonding-curve stack (FeeVault,
LaunchLocker, CensusCurve, LaunchFactory, LaunchFactoryV2) and cuts the site over to mainnet.

Status of prep (2026-09-09):
- Contracts compile; curve + factories tested (10/10) and testnet-proven.
- Mainnet Uniswap V3 addresses verified on-chain (NPM.factory() and Router.factory() both equal the
  Factory; WETH confirmed). Pinned in `contracts/uniswap.robinhood.json`.
- deploy.js is mainnet-ready (reads that address book).
- Gas price ~0.2 gwei; a full deploy is ~0.003 ETH.

Blocking gate:
- The deployer has 0.0 ETH on mainnet. Fund it before deploying (see step 1).

## Verified mainnet Uniswap V3 (for the graduated pools)
| Contract | Address |
| --- | --- |
| UniswapV3Factory | 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA |
| NonfungiblePositionManager | 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3 |
| SwapRouter02 | 0xCaf681a66D020601342297493863E78C959E5cb2 |
| WETH | 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 |

## 1. Deployer key and funding
- Decide the mainnet deployer. Right now `contracts/.env` PRIVATE_KEY resolves to
  0xEAd2f7477e5c629920f1E337FEb738ff0330e7a9 (the testnet wallet). Recommended: use a fresh, dedicated
  mainnet key (this one has been on disk for testnet). Put it in `contracts/.env` as PRIVATE_KEY.
- Fund that address with mainnet ETH. ~0.01 ETH covers the deploy plus a smoke-test launch and buy with
  buffer. (Testing real graduation needs ~4 ETH of buys, which is real money; not required for launch.)

## 2. Confirm the launch economics (frontend curve params)
The deploy does not bake curve economics; they are set per launch by the frontend. Confirm before cutover:
- `frontend/src/config.ts` START_FDV_ETH (currently 1.5) = the curve's starting FDV in ETH terms.
- Graduation target ETH (the wizard's Economics step) and the graduated-pool fee tier (`poolFee`).
- FeeVault recipient = the deployer (see deploy.js); change if the platform-fee wallet should differ.

## 3. Preflight (read-only)
```
cd contracts
npx hardhat run scripts/preflight.js --network robinhood      # prints deployer + balance; balance must be > ~0.01 ETH
node ../.../scratchpad/verifyMainnetUni.mjs                    # re-verify Uniswap addresses (optional; already PASS)
```

## 4. Deploy
```
cd contracts
npx hardhat run scripts/deploy.js --network robinhood
```
Writes `contracts/deployments.robinhood.json` and prints the VITE_ block. Record the addresses
(including `DividendVaultDeployer`, created by `LaunchFactoryV2`'s constructor).

**Enable every anchor the frontend offers (required).** Only WETH is allowed as quote collateral at
construction. The wizard offers HOOD, so a fresh deployment MUST allow it or every HOOD-anchored launch
reverts with `QuoteNotSupported`:
```
ALLOWED_QUOTES=0x32ac8c1d7672667d5ebdea22935f7b06fc8d496f npx hardhat run scripts/deploy.js --network robinhood
# or post-deploy, as the deployer: curve.setQuoteAllowed(HOOD, true)
```
Review a token's transfer/rebase/freeze behaviour before allowing it; the allowlist gates NEW launches only.

**Register the platform keeper (required for automatic rewards).** Every Maxima vault accepts the
address in `curve.keeper()` as a distribution operator in addition to the coin's creator, which is what
lets `bot/src/keeperd.js` convert LP fees and distribute/push rewards for every launch:
```
KEEPER_ADDRESS=<keeperd signer address> npx hardhat run scripts/deploy.js --network robinhood
# or later / to rotate, as the deployer: curve.setKeeper(<address>)
```
Without it the keeper only collects LP fees and pushes already-distributed rewards.

**Post-launch levers (deployer-only, all emit events):** `curve.sweepMigrationDust(coin)` moves a
graduated coin's recorded migration leftovers to the platform; `curve.setRecoveryMaxSpendBps(coin, bps)`
(≤ 5000) widens ONE coin's bounded recovery swap if parked liquidity keeps its graduation reverting;
`curve.withdrawDeferredFee(quote, recipient)` (permissionless) pushes fee shares that were deferred
because the recipient was blocked at trade time.

**Enable the HOOD one-tap ETH zap (optional, mainnet-only).** So buyers can one-tap ETH into a HOOD-quoted
coin (curve wraps ETH→WETH, swaps WETH→HOOD, buys; sell reverses it). HOOD has **no direct WETH pool** — its
liquidity is HOOD/USDG (1% pool `0x1c1f6e283a72a68c15c816324363c794151cf913`) — so the zap routes
**WETH→USDG→HOOD** via a Uniswap V3 multi-hop path. Confirm the WETH/USDG pool's fee tier, then deploy with:
```
ZAP_QUOTE=0x32ac8c1d7672667d5ebdea22935f7b06fc8d496f \
ZAP_MIDS=0x5fc5360d0400a0fd4f2af552add042d716f1d168 \
ZAP_FEES=<WETH/USDG tier>,10000 \
npx hardhat run scripts/deploy.js --network robinhood
```
(`ZAP_FEES` is one fee tier per hop: WETH→USDG, then USDG→HOOD=10000. Or call `curve.setZapPath(HOOD, pathIn,
pathOut)` post-deploy as the deployer — deployer-only, idempotent, paths are `abi.encodePacked` token/fee/…/token.)
Without this, HOOD coins still trade, but buyers must already hold HOOD. The `frontend` one-tap-ETH UX +
ETH→HOOD quoting for HOOD coins is wired at cutover (needs the live pool to quote against; test with a small real buy).

## 5. Verify on Blockscout
For each contract, using the constructor args from `deployments.robinhood.json` (the `verify` block):
```
npx hardhat verify --network robinhood <FeeVault>       <deployer>
npx hardhat verify --network robinhood <LaunchLocker>   <NPM> <FeeVault> 2500
npx hardhat verify --network robinhood <CensusCurve>    <NPM> <FeeVault> <LaunchLocker> <SwapRouter02>
npx hardhat verify --network robinhood <LaunchFactory>  <WETH> <CensusCurve>
npx hardhat verify --network robinhood <LaunchFactoryV2> <WETH> <CensusCurve> <SwapRouter02> 3000 0x0000000000001fF3684f28c67538d4D072C22734
npx hardhat verify --network robinhood <DividendVaultDeployer>
```

## 6. Cut the site over to mainnet
- Set the mainnet VITE_ config (Vercel project env, or `frontend/.env` for a prebuilt build):
  ```
  VITE_CHAIN_ID=4663
  VITE_RPC_URL=https://rpc.mainnet.chain.robinhood.com
  VITE_FACTORY_ADDRESS=<from deploy>
  VITE_FACTORY_V2_ADDRESS=<from deploy>
  VITE_LOCKER_ADDRESS=<from deploy>
  VITE_CURVE_ADDRESS=<from deploy>
  VITE_WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
  VITE_SWAP_ROUTER=0xCaf681a66D020601342297493863E78C959E5cb2
  ```
- Provision Vercel KV so launch metadata (thesis/description/logo) persists (KV_REST_API_URL +
  KV_REST_API_TOKEN on the census project); until then metadata degrades to null.
- Redeploy the frontend:
  ```
  cd frontend
  vercel pull --yes --environment production --token <token>
  vercel build --prod --token <token>
  vercel deploy --prebuilt --prod --token <token>
  ```

## 7. Smoke test (mainnet)
```
cd contracts
npx hardhat run scripts/launch.js --network robinhood         # launches a Prima coin; note the token address
COIN=<token> npx hardhat run scripts/curveProof.js --network robinhood   # small curve buy; confirm fee to FeeVault
```
Then open the live site and confirm the coin shows on the board and the coin page (curve trading + 2% fee,
graduation progress).

## 8. Indexer (when the server + Postgres are available)
Deploy `indexer/` with the mainnet CURVE_ADDRESS + a dedicated RPC + Postgres, then set
`VITE_INDEXER_URL` on the frontend and redeploy. Until then the board reads the chain directly (fine at
low volume).

## Rollback / safety
- Deploys are additive; a failed run wastes gas but leaves nothing wired to the site (the site only
  points at addresses you set in step 6). Re-run deploy.js to get a fresh set.
- Liquidity locking and fees are on-chain and immutable once launched. Do a real launch only after the
  smoke test passes.
