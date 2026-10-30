# On-chain reference

Everything a terminal, bot or venue needs to detect, price, trade and launch Delos coins directly against the contracts. Addresses are in [ADDRESSES.md](ADDRESSES.md), full ABIs in [`abi/`](abi/). Source lives in [`contracts/contracts/`](../contracts/contracts/) and [`contracts/contracts/v4/`](../contracts/contracts/v4/).

## 1. Lifecycle

```
creator ─▶ LaunchFactoryV4.createLaunch(...)
              deploys LaunchToken (CREATE2, address ends in the factory's vanity suffix)
              moves the whole supply into CensusCurveV4 and registers the coin
traders ─▶ CensusCurveV4.buyWithETH / buy / sell / sellForETH      (2% fee, 3-second anti-snipe tax)
           realQuote reaches graduationQuote
              the crossing buy is capped at the target, the excess refunded (BuyRefunded)
              same transaction: CensusV4Graduator initialises the pool and adds full-range
              liquidity it holds forever; CensusV4Hook registers the fee policy; Graduated fires
traders ─▶ the Uniswap V4 pool (poolId), through CensusV4Router or any V4 router; the hook charges 2%
```

The curve is one contract for every coin; per-coin state is a mapping. The pool is a normal Uniswap V4 pool with a hook; nothing about it is custom at the PoolManager level.

## 2. The token

`LaunchToken`: OpenZeppelin ERC-20, fixed supply minted once to the factory and moved to the curve, 18 decimals, 1,000,000,000 supply on every Delos launch. No tax, no mint, no owner, no transfer restrictions. Its address is a CREATE2 address bound to the creator (section 7), ending in `de105` on the final factory and `c0de` on the team-test one.

## 3. Fees and the anti-snipe tax

| Where | Base fee | Split | Extra |
| --- | --- | --- | --- |
| On the curve | 2% of quote, every buy and sell (`FEE_BPS() = 200`) | 90% protocol / 10% creator (`CURVE_PROTOCOL_BPS() = 9000`) | reflection 1 to 4% to the coin's reward vault if the launch chose it |
| In the pool, after graduation | 2%, charged by the hook on every swap | 30% protocol / 70% creator | same reflection |

Anti-snipe: for the first 3 seconds after launch (`SNIPE_TAX_SECONDS()`), a non-exempt buyer pays an extra penalty that starts at 99% total (`SNIPE_TAX_START_BPS() = 9900`) and decays to the base rate. The creator and the wallets the launch declared as `exemptBuyers` are exempt (`snipeTaxExempt(coin, wallet)`). There are no buy or wallet caps. Read the live rate with `buyFeeBps(coin, buyer)` and `currentSnipeTaxBps(coin, buyer)`; penalties are reported in `FeeAllocated.penalty` and `SnipeTaxCharged`.

Fees are paid in the coin's quote asset. On the curve the creator's share is transferred at trade time. In the pool, shares accrue in the hook: `claimable(asset, recipient)` and `claimFor(asset, recipient)` (anyone may trigger a claim for a recipient).

## 4. Reading a coin

`curves(coin)` returns `(quote, creator, vault, reflectionBps, virtualQuote, tokenReserve, realQuote, graduationQuote, graduated, exists)`.

- `quote` is the pairing asset: WETH, HOOD or another Delos company coin. `exists` false means not a Delos coin.
- Spot price on the curve, in quote per token (raw units): `virtualQuote / (tokenReserve + virtualTokenOffset(coin))`. The offset is a pricing-only constant fixed at launch (Pump.fun-style); it is never minted.
- Progress: `graduationProgress(coin)` in basis points (10,000 = filled), or `realQuote / graduationQuote`.
- `isGraduated(coin)`, `poolIds(coin)` (the V4 pool id after graduation), `launchedAt(coin)` (unix seconds).
- Other views: `virtualTokenOffset(coin)`, `maxQuoteIn(coin)` (section 5), `allowedQuote(asset)`, `isPairableCompanyCoin(coin)`.

## 5. Trading on the curve

Quotes (view):

| Call | Returns |
| --- | --- |
| `quoteBuy(coin, quoteIn)` | tokens out for a gross quote amount (the 2% fee is taken from `quoteIn` first) |
| `quoteBuyFor(coin, quoteIn, buyer)` | same, including the buyer's anti-snipe tax if inside the window |
| `quoteSell(coin, tokensIn)` | net quote out after the fee |
| `maxQuoteIn(coin)` / `maxQuoteInFor(coin, buyer)` | the gross quote that fills the curve exactly; anything above it is refunded in the same transaction |

Trades:

| Call | Notes |
| --- | --- |
| `buyWithETH(coin, minTokensOut)` payable | ETH-quoted coins; the curve wraps to WETH itself. Excess above the fill cap comes back as ETH. |
| `buy(coin, quoteIn, minTokensOut)` | any quote asset; approve the quote ERC-20 to the curve first. Excess above the cap is returned in the quote asset. |
| `sell(coin, tokensIn, minQuoteOut)` | approve the coin to the curve first; pays the quote ERC-20. |
| `sellForETH(coin, tokensIn, minQuoteOut)` | ETH-quoted coins; unwraps to ETH. |

