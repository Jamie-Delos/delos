# V4 integration spec (contracts are final; app layers implement this)

Contracts live in `contracts/contracts/LaunchFactoryV4.sol` and `contracts/contracts/v4/`. Compiled ABIs are in
`contracts/artifacts/contracts/<file>.sol/<Name>.json`. Local end-to-end proof: `contracts/test/v4.lifecycle.test.js`.
Deployment output: `contracts/deployments.v4.<network>.json` (written by `scripts/deployV4.js`).

## Economics (identical for meme and company launches)

- Base fee 2% (200 bps) on every buy and sell, on the curve and in the canonical V4 pool.
- On the curve: 90% Census (`platform`/treasury) / 10% creator. After graduation (hook): 30% Census / 70% creator.
- Optional reflection `reflectionBps` = 0 (off) or 100..400, charged ON TOP of the base fee on buys and sells, paid to the
  launch's `CensusRewardVault` (curve pays it directly; the hook accrues it as `claimable[quote][vault]`).
- Anti-snipe: buys in the first 3 seconds after `launchedAt` pay a penalty (9900 bps at second 0, 618 at +1s, 19 at +2s,
  0 from +3s) capped so base + reflection + penalty <= 9900. Penalty follows the phase split. Creator and bundle
  wallets (`snipeTaxExempt`) are exempt.
- Fee bps views: `CensusCurveV4.buyFeeBps(coin, buyer)` (total incl. reflection + penalty), `sellFeeBps(coin)`
  (base + reflection), `currentSnipeTaxBps(coin, buyer)` (penalty only).
- Curve math is unchanged from the PF curve: price = virtualQuote / (tokenReserve + virtualTokenOffset), 1B real supply,
  capped final fill with refund, `quoteBuyFor`, `quoteSell`, `maxQuoteInFor`, `graduationProgress`.

## Contracts and ABI surface

### LaunchFactoryV4 (`VITE_FACTORY_V4_ADDRESS`)
```
struct LaunchParams { string name; string symbol; uint256 totalSupply; uint8 decimals; uint256 virtualQuote; uint256 graduationQuote; }
function createLaunch(LaunchParams p, address[] basket, uint16[] weights, bytes[] paths, bytes32 salt, address quote, uint16 reflectionBps, address[] exemptBuyers) returns (address token, address vault)
event LaunchedV4(address indexed token, address indexed creator, address curve, address vault, uint16 reflectionBps, address quote)
```
- `reflectionBps == 0` requires an empty basket (no vault). Otherwise 1..3 basket assets, weights sum 10000, one `paths`
  entry per asset: empty (`0x`) for the quote asset or a direct-hop V3 route; an encoded V3 multi-hop path
  (quote -> ... -> asset) for USDG-routed stocks (same as the old Maxima `basketPathFor`).
- **Rewards are only ever quoted assets.** A basket asset must be the quote (pairing) asset or a tokenised stock listed
  on-chain via `CensusCurveV4.allowedRewardAsset(asset)` (deployer-managed, additive: `setRewardAssetAllowed(asset, true)`;
  event `RewardAssetAllowed`). Anything else reverts `AssetNotAllowed(address)`. The launch token is never a reward
  and never in a basket; the vault has no buy/sell/convert routine. New stocks are listed later without any contract change.
- CREATE2 salt semantics unchanged (`keccak256(salt, creator)`, `...c0de`). The embedded LaunchToken creation code is
  byte-identical to the legacy artifact, so `frontend/src/lib/c0de.ts` and `launchTokenBytecode.ts` stay valid with
  `factory = VITE_FACTORY_V4_ADDRESS`.
- No `poolFee` parameter any more (V4 pool key is fixed: fee 0, tickSpacing 60, hooks = Census hook).

