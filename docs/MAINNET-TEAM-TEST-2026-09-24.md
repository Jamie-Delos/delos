# Mainnet team test handoff — 2026-09-24

This is a **temporary Robinhood mainnet stack** for team testing before the final multisig deployment. Transactions spend real ETH and create permanent tokens and pools. The website may later stop listing these coins, but switching its contract addresses will not move balances, pools, liquidity or fee claims. Keep control of the temporary deployer/keeper wallet until all outstanding duties and claims are handled.

Sites:
- https://ember-run-swart.vercel.app — Neil's test preview.
- https://www.census.fund — public domain during the team-test phase, visibly labelled and `noindex`.

Both target chain `4663` and the same temporary V4 curve. The 0.02 ETH rehearsal UI setting has been retired. Prima graduates at 4 ETH; Maxima offers 4 or 8 ETH. A full graduation test requires funding that target with real assets and permanently seeds its V4 pool.

Contracts:
- Existing launch factory (empty creator-buy field): `0x3776FBA3b9a7C47fAd1d66a5223c73590d07278b`
- Optional creator-buy factory: `0xc37b600F1079B88C7c077f607Fad7aee095Cb653`
- Curve: `0xD1300ccE1Ed4c778791cF713b6bA47FE32B217C3`
- V4 hook: `0xCaA6477f3116126ebD4A7f03B2B7631c70cF20cC`
- New reward vault deployer: `0x42F3dAeceeAb6EcA6Ca3dC400594735a87E4F338`

The new factory was deployed, bound to its vault deployer and [authorized on the curve](https://robinhoodchain.blockscout.com/tx/0x6407be5364a8feac21feeef6e35c657083d6fbe49992b253927d305768acb02b). Read-only on-chain checks confirmed chain, code presence, factory authorization, fee constants, curve/registrar/hook/router wiring and treasury consistency. A mainnet `eth_call` simulated launch plus 0.001 ETH creator buy successfully; it did not create a coin. Local V4 tests: 31 passing, one optional fork test skipped. Frontend type-check and build passed. Both live bundles were checked for the new factory address; only census.fund has the team-test banner.

Known scope limits for Coolio's test:
- The optional creator buy is blank by default and buys zero; a positive value buys atomically with creation. Standard 2% plus any selected holder reflection applies. Curve and post-graduation fee checks remain worth repeating with actual transaction receipts.
- `VITE_INDEXER_URL` is not configured on the temporary deployment. The board scans chain events from the configured start block via RPC, so a website load test is also testing RPC capacity, not a production indexer.
- The curve has a keeper address, but this deployment did not establish or verify a continuously running keeper daemon. Holder-reflection distribution/claim timeliness requires that separate check.
- The final multisig cutover needs a new production contract deployment and Vercel configuration. Old test coins stay on this temporary mainnet stack even if the website stops listing them.
