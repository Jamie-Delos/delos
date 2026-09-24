# Optional creator buy: release handoff

The Economics step accepts a creator buy in the launch's pairing asset. An empty field uses the existing `createLaunch` call and buys **zero** tokens. A positive amount uses `createLaunchWithDevBuy`: token creation and the creator's purchase are atomic, and a capped final fill returns unused quote to the creator. The creator sees an estimated token count and percentage of the fixed 1B supply before signing. The actual buy pays the normal 2% base fee plus any selected holder reflection. The creator's initial buy uses the curve's launch-window exemption, as creator buys already do in the current curve.

This code is **not activated on mainnet** by a frontend build alone. The current deployed factory is immutable. Keep `VITE_FACTORY_V4_DEV_BUY` unset until all of the following have been completed and independently reviewed:

1. Verify the exact Robinhood mainnet chain ID (4663), current `CensusCurveV4`, WETH, V4 router, quote swap router, swap fee, and allowance-holder addresses against the existing deployment record and on-chain getters. Retain the existing factory for launches without a creator buy.
2. Deploy a fresh `CensusRewardVaultDeployer`, then a `LaunchFactoryV4` with the verified addresses and the new vault deployer. The vault deployer is one-time bound, so the old one cannot serve this factory.
3. From the new vault deployer's owner, call `setLaunchFactory(newFactory)` exactly once. From the **existing curve's deployer**, call `setFactory(newFactory, true)`. Check both resulting getters on-chain. Do not revoke the old factory; existing no-buy launches still use it.
4. Verify the new source and constructor arguments on Blockscout. Rehearse an ETH creator buy and an empty creator buy against the actual deployed stack with small amounts. For a quote-token buy, check the wallet's token approval, purchase, refund, and balances.
5. Set `VITE_FACTORY_V4_DEV_BUY` to the verified new factory on the website deployment. The UI fails closed for positive creator buys until it is set; clearing the field allows an ordinary launch. The board scans both factory addresses so old and new coins remain visible.

The contract suite includes atomicity, fee allocation, refund, holder reflection, and no-buy tests (`npm run test:v4`). The frontend estimate is compared directly to on-chain token output in the tests. Production deployment and on-chain activation require separate operational approval; neither is performed by building or pushing this branch.