### CensusCurveV4 (`VITE_CURVE_V4_ADDRESS`)
```
function curves(address coin) view returns (address quote, address creator, address vault, uint16 reflectionBps, uint256 virtualQuote, uint256 tokenReserve, uint256 realQuote, uint256 graduationQuote, bool graduated, bool exists)
function virtualTokenOffset(address) view returns (uint256); launchedAt(address) view returns (uint256); poolIds(address) view returns (bytes32)
function snipeTaxExempt(address coin, address who) view returns (bool); isGraduated(address) view returns (bool)
function buyFeeBps(address coin, address buyer) view returns (uint256); sellFeeBps(address coin) view returns (uint256); currentSnipeTaxBps(address coin, address buyer) view returns (uint256)
function quoteBuy(address,uint256) view; quoteBuyFor(address,uint256,address) view; quoteSell(address,uint256) view; maxQuoteIn(address) view; maxQuoteInFor(address,address) view; graduationProgress(address) view
function buy(address coin, uint256 quoteIn, uint256 minTokensOut) returns (uint256)
function buyWithETH(address coin, uint256 minTokensOut) payable returns (uint256)
function sell(address coin, uint256 tokensIn, uint256 minQuoteOut) returns (uint256)
function sellForETH(address coin, uint256 tokensIn, uint256 minEthOut) returns (uint256)
function graduate(address coin) returns (bytes32 poolId)            // RETRY path only: graduation is automatic inside the buy that fills the curve (2026-09-23); permissionless, keeper-retried after GraduationDeferred; a filled curve is frozen until it succeeds
function graduator() view returns (address); keeper() view returns (address); platform() view returns (address); weth() view returns (address)
function allowedRewardAsset(address asset) view returns (bool); allowedQuote(address) view returns (bool)
event RewardAssetAllowed(address indexed asset, bool allowed)
event Registered(address indexed coin, address quote, address creator, address vault, uint16 reflectionBps, uint256 virtualQuote, uint256 graduationQuote, uint256 virtualTokenOffset)
event Traded(address indexed coin, address indexed trader, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 fee)   // same shape as V3
event FeeAllocated(address indexed coin, bool isBuy, uint256 protocolFee, uint256 creatorFee, uint256 holderFee, uint256 penalty)
event Graduated(address indexed coin, bytes32 indexed poolId, uint256 tokensIn, uint256 quoteIn, uint128 liquidity)
event GraduationDeferred(address indexed coin, bytes reason)                // the filling buy succeeded but the pool seeding reverted; graduate() retries
event LaunchWindow(address indexed coin, uint256 launchedAt, uint256 secondsWindow, uint16 startBps)
event SnipeTaxCharged(address indexed coin, address indexed buyer, uint256 amount); BuyRefunded(...)
```

### CensusV4Router (`VITE_V4_ROUTER`) — post-graduation trades (ERC20 exact-input only; wrap ETH to WETH first)
```
struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct Request { PoolKey key; bool zeroForOne; uint256 amountIn; uint256 minOut; uint160 sqrtPriceLimitX96; address recipient; uint256 deadline; }
function swapExactInput(Request request) returns (uint256 amountOut)
function manager() view returns (address); hook() view returns (address)
event Swap(address indexed payer, address indexed recipient, address input, address output, uint256 amountIn, uint256 amountOut)
```
- Pool key for a coin: currency0/currency1 = sorted(coin, quote); fee 0; tickSpacing 60; hooks = `VITE_V4_HOOK`.
- `poolId = keccak256(abi.encode(key))` (bytes32) and equals `curve.poolIds(coin)`.
- Buy = zeroForOne when quote is currency0; `sqrtPriceLimitX96` = 4295128740 (MIN+1) for zeroForOne, else
  1461446703485210103287273052203988822378723970341 (MAX-1). `minOut` must be > 0; `deadline` unix seconds.
- Exact-output is unsupported; partial fills revert (`IncompleteFill`) instead of overcharging.

### CensusV4Hook (`VITE_V4_HOOK`)
```
function policies(bytes32 poolId) view returns (address quote, address creator, address rewards, uint16 reflectionBps, uint64 launchedAt)
function claimable(address asset, address recipient) view returns (uint256); totalReserved(address asset) view returns (uint256)
function claimFor(address asset, address recipient)   // permissionless push to the recorded beneficiary
event FeeAccrued(bytes32 indexed poolId, bool buy, uint256 quoteVolume, uint256 protocolFee, uint256 creatorFee, uint256 holderFee)
event FeesClaimed(address indexed asset, address indexed recipient, uint256 amount)
event PoolRegistered(bytes32 indexed poolId, address quote, address creator, address rewards, uint16 reflectionBps)
```

### PoolManager (`VITE_POOL_MANAGER`) and StateView (`VITE_STATE_VIEW`) — Uniswap V4 canonical
```
PoolManager event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
StateView function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)
StateView function getLiquidity(bytes32 poolId) view returns (uint128)
```
Price of the coin in quote units: from sqrtPriceX96 (token1 per token0), oriented by which currency is the coin, scaled by
decimals exactly as `indexer/src/ingest.ts onPoolSwap` does for V3. There is no TWAP in V4: display spot and label it.

### V4 Quoter (`VITE_V4_QUOTER`, Uniswap `V4Quoter`) — impact-aware "you receive" for pool trades
```
struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }
function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)   // call via eth_call (simulate)
```
The quote already includes the hook fee (the hook runs inside the simulated swap). Apply the user's slippage to derive `minOut`.