All four revert with `CurveFilled` / `AlreadyGraduated` once the coin has graduated, so route to the pool after `Graduated` (section 6). Slippage: set `minTokensOut` / `minQuoteOut` from the quote views; the curve is deterministic, so the only movement between quote and execution is other trades and, inside the window, the decaying tax.

Events (all on the curve; `FeeAllocated` precedes the `Traded` of the same trade):

```solidity
event Registered(address indexed coin, address quote, address creator, address vault, uint16 reflectionBps, uint256 virtualQuote, uint256 graduationQuote, uint256 virtualTokenOffset);
event LaunchWindow(address indexed coin, uint256 launchedAt, uint256 secondsWindow, uint16 startBps);
event SnipeTaxExempted(address indexed coin, address indexed account);
event FeeAllocated(address indexed coin, bool isBuy, uint256 protocolFee, uint256 creatorFee, uint256 holderFee, uint256 penalty);
event Traded(address indexed coin, address indexed trader, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 fee);
event SnipeTaxCharged(address indexed coin, address indexed buyer, uint256 penalty);
event BuyRefunded(address indexed coin, address indexed buyer, address quote, uint256 amount, bool nativeRefund);
event Graduated(address indexed coin, bytes32 indexed poolId, uint256 tokensIn, uint256 quoteIn, uint128 liquidity);
event GraduationDeferred(address indexed coin, bytes reason);
```

`Traded` amounts: on a buy `amountIn` is the gross quote (fee included) and `amountOut` the tokens; on a sell `amountIn` is tokens and `amountOut` the net quote. `fee` is always in quote. Volume in quote terms is `amountIn` for buys and `amountOut + fee` for sells.

## 6. After graduation: the Uniswap V4 pool

Graduation is automatic: the buy that crosses the target calls the graduator inside the same transaction. If the graduator has to defer (it needs about 1.5M gas; `GraduationDeferred` says why), anyone can call `graduate(coin)`; the keeper does this too.

The pool key is fixed:

```
currency0, currency1 = the coin and its quote, sorted by address (lower first)
fee         = 0          (the hook charges; there is no LP fee tier)
tickSpacing = 60
hooks       = the stack's CensusV4Hook
poolId      = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))  ==  CensusCurveV4.poolIds(coin)
```

Liquidity is one full-range position minted by the graduator and never withdrawn (`CensusV4Graduator.lockedLiquidity(coin)`). Price: `StateView.getSlot0(poolId)`; there is no TWAP in V4, so treat it as spot. Quotes: the Uniswap V4 Quoter with empty hook data, or the pool maths of your choice.

Swapping with the Delos router (`CensusV4Router.swapExactInput`), one struct argument:

```
{ key: PoolKey, zeroForOne: bool, amountIn: uint256, minOut: uint256, sqrtPriceLimitX96: uint160, recipient: address, deadline: uint256 }
```

`zeroForOne` is true when you pay `currency0`. Approve the input token to the router; `minOut` must be greater than zero (the router refuses unprotected trades); use `4295128740` as the price limit for zeroForOne and `1461446703485210103287273052203988822378723970341` otherwise for "no limit". The router emits `Swap(pool/key sender, recipient, tokenIn, tokenOut, amountIn, amountOut)`.

