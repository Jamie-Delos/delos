# Graduated trading and payment assets

The coin screen retained its curve venue after a filling buy. It now refreshes registration after a trade, watches graduation by other traders, and rechecks the venue before signing. A missing canonical pool ID read fails closed. Pool trades require a real V4Quoter result; spot prices are display-only.

ETH and WETH are selectable for WETH-anchored launches. Post-graduation ETH buys wrap, approve if needed, then use the deployed Census router. Sellers can keep WETH or confirm unwrapping exactly the proceeds recorded by the router. These are separate wallet transactions. Submitted trade hashes persist through a confirmation timeout; users check the existing transaction before placing another trade.

Other-token funding is an explicit conversion followed by a separately reviewed purchase. Standard same-network ERC20s are quoted through available Uniswap V3 direct paths or paths via USDG. The best quoted output is selected, conversion fees are displayed, and conversion has a 1% minimum-output tolerance. No route means no conversion. This is not universal token/chain support or an atomic aggregator: the user needs ETH for gas, and converted WETH remains in the wallet if the Census purchase is cancelled. Census fees still apply to the subsequent canonical trade.

## Validation

- Frontend typecheck/build, trading regressions, anchor/launch regressions and 62 release-check tests passed.
- Read-only mainnet quotes using the frontend helpers confirmed HHJ buys/sells and a USDG-to-WETH route.
- Local Hardhat fork of deployed mainnet HHJ at block 70932628: wrap ETH, buy, sell, unwrap, and V3 USDG conversion passed. Both Census trade directions charged 2%, with 30% protocol / 70% creator; reflection was off. A 0.001 ETH round trip returned 0.0009604 ETH before gas. No live transaction was broadcast by these tests.
- Run `npm run test:trading` in frontend. Run the deployed-state fork with `CENSUS_DEPLOYED_FORK=1 npx hardhat test test/v4.deployed-trading.fork.test.js --network hardhat --no-compile` in contracts. Optionally set `CENSUS_FORK_BLOCK` with an archive-capable RPC; the public RPC may prune old state.

Uniswap Labs routing is independent of this fix. Its classic router supports allowlisted hooks; UniswapX depends on fillers. A deployed Census pool is not proof that the Labs website will route to it. See https://support.uniswap.org/hc/en-us/articles/33829289869965-How-do-custom-hooks-work-in-the-Labs-interface.

These checks do not constitute a complete launch-readiness audit, a connected-wallet browser test, or a new contract deployment. The Hobby rehearsal continues using mainnet rehearsal contracts with the 0.02 ETH target.