### CensusRewardVault (per launch; `curves(coin).vault`)
```
function basket(uint256 i) view returns (address); weights(uint256 i) view returns (uint16); basketLength() view returns (uint256)
function token() view returns (address); quote() view returns (address); operator() view returns (address) // == CensusCurveV4.keeper(); the creator is never an operator (F1, 2026-09-23)
function withdrawableOf(address holder, address asset) view returns (uint256); reserved(address asset) view returns (uint256)
function availableQuote() view returns (uint256); eligibleSupply() view returns (uint256); excluded(address) view returns (bool)
function claim(); claimFor(address holder)
function distribute(uint256[] minOut) returns (uint256 spent)                      // curve keeper only; one minOut per basket asset (0 allowed only for the quote entry)
function distributeVia0x(uint256[] sellAmounts, bytes[] swapData, uint256[] minOut) // external assets only; quote/launch-token entries use their canonical path
event Distributed(uint256 quoteSpent); Claimed(address indexed holder, address indexed asset, uint256 amount); ClaimDeferred(...)
```
- Basket = the quote asset (credited as-is) and/or allow-listed stocks (routed through V3 or 0x). Never the launch token.
  There is no buy/sell/convert routine in the vault.
- Custody is excluded from eligibility: curve, factory, PoolManager, hook, router, graduator, vault, dead.

## Keeper cycle for a V4 launch
1. Discover `LaunchedV4` (factory) and `Graduated` (curve V4, `bytes32 poolId`).
2. Collect: `hook.claimFor(quote, vault)` when `hook.claimable(quote, vault) >= COLLECT_MIN_WEI` (permissionless).
   Optionally `hook.claimFor(quote, treasury)` and `hook.claimFor(quote, creator)`.
3. Distribute: `vault.distribute(minOut[])` when `vault.availableQuote() >= DISTRIBUTE_MIN_WEI`; minOut per asset from
   the existing quoter/0x planners for stock entries, 0 for the quote entry.
4. Push: `vault.claimFor(holder)` for holders with `withdrawableOf > PUSH_MIN_WEI`. No convert step, no locker.

## Indexer events for a V4 launch
- Curve: `Registered` (new shape with `reflectionBps`), `Traded` (same shape), `FeeAllocated`, `Graduated(coin, poolId, tokensIn, quoteIn, liquidity)`.
- PoolManager: `Swap` filtered by `id == poolId` (post-graduation trades; venue "pool"; fee from hook `FeeAccrued` in the same tx).
- Hook: `FeeAccrued`, `FeesClaimed`. Vault: `Distributed`, `Claimed`.
- Config: `CURVE_V4_ADDRESS`, `FACTORY_V4_ADDRESS`, `POOL_MANAGER_ADDRESS`, `HOOK_ADDRESS` (legacy `CURVE_ADDRESS`/`FACTORY_*` remain for V3 history).

## Frontend environment (release gate `frontend/release-check.cjs` must require these)
`VITE_FACTORY_V4_ADDRESS`, `VITE_CURVE_V4_ADDRESS`, `VITE_V4_ROUTER`, `VITE_V4_HOOK`, `VITE_POOL_MANAGER`, `VITE_STATE_VIEW`,
`VITE_V4_QUOTER`, `VITE_INDEXER_URL`. `src/config.ts` exports `GRADUATION_VENUE = "v4"`. Legacy `VITE_FACTORY_ADDRESS`,
`VITE_FACTORY_V2_ADDRESS`, `VITE_LOCKER_ADDRESS`, `VITE_CURVE_ADDRESS`, `VITE_QUOTER` become optional (legacy V3 coins only).

## Fee presentation rules

- If Uniswap governance ever enables its protocol fee on a Census pool (max 0.1%), the hook keeps trading live and that
  fee applies on top; the UI should read StateView `getSlot0(poolId).protocolFee` and, when non-zero, add a line
  "+ Uniswap protocol fee" to the breakdown.

- Curve: "Fee X%" where X = buyFeeBps/100 for buys (shows the launch-window penalty live) and sellFeeBps/100 for sells;
  break down as "2% base + R% holder reflection" when reflection > 0; never show a Uniswap pool tier.
- Pool (graduated): same 2% base + reflection, charged by the Census hook in the canonical pool; disclose that trades in
  other venues are not charged and do not fund creator/holder rewards.
- Splits (90/10 curve, 30/70 pool) are not surfaced to traders; the creator dashboard may show them.