Any V4-capable router (for example Uniswap's Universal Router with V4 commands) can swap the same pool; the hook charges the fee regardless and emits `FeeAccrued(bytes32 indexed poolId, bool buy, uint256 quoteVolume, uint256 protocolFee, uint256 creatorFee, uint256 holderFee)` next to the PoolManager's own `Swap`. Pools created elsewhere for the same token pair are not Delos pools: no hook, no fee, no creator or holder rewards. The Uniswap web app only routes hooked pools after an allow-list review, which is in progress; integrations that swap directly are unaffected.

## 7. Launching a coin

```solidity
struct LaunchParams { string name; string symbol; uint256 totalSupply; uint8 decimals; uint256 virtualQuote; uint256 graduationQuote; }

function createLaunch(LaunchParams p, address[] basket, uint16[] weights, bytes[] paths,
                      bytes32 salt, address quote, uint16 reflectionBps, address[] exemptBuyers)
    returns (address token, address vault);

function createLaunchWithDevBuy(LaunchParams p, address[] basket, uint16[] weights, bytes[] paths,
                      bytes32 salt, address quote, uint16 reflectionBps, address[] exemptBuyers,
                      uint256 devBuyQuoteIn, uint256 devBuyMinTokensOut) payable
    returns (address token, address vault);
```

- `totalSupply` 1e27 and `decimals` 18 on every Delos launch. `virtualQuote` and `graduationQuote` are in the quote asset's units; the app uses a 1.5 ETH virtual reserve and converts targets priced in ETH into the chosen quote.
- `quote`: `address(0)` for WETH, otherwise an asset with `allowedQuote(asset)` true (HOOD) or a company coin with `isPairableCompanyCoin(coin)` true.
- `reflectionBps`: `0` for a plain coin, or `100` to `400` with a `basket` of up to three reward assets (the quote itself and/or assets with `allowedRewardAsset(asset)` true), `weights` summing to 10,000, and `paths` giving each asset's Uniswap V3 route from the quote (empty for the quote itself). A non-zero reflection deploys a `CensusRewardVault` and returns it as `vault`.
- `exemptBuyers`: wallets exempt from the anti-snipe tax for this coin, for block-0 bundles. At most 31 when combined with a creator buy.
- `salt`: `bytes32(0)` deploys the token at an ordinary address. Any other salt must land on the vanity suffix or the call reverts (section 8).
- Creator buy: `createLaunchWithDevBuy` with `msg.value == devBuyQuoteIn` for WETH launches, or an approval of `devBuyQuoteIn` for other quotes. The factory is exempt from the tax for that buy; tokens and any capped-fill refund go to the caller.

Events: `LaunchedV4(address indexed token, address indexed creator, address curve, address vault, uint16 reflectionBps, address quote)` on the factory and `Registered` on the curve in the same transaction; `DevBought(token, buyer, quote, quoteIn, tokensOut, refunded)` for a creator buy.

## 8. Vanity addresses

The factory deploys the token with `CREATE2` using `keccak256(abi.encodePacked(salt, msg.sender))` as the effective salt, so a salt grinded for one wallet cannot be replayed by another (this closed a launch front-running vector). The address must satisfy `(uint160(token) & VANITY_MASK) == VANITY_SUFFIX`; the final factories expose both constants (`0xFFFFF` / `0xDE105`), the team-test factories enforce `0xFFFF` / `0xC0DE` without exposing them.

To predict the address: `initCodeHash = keccak256(LaunchToken.creationCode ++ abi.encode(name, symbol, totalSupply, decimals, factory))`, then the standard CREATE2 formula with the factory as deployer. A five-character suffix needs about a million tries; the browser and Node grinders in [`frontend/src/lib/c0de.ts`](../frontend/src/lib/c0de.ts) and [`contracts/scripts/lib/grindSalt.js`](../contracts/scripts/lib/grindSalt.js) are reference implementations, and [`frontend/src/lib/launchTokenBytecode.ts`](../frontend/src/lib/launchTokenBytecode.ts) pins the creation code.

## 9. Detecting launches and graduations

- New coin: `LaunchedV4` on the factory, or `Registered` on the curve (indexed by coin). The curve address is the single place to watch for every factory on a stack.
- Trades: `Traded` on the curve until graduation, then PoolManager `Swap` for the `poolId` (pair it with the hook's `FeeAccrued` in the same transaction for the fee split).
- Graduation: `Graduated` on the curve (or on the graduator, which also carries `liquidity`, `coinUsed`, `quoteUsed`).
- Reward vaults: `Distributed`, `Claimed` on `CensusRewardVault`.

Index from the stack's `startBlock` in `addresses.json`; the RPC caps a single `eth_getLogs` at 10,000,000 blocks.

## 10. viem sketch

```ts
import { createPublicClient, http, parseAbi, parseEther } from "viem";
const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") });
const curve = "0xD1300ccE1Ed4c778791cF713b6bA47FE32B217C3"; // addresses.json → delos[current].curve
const abi = parseAbi([
  "function curves(address) view returns (address,address,address,uint16,uint256,uint256,uint256,uint256,bool,bool)",
  "function quoteBuyFor(address coin, uint256 quoteIn, address buyer) view returns (uint256)",
  "function maxQuoteInFor(address coin, address buyer) view returns (uint256)",
  "function buyWithETH(address coin, uint256 minTokensOut) payable returns (uint256)",
  "function isGraduated(address) view returns (bool)",
  "function poolIds(address) view returns (bytes32)",
]);
const coin = "0x…de105", me = "0x…";
const [, , , , , , , , graduated] = await client.readContract({ address: curve, abi, functionName: "curves", args: [coin] });
if (!graduated) {
  const want = parseEther("0.05");
  const cap = await client.readContract({ address: curve, abi, functionName: "maxQuoteInFor", args: [coin, me] });
  const spend = want < cap ? want : cap;                           // above the cap is refunded anyway
  const out = await client.readContract({ address: curve, abi, functionName: "quoteBuyFor", args: [coin, spend, me] });
  // walletClient.writeContract({ address: curve, abi, functionName: "buyWithETH", args: [coin, out * 99n / 100n], value: spend })
} else {
  const poolId = await client.readContract({ address: curve, abi, functionName: "poolIds", args: [coin] });
  // quote with the V4 Quoter, swap through CensusV4Router.swapExactInput (section 6)
}
```
