# V4 lifecycle rehearsal results

Generated 2026-09-23T20:12:11.658Z by contracts/scripts/rehearseV4Lifecycle.js (local Hardhat, real Uniswap V4 PoolManager bytecode).

## meme launch, reflection off

| step | fee protocol | fee creator | fee holders | penalty | tokenReserve | realQuote | notes |
|---|---|---|---|---|---|---|---|
| window buy +1s (penalised) | 0.007362 | 0.000818 | 0.0 | 0.00618 | 937682405.763752900992036071 | 0.09182 | actor=alice, quoteIn=0.1 |
| buy 1 ETH | 0.018 | 0.002 | 0.0 | 0.0 | 549755273.363943488602290542 | 1.07182 | actor=alice, quoteIn=1 |
| sell half | 0.012185584338993373 | 0.001353953815443709 | 0.0 | 0.0 | 774877636.681971744301145271 | 0.394843092278145891 | actor=alice |
| buy 0.5 ETH | 0.009 | 0.001 | 0.0 | 0.0 | 599157463.169906443830898158 | 0.884843092278145891 | actor=bob, quoteIn=0.5 |
| final fill 10 ETH (capped, refund) — graduates in the same tx | 0.057217167692850381 | 0.006357463076983376 | 0.0 | 0.0 | 0.0 | 0.0 | actor=carol, accepted=3.178731538491687866, refunded=6.821268461508312134 |
| graduate -> V4 (automatic, inside the fill) |  |  |  |  |  |  | poolId=0x4f25e4b4d0c9d8aca1881a3bfcc53bb967ed7b1682c95e793527b0466e4485fc, tokensIn=214285714.285714285786520896, quoteIn=3.99999999999999841, liquidity=29277002188455995386912, tokenDust=0.000000000000003199, quoteDust=0.00000000000000159 |
| pool buy 0.2 (hook) | 0.0012 | 0.0028 | 0.0 | 0 | 0.0 | 0.0 | actor=bob, quoteIn=0.2 |
| pool sell all (hook) | 0.011989385890410594 | 0.027975233744291387 | 0.0 | 0 | 0.0 | 0.0 | actor=bob |
| hook.claimFor treasury |  |  |  |  |  |  | amount=0.013189385890410594 |
| hook.claimFor creator |  |  |  |  |  |  | amount=0.030775233744291387 |

Checks: hook custody equals reserved liabilities; graduator holds nothing; 1B supply fully accounted for

## company launch, 3% reflection, basket ETH/stock

| step | fee protocol | fee creator | fee holders | penalty | tokenReserve | realQuote | notes |
|---|---|---|---|---|---|---|---|
| window buy +1s (penalised) | 0.007362 | 0.000818 | 0.003 | 0.00618 | 939604661.680636303312251501 | 0.08882 | actor=alice, quoteIn=0.1 |
| buy 1 ETH | 0.018 | 0.002 | 0.03 | 0.0 | 557945578.204497702532222507 | 1.03882 | actor=alice, quoteIn=1 |
| sell half | 0.011754122704948475 | 0.001306013633883164 | 0.019590204508247458 | 0.0 | 778972789.102248851266111253 | 0.385813183058418053 | actor=alice |
| buy 0.5 ETH | 0.009 | 0.001 | 0.015 | 0.0 | 606074009.728306897368966424 | 0.860813183058418053 | actor=bob, quoteIn=0.5 |
| distribute (pre-graduation) |  |  |  |  |  |  | quoteDistributed=0.067590204508247458, reserved=weth=0.027036081803298983 stock=0.040554122704948474 |
| final fill 10 ETH (capped, refund) — graduates in the same tx | 0.059479329163103658 | 0.006608814351455962 | 0.099132215271839429 | 0.0 | 0.0 | 0.0 | actor=carol, accepted=3.304407175727980996, refunded=6.695592824272019004 |
| graduate -> V4 (automatic, inside the fill) |  |  |  |  |  |  | poolId=0x163390f1f801b07e3fe4bde23ea14d1e5e8fd1ab4bc02ee298163861a3027f8c, tokensIn=214285714.285714285745907554, quoteIn=3.999999999999998409, liquidity=29277002188455995383381, tokenDust=0.000000000000001613, quoteDust=0.000000000000001591 |
| pool buy 0.2 (hook) | 0.0012 | 0.0028 | 0.006 | 0 | 0.0 | 0.0 | actor=bob, quoteIn=0.2 |
| pool sell all (hook) | 0.011857295689589706 | 0.027667023275709316 | 0.059286478447948532 | 0 | 0.0 | 0.0 | actor=bob |
| hook.claimFor treasury |  |  |  |  |  |  | amount=0.013057295689589706 |
| hook.claimFor creator |  |  |  |  |  |  | amount=0.030467023275709316 |
| hook.claimFor vault |  |  |  |  |  |  | amount=0.065286478447948532 |
| distribute (post-graduation) |  |  |  |  |  |  | quoteDistributed=0.164418693719787962 |
| claim alice |  |  |  |  |  |  | paid=2, owed=weth=0.03889030800766343 stock=0.058335462011495146 |
| claim carol |  |  |  |  |  |  | paid=2, owed=weth=0.042046794698463468 stock=0.06307019224358935 |

Checks: vault never holds the coin; vault solvent for every reserved asset; hook custody equals reserved liabilities; graduator holds nothing; 1B supply fully accounted for
