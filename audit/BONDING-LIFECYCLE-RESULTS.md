# Bonding lifecycle rehearsal

Executed 2026-09-17T10:32:51.450Z against implementation d13f3d03f68ec6bd5a1c1c032208c60ad69a143f.
All transactions used fake funds on an isolated local chain with actual Census and Uniswap V3 bytecode. No public-chain transactions.
This tests contract behavior, not browser UX, live issuer assets, external routing, or production infrastructure.

Each scenario uses 1B supply, 1.5 ETH virtual quote, 4 ETH net graduation target, a 2% curve fee, and a 1% pool fee. Rewards use WETH.
Venue quote balances include uncollected LP fees after graduation. FDV is marginal spot price times 1B supply, not cash raised. Amounts below are rounded; JSON contains transaction hashes and more precision.

## Prima

| Transaction / stage | Venue quote balance (ETH/WETH) | FDV (ETH) |
| --- | ---: | ---: |
| Launch | 0 | 1.38843 |
| Alice buys with 1 ETH | 0.98 | 3.795288 |
| Bob buys with 0.75 ETH | 1.715 | 6.378277 |
| Alice sells 25% of her tokens | 1.153208 | 4.343942 |
| Bob buys with another 1.25 ETH | 2.378208 | 9.281189 |
| Carol submits 10 ETH; final fill plus refund | 4 | 18.666667 |
| Graduation: liquidity deposited and NFT locked | 4 | 18.666667 |
| Dave buys in pool with 0.25 ETH | 4.25 | 21.048132 |
| Alice sells 30% of remaining tokens in pool | 2.889526 | 9.724071 |
| Bob buys in pool with 0.6 ETH | 3.489526 | 14.137131 |
| Dave sells half his pool purchase | 3.404288 | 13.453268 |
| LP fees collected and split | 3.395788 | 13.453268 |
| Final balances reconciled | 3.395788 | 13.453268 |

Final curve buy: 1.65489 ETH accepted, 8.34511 ETH returned. Graduation price change: 0.000e+0%.
LP fee collection: 0.0085 WETH and 1,022,991.158309 launch tokens.

- PASS: No wallet/buy caps; launch fee starts at 99% and expires after three seconds
- PASS: Premature graduation rejected
- PASS: Final buy stops at 4 ETH net and refunds excess; further curve buys rejected
- PASS: Graduation preserves marginal price, locks LP NFT, disables curve trades and cannot repeat
- PASS: Four real V3 swaps execute both ways; buys raise and sells lower the marginal price
- PASS: Both LP fee assets split exactly: Census 25%, remaining 75% by holder allocation
- PASS: Supply remains exactly 1B and all tokens/reserves reconcile after every recorded stage

## Maxima: all creator-side fees to holders

| Transaction / stage | Venue quote balance (ETH/WETH) | FDV (ETH) |
| --- | ---: | ---: |
| Launch | 0 | 1.38843 |
| Alice buys with 1 ETH | 0.98 | 3.795288 |
| Bob buys with 0.75 ETH | 1.715 | 6.378277 |
| Alice sells 25% of her tokens | 1.153208 | 4.343942 |
| Bob buys with another 1.25 ETH | 2.378208 | 9.281189 |
| Carol submits 10 ETH; final fill plus refund | 4 | 18.666667 |
| Graduation: liquidity deposited and NFT locked | 4 | 18.666667 |
| Dave buys in pool with 0.25 ETH | 4.25 | 21.048132 |
| Alice sells 30% of remaining tokens in pool | 2.889526 | 9.724071 |
| Bob buys in pool with 0.6 ETH | 3.489526 | 14.137131 |
| Dave sells half his pool purchase | 3.404288 | 13.453268 |
| LP fees collected and split | 3.395788 | 13.453268 |
| Holder token-fees converted to WETH | 3.385599 | 13.372664 |
| Final balances reconciled | 3.385599 | 13.372664 |

Final curve buy: 1.65489 ETH accepted, 8.34511 ETH returned. Graduation price change: 0.000e+0%.
LP fee collection: 0.0085 WETH and 1,022,991.158309 launch tokens.
Rewards pushed: 0.053427 WETH before graduation; 0.041372 WETH in the later batch (includes the final curve buy plus collected LP revenue).

- PASS: No wallet/buy caps; launch fee starts at 99% and expires after three seconds
- PASS: Premature graduation rejected
- PASS: Final buy stops at 4 ETH net and refunds excess; further curve buys rejected
- PASS: Graduation preserves marginal price, locks LP NFT, disables curve trades and cannot repeat
- PASS: Four real V3 swaps execute both ways; buys raise and sells lower the marginal price
- PASS: Both LP fee assets split exactly: Census 25%, remaining 75% by holder allocation
- PASS: Keeper converts token fees, distributes backed WETH, pushes rewards; repeated claim pays zero
- PASS: Supply remains exactly 1B and all tokens/reserves reconcile after every recorded stage

## Maxima: creator/holders split equally

| Transaction / stage | Venue quote balance (ETH/WETH) | FDV (ETH) |
| --- | ---: | ---: |
| Launch | 0 | 1.38843 |
| Alice buys with 1 ETH | 0.98 | 3.795288 |
| Bob buys with 0.75 ETH | 1.715 | 6.378277 |
| Alice sells 25% of her tokens | 1.153208 | 4.343942 |
| Bob buys with another 1.25 ETH | 2.378208 | 9.281189 |
| Carol submits 10 ETH; final fill plus refund | 4 | 18.666667 |
| Graduation: liquidity deposited and NFT locked | 4 | 18.666667 |
| Dave buys in pool with 0.25 ETH | 4.25 | 21.048132 |
| Alice sells 30% of remaining tokens in pool | 2.889526 | 9.724071 |
| Bob buys in pool with 0.6 ETH | 3.489526 | 14.137131 |
| Dave sells half his pool purchase | 3.404288 | 13.453268 |
| LP fees collected and split | 3.395788 | 13.453268 |
| Holder token-fees converted to WETH | 3.390686 | 13.412876 |
| Final balances reconciled | 3.390686 | 13.412876 |

Final curve buy: 1.65489 ETH accepted, 8.34511 ETH returned. Graduation price change: 0.000e+0%.
LP fee collection: 0.0085 WETH and 1,022,991.158309 launch tokens.
Rewards pushed: 0.026713 WETH before graduation; 0.020683 WETH in the later batch (includes the final curve buy plus collected LP revenue).

- PASS: No wallet/buy caps; launch fee starts at 99% and expires after three seconds
- PASS: Premature graduation rejected
- PASS: Final buy stops at 4 ETH net and refunds excess; further curve buys rejected
- PASS: Graduation preserves marginal price, locks LP NFT, disables curve trades and cannot repeat
- PASS: Four real V3 swaps execute both ways; buys raise and sells lower the marginal price
- PASS: Both LP fee assets split exactly: Census 25%, remaining 75% by holder allocation
- PASS: Keeper converts token fees, distributes backed WETH, pushes rewards; repeated claim pays zero
- PASS: Supply remains exactly 1B and all tokens/reserves reconcile after every recorded stage

## Interpretation

Graduation itself causes no material price jump. Subsequent buys and sells move the real pool price normally. A large holder sale has substantial price impact because the pool starts with only 4 ETH.
After graduation the curve rejects trades; users must trade the pool. LP fees accrue in the position and are collected before the creator/platform/holder split is paid.
Reward conversion is itself a pool sale and can move the price. A later reward batch includes fees accumulated since the preceding distribution, not just post-graduation trades.
External-pool fee bypass and outstanding deployment/review gates are unchanged.
