# Sumo: trading Delos coins and Delos as a launch venue

Entry page for a trading terminal and launch-venue integrator. Everything below links to [CONTRACTS.md](CONTRACTS.md) and [DATA-API.md](DATA-API.md). If you integrated Pons V2, the shape is familiar: a fee-taking curve, graduation, then a Uniswap pool. The differences are listed at the end.

## Level 1: trade Delos coins

**Detect.** Watch the curve (one address per stack, `addresses.json → delos[current].curve`) for `Registered(coin, quote, creator, vault, reflectionBps, virtualQuote, graduationQuote, virtualTokenOffset)`. The factory's `LaunchedV4` fires in the same transaction if you prefer to watch factories; the curve catches every factory.

**Quote and buy on the curve.** `quoteBuyFor(coin, quoteIn, buyer)` gives tokens out for a gross amount, including the buyer's anti-snipe tax if any. `maxQuoteInFor(coin, buyer)` is the amount that fills the curve; sending more is fine, the surplus is refunded in the same transaction (`BuyRefunded`), so a bot that wants the last slice can simply send its full size. Execute with `buyWithETH(coin, minTokensOut)` for ETH-quoted coins (send ETH as value) or `buy(coin, quoteIn, minTokensOut)` after approving the quote asset to the curve. `sell(coin, tokensIn, minQuoteOut)` and `sellForETH` mirror it; approve the coin to the curve first.

**Respect the window.** The first 3 seconds after `LaunchWindow.launchedAt` carry a tax that starts at 99% and decays to the 2% base. Unless the wallet is the creator or was declared in `exemptBuyers`, buying inside the window is paying for nothing; `currentSnipeTaxBps(coin, buyer)` tells you where it is.

**Follow graduation.** When the target is hit, the crossing buy graduates the coin in the same transaction and `Graduated(coin, poolId, tokensIn, quoteIn, liquidity)` fires on the curve. From then on curve calls revert (`CurveFilled` / `AlreadyGraduated`) and the venue is the Uniswap V4 pool with `poolId == poolIds(coin)`. Pool key: sorted (coin, quote), fee 0, tickSpacing 60, hooks = the stack's hook. Price from `StateView.getSlot0`, quotes from the V4 Quoter with empty hook data, execution through `CensusV4Router.swapExactInput` (approve the input token to the router) or your own V4 router. The hook charges the 2% on every swap however it arrives, so your fill simulation should include it. Section 6 of CONTRACTS.md has the struct and the price-limit constants.

**Position accounting.** `Traded`: buys carry gross quote in and tokens out; sells carry tokens in and net quote out; `fee` is quote. `FeeAllocated` in the same transaction splits the fee into protocol, creator, holder and penalty. Pool swaps: PoolManager `Swap` plus the hook's `FeeAccrued(poolId, buy, quoteVolume, protocolFee, creatorFee, holderFee)`.

## Level 2: Delos as a native launch venue

One call launches a coin, and the block-0 bundle is a first-class parameter:

```
LaunchFactoryV4.createLaunch(
  { name, symbol, totalSupply: 1e27, decimals: 18, virtualQuote, graduationQuote },
  basket, weights, paths,          // empty, empty, empty for a plain coin
  salt,                            // grinded for the vanity suffix, or bytes32(0)
  quote,                           // address(0) = ETH/WETH, or HOOD, or a pairable company coin
  reflectionBps,                   // 0, or 100..400 with a basket
  exemptBuyers                     // your bundle wallets: exempt from the anti-snipe tax
)
```

- `createLaunchWithDevBuy(..., devBuyQuoteIn, devBuyMinTokensOut)` adds a creator buy in the same transaction (send `devBuyQuoteIn` as value for ETH launches); the refund of any capped fill comes back to the caller.
- Bundle wallets buy immediately after with `buyWithETH` / `buy` and pay only the base fee, in any order within the window.
- The vanity salt is bound to the sender: grind with `keccak256(abi.encodePacked(salt, yourSender))` as the effective CREATE2 salt and the init-code hash in CONTRACTS.md section 8. Read `VANITY_SUFFIX()` / `VANITY_MASK()` from the factory (final stack) or assume `c0de` / `0xFFFF` on the team-test one. About a million tries for `de105`; the reference grinder in `contracts/scripts/lib/grindSalt.js` does it in well under a minute.
- Curve maths for your planner: constant product on `(virtualQuote, tokenReserve + virtualTokenOffset)` with the 2% taken from the quote before it enters the curve; `quoteBuy` is the authoritative implementation. The virtual token offset is fixed at launch from `virtualQuote`, `totalSupply` and `graduationQuote`, so the pool opens at exactly the curve's exit price.
- Targets: the launcher chooses `graduationQuote` (the app offers fixed options); `virtualQuote` is 1.5 ETH-equivalent in the app.

## Differences from Pons V2

| | Pons V2 | Delos |
| --- | --- | --- |
| Graduation venue | Uniswap V3 pool | Uniswap V4 pool on the official PoolManager, keyed by `poolId`, full-range liquidity custodied by the graduator |
| Post-graduation fee | LP fee tier | 2% charged by the Delos hook on every swap, any router; 30% protocol / 70% creator |
| Curve fee | curve fee | 2%, 90% protocol / 10% creator, paid at trade time |
| Anti-snipe | varies | 3-second tax decaying from 99% to 2%; no buy or wallet caps; creator and declared bundle wallets exempt |
| Final fill | varies | capped at the target with an in-transaction refund |
| Quote assets | ETH | ETH, HOOD, or another Delos company coin |
| Holder rewards | none | optional 1 to 4% reflection paid in HOOD and tokenised stocks (company coins) |
| Address | | ends in `de105` (final stack) |

## What is pending

The final stack (`de105`) is not deployed and the data API has no public host; both arrive in `addresses.json`. Level 1 and Level 2 against the team-test stack work today exactly as described, with `c0de` addresses.
