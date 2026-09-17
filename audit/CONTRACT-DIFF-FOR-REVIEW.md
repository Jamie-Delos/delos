# Contract diff for re-review — `945dfe2` → `fcc8e9d` (2026-09-16)

For: Jamie. Scope: every Solidity change since the base you reviewed (`BACKEND-NEIL` @ `945dfe2`,
the tree `INDEPENDENT-REVIEW.md` was written against). Four files; the full `git diff` is at the
bottom, byte-exact. Nothing here is deployed. Regenerate with
`git diff 945dfe2..HEAD -- contracts/contracts/`.

Read the four highlighted areas first (they are the money-path changes), then the mechanical ones.

## 1. Keeper authority (H1)

| What | Where |
| --- | --- |
| New curve state `keeper` + `setKeeper` (deployer-only, event `KeeperSet`) | `CensusCurve.sol:68`, `CensusCurve.sol:173` |
| Vault authorization helper: operator **or** `census.keeper()` | `DividendVault.sol:170` |
| Call sites: `distribute`, `distributeVia0x`, `convertLaunchFees` | `DividendVault.sol:261`, `DividendVault.sol:336`, `DividendVault.sol:388` |
| `setOperator` stays operator-only (the keeper cannot take the operator role) | `DividendVault.sol:162` |

Trust model: the keeper gets exactly the operator's powers (choose `minOut`, trigger conversions),
nothing more — it cannot claim, exclude, re-point the operator or move reserved payouts. `census` is
set once by the vault deployer and only the curve deployer can rotate `keeper`; vaults created before
a rotation follow it automatically (they read the curve live). A vault with `census == 0` (direct
deployments in tests) accepts only its operator. Tests: `review.fixes.test.js` "H1", keeper harness 7.

## 2. Fee deferral (M5)

| What | Where |
| --- | --- |
| `_distributeFee` pays through `_payFee` | `CensusCurve.sol:259` |
| `_payFee`: low-level `transfer`; on failure `deferredFee[quote][to] += amount` + `FeeDeferred` | `CensusCurve.sol:272` |
| `withdrawDeferredFee(quote, recipient)` — permissionless push, pays the recipient only | `CensusCurve.sol:206` |

Accounting: deferred fees are held in the curve's quote balance but are **not** part of any coin's
`realQuote`, so no sell (`quoteGross <= realQuote`, `CensusCurve.sol:381`) and no
graduation (`quoteAmt = c.realQuote`) can consume them, and `sweepMigrationDust` moves only the
recorded dust mappings. Invariant tested on real Uniswap with a blocklisting quote:
`balance(curve) == Σ realQuote + Σ deferredFee + Σ migrationQuoteDust` through buys, sells, graduation,
sweep and withdrawal (`review.invariants.test.js` #1). The push can be called by anyone but always pays
`recipient`. A recipient that is *still* blocked makes the push revert; the amount stays deferred.
Open policy question (not a bug): deferred fees have no expiry or redirect — see the decision list.

## 3. Dust sweeping (M3)

| What | Where |
| --- | --- |
| `sweepMigrationDust(coin)` — deployer-only, graduated coins only, zeroes both mappings first, pays the immutable `platform` | `CensusCurve.sol:191` |

It cannot reach live reserves (only `migrationTokenDust`/`migrationQuoteDust`, which `graduate` sets
from the mint remainder) and cannot pay `msg.sender`. Tested: `graduation.recovery.test.js` "M3",
`review.invariants.test.js` #1 (platform receives exactly the recorded dust; deployer balance unchanged).

## 4. Graduation recovery permissions (H5)

| What | Where |
| --- | --- |
| `RECOVERY_MAX_SPEND_CAP_BPS = 5_000`, per-coin `recoveryMaxSpendBps` | `CensusCurve.sol:54`, `CensusCurve.sol:59` |
| `setRecoveryMaxSpendBps(coin, bps)` — deployer-only, `bps <= cap`, event | `CensusCurve.sol:181` |
| Bound applied in `_restoreMigrationPrice` (0 ⇒ default 10%) | `CensusCurve.sol:479` |

What the lever can and cannot do: it only changes how much of ONE leg the exact-price-limited swap
may spend; the swap still stops at `target` (`sqrtPriceLimitX96 = target`, and the post-swap
`slot0 == target` check is unchanged), so every unit executes at better than the migration price.
The deltas are attributed back to the migration amounts; the remainder becomes dust. Tested on real
Uniswap (`review.invariants.test.js` #3): with the bound at 50% the pool ends exactly at target, the
value change measured at the target price is ≥ 0, the curve holds exactly its recorded dust, and the
deployer/platform/creator balances are unchanged by graduation. Not timelocked (see decisions).

## 5. Claim resilience (M4) and custom errors (M14)

| What | Where |
| --- | --- |
| `_claim` pays each asset independently; refused transfer ⇒ `ClaimDeferred`, state untouched | `DividendVault.sol:425`, `DividendVault.sol:445` |
| Vault custom errors (`NotOperator`, `MinOut`, `Insolvent`, `Excluded`, `BadParams`, …) | `DividendVault.sol:93` |
| Curve custom errors (`QuoteNotSupported`, `BadPoolFee`, `ZeroAmount`, `CurveLimit`, `UnsupportedQuote`, `RecoveryFailed`, …) | `CensusCurve.sol:131` |
| `register` validates `poolFee ∈ {100, 500, 3000, 10000}` | `CensusCurve.sol:133` |

`_claim` ordering: `reserved`/`withdrawn` are updated **only after** a successful transfer, so a
deferred asset keeps its full entitlement and reserve; the `insolvent` check is unchanged. Tests:
`review.fixes.test.js` "M4", `review.invariants.test.js` #2.

## 6. Structural: DividendVaultDeployer (EIP-170)

| What | Where |
| --- | --- |
| New contract; `create(...)` callable only by the factory that deployed it; deploys + `init` + `setCensus` | `DividendVaultDeployer.sol` |
| Factory constructor `vaultDeployer = new DividendVaultDeployer()`; launch order: token → vault → seed curve → anti-snipe → hook → register | `LaunchFactoryV2.sol:56`, `LaunchFactoryV2.sol:117` |
| Vault excludes its own address at `init` | `DividendVault.sol:150` |

Consequences to check: `vault.factory()` is now the deployer (only `init`/`setCensus` use it, both
one-shot); the excluded set is `{curve, factory, DEAD, vault}` as before; constructor args and the
`createLaunch` ABI are unchanged; deployed sizes — LaunchFactoryV2 11,259 B, DividendVaultDeployer
15,110 B, CensusCurve 14,840 B, DividendVault 10,925 B (`exportTokenBytecode.js --check` enforces < 24,576).

## Verification run against this exact tree

`npx hardhat test --network hardhat`: 68 passing, 3 pending (adds `review.fixes.test.js` and
`review.invariants.test.js`); `node scripts/exportTokenBytecode.js --check` passes; mainnet-fork
lifecycle passes.

---

## Full diff (`git diff 945dfe2..HEAD -- contracts/contracts/`)

```diff
diff --git a/contracts/contracts/CensusCurve.sol b/contracts/contracts/CensusCurve.sol
index 59ce396..7d203ca 100644
--- a/contracts/contracts/CensusCurve.sol
+++ b/contracts/contracts/CensusCurve.sol
@@ -50,8 +50,22 @@ contract CensusCurve is ReentrancyGuard {
     ///         never gives value away — but a pool too deep to restore within this bound makes
     ///         graduation revert (fail closed) rather than migrate at a manipulated price.
     uint16 public constant RECOVERY_MAX_SPEND_BPS = 1_000; // 10%
+    /// @notice Hard ceiling for a per-coin recovery-bound override (see setRecoveryMaxSpendBps).
+    uint16 public constant RECOVERY_MAX_SPEND_CAP_BPS = 5_000; // 50%
+    /// @notice Deployer-raised recovery bound for one coin whose graduation is being griefed by
+    ///         parked liquidity (0 = use RECOVERY_MAX_SPEND_BPS). Every unit swapped still executes
+    ///         at better than the migration price, so a wider bound never gives value away; it only
+    ///         lets the curve absorb more of the attacker's liquidity before minting.
+    mapping(address => uint16) public recoveryMaxSpendBps;
     mapping(address => uint256) public migrationTokenDust;
     mapping(address => uint256) public migrationQuoteDust;
+    /// @notice Fees a recipient could not receive (issuer pause/blacklist on the quote asset). Trading
+    ///         never halts on a blocked fee recipient: the amount is held here and can be pushed to
+    ///         the recipient later by anyone via withdrawDeferredFee().
+    mapping(address => mapping(address => uint256)) public deferredFee; // quote => recipient => amount
+    /// @notice Platform keeper: also authorized to run every DividendVault's conversions/distributions
+    ///         (see DividendVault._checkOperator), so rewards are auto-distributed without per-coin delegation.
+    address public keeper;
     address private recoveryPool; // pool allowed to invoke the swap callback, only during graduate()
     int24 private constant MIN_TICK = -887272;
     int24 private constant MAX_TICK = 887272;
@@ -100,6 +114,11 @@ contract CensusCurve is ReentrancyGuard {
     event Traded(address indexed coin, address indexed trader, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 fee);
     event Graduated(address indexed coin, address pool, uint256 tokenId, uint256 tokensIn, uint256 quoteIn);
     event MigrationPriceRestored(address indexed coin, address pool, uint160 poolSqrtPriceX96, uint160 targetSqrtPriceX96, int256 amount0Delta, int256 amount1Delta);
+    event KeeperSet(address indexed keeper);
+    event RecoveryBoundSet(address indexed coin, uint16 bps);
+    event FeeDeferred(address indexed quote, address indexed recipient, uint256 amount);
+    event DeferredFeeWithdrawn(address indexed quote, address indexed recipient, uint256 amount);
+    event MigrationDustSwept(address indexed coin, uint256 tokenAmount, uint256 quoteAmount);
 
     error NotDeployer();
     error NotFactory();
@@ -109,6 +128,16 @@ contract CensusCurve is ReentrancyGuard {
     error NotReady();
     error Slippage();
     error NotZappable();
+    error QuoteNotSupported();
+    error BadParams();
+    error BadPoolFee();
+    error SupplyNotFunded();
+    error ZeroAmount();
+    error CurveLimit();
+    error UnsupportedQuote();
+    error RecoveryFailed();
+    error EthTransferFailed();
+    error NotGraduated();
 
     constructor(address npm_, address platform_, address locker_, address weth_, address swapRouter_) {
         require(npm_ != address(0) && platform_ != address(0) && locker_ != address(0) && weth_ != address(0) && swapRouter_ != address(0), "zero");
@@ -140,6 +169,48 @@ contract CensusCurve is ReentrancyGuard {
         emit QuoteAllowed(quote, ok);
     }
 
+    /// @notice Register the platform keeper (an address every Maxima vault also accepts as operator).
+    function setKeeper(address keeper_) external {
+        if (msg.sender != deployer) revert NotDeployer();
+        keeper = keeper_;
+        emit KeeperSet(keeper_);
+    }
+
+    /// @notice Escape hatch for a griefed graduation: widen ONE coin's bounded recovery swap (up to
+    ///         RECOVERY_MAX_SPEND_CAP_BPS). 0 restores the default. Deployer-only (production custody).
+    function setRecoveryMaxSpendBps(address coin, uint16 bps) external {
+        if (msg.sender != deployer) revert NotDeployer();
+        if (bps > RECOVERY_MAX_SPEND_CAP_BPS) revert BadParams();
+        recoveryMaxSpendBps[coin] = bps;
+        emit RecoveryBoundSet(coin, bps);
+    }
+
+    /// @notice Move a graduated coin's recorded migration leftovers (mint rounding + recovery-swap
+    ///         surplus taken from a mispriced pool) to the platform. Deployer-only; never touches
+    ///         active reserves, and a coin's dust can only be swept once.
+    function sweepMigrationDust(address coin) external nonReentrant {
+        if (msg.sender != deployer) revert NotDeployer();
+        Curve storage c = curves[coin];
+        if (!c.graduated) revert NotGraduated();
+        uint256 t = migrationTokenDust[coin];
+        uint256 q = migrationQuoteDust[coin];
+        migrationTokenDust[coin] = 0;
+        migrationQuoteDust[coin] = 0;
+        if (t > 0) IERC20(coin).safeTransfer(platform, t);
+        if (q > 0) IERC20(c.quote).safeTransfer(platform, q);
+        emit MigrationDustSwept(coin, t, q);
+    }
+
+    /// @notice Push fees that were deferred because `recipient` could not receive them at trade time.
+    ///         Permissionless; reverts (leaving the amount deferred) if the recipient is still blocked.
+    function withdrawDeferredFee(address quote, address recipient) external nonReentrant {
+        uint256 amt = deferredFee[quote][recipient];
+        if (amt == 0) revert ZeroAmount();
+        deferredFee[quote][recipient] = 0;
+        IERC20(quote).safeTransfer(recipient, amt);
+        emit DeferredFeeWithdrawn(quote, recipient, amt);
+    }
+
     /// @notice Meme pairing: a COMPANY coin launched on this curve becomes an eligible quote for new
     ///         launches once it has graduated (its permanently-locked canonical pool then exists, so
     ///         it has real price discovery and an ETH-zap route that pays LP fees into the locked
@@ -172,11 +243,11 @@ contract CensusCurve is ReentrancyGuard {
     ) external {
         if (!factory[msg.sender]) revert NotFactory();
         if (curves[coin].exists) revert AlreadyRegistered();
-        require(allowedQuote[quote] || isPairableCompanyCoin(quote), "quote not supported");
-        require(holdersBps <= BPS, "bps");
-        require(vault != address(0) || holdersBps == 0, "vault required for holders");
-        require(virtualQuote > 0 && tokenSupply > 0 && graduationQuote > 0, "params");
-        require(IERC20(coin).balanceOf(address(this)) >= tokenSupply, "supply not funded");
+        if (!(allowedQuote[quote] || isPairableCompanyCoin(quote))) revert QuoteNotSupported();
+        if (holdersBps > BPS || (vault == address(0) && holdersBps != 0)) revert BadParams();
+        if (poolFee != 100 && poolFee != 500 && poolFee != 3000 && poolFee != 10000) revert BadPoolFee();
+        if (virtualQuote == 0 || tokenSupply == 0 || graduationQuote == 0) revert BadParams();
+        if (IERC20(coin).balanceOf(address(this)) < tokenSupply) revert SupplyNotFunded();
         curves[coin] = Curve({
             quote: quote, creator: creator, vault: vault, holdersBps: holdersBps, poolFee: poolFee,
             virtualQuote: virtualQuote, tokenReserve: tokenSupply, realQuote: 0,
@@ -191,9 +262,18 @@ contract CensusCurve is ReentrancyGuard {
         uint256 creatorSide = fee - protocol;
         uint256 toHolders = c.holdersBps == 0 ? 0 : (creatorSide * c.holdersBps) / BPS;
         uint256 toCreator = creatorSide - toHolders;
-        if (protocol > 0) IERC20(c.quote).safeTransfer(platform, protocol);
-        if (toHolders > 0) IERC20(c.quote).safeTransfer(c.vault, toHolders);
-        if (toCreator > 0) IERC20(c.quote).safeTransfer(c.creator, toCreator);
+        if (protocol > 0) _payFee(c.quote, platform, protocol);
+        if (toHolders > 0) _payFee(c.quote, c.vault, toHolders);
+        if (toCreator > 0) _payFee(c.quote, c.creator, toCreator);
+    }
+
+    /// @dev Push a fee share; if the recipient cannot receive the quote asset right now (issuer
+    ///      blacklist/pause), hold it as a deferred fee instead of halting every trade of the coin.
+    function _payFee(address quote, address to, uint256 amount) internal {
+        (bool ok, bytes memory ret) = quote.call(abi.encodeCall(IERC20.transfer, (to, amount)));
+        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) return;
+        deferredFee[quote][to] += amount;
+        emit FeeDeferred(quote, to, amount);
     }
 
     // ----------------------------- trading -----------------------------
@@ -204,10 +284,10 @@ contract CensusCurve is ReentrancyGuard {
         Curve storage c = curves[coin];
         if (!c.exists) revert UnknownCoin();
         if (c.graduated) revert AlreadyGraduated();
-        require(quoteIn > 0, "amount");
+        if (quoteIn == 0) revert ZeroAmount();
         uint256 beforeQuote = IERC20(c.quote).balanceOf(address(this));
         IERC20(c.quote).safeTransferFrom(msg.sender, address(this), quoteIn);
-        require(IERC20(c.quote).balanceOf(address(this)) - beforeQuote == quoteIn, "unsupported quote");
+        if (IERC20(c.quote).balanceOf(address(this)) - beforeQuote != quoteIn) revert UnsupportedQuote();
         return _buy(c, coin, quoteIn, minTokensOut);
     }
 
@@ -221,7 +301,7 @@ contract CensusCurve is ReentrancyGuard {
         Curve storage c = curves[coin];
         if (!c.exists) revert UnknownCoin();
         if (c.graduated) revert AlreadyGraduated();
-        require(msg.value > 0, "amount");
+        if (msg.value == 0) revert ZeroAmount();
         IWETH(weth).deposit{value: msg.value}(); // this contract now holds msg.value WETH
         uint256 quoteIn = c.quote == weth ? msg.value : _swap(weth, zapPathIn[c.quote], msg.value);
         return _buy(c, coin, quoteIn, minTokensOut);
@@ -245,7 +325,7 @@ contract CensusCurve is ReentrancyGuard {
 
         // constant product: tokensOut = tokenReserve * netIn / (V + netIn)
         tokensOut = Math.mulDiv(c.tokenReserve, netIn, c.virtualQuote + netIn);
-        require(tokensOut > 0 && tokensOut < c.tokenReserve, "curve"); // never drain the curve dry
+        if (tokensOut == 0 || tokensOut >= c.tokenReserve) revert CurveLimit(); // never drain the curve dry
         if (tokensOut < minTokensOut) revert Slippage();
 
         // effects
@@ -266,7 +346,7 @@ contract CensusCurve is ReentrancyGuard {
         Curve storage c = curves[coin];
         if (!c.exists) revert UnknownCoin();
         if (c.graduated) revert AlreadyGraduated();
-        require(tokensIn > 0, "amount");
+        if (tokensIn == 0) revert ZeroAmount();
         IERC20(coin).safeTransferFrom(msg.sender, address(this), tokensIn);
         quoteOut = _sell(c, coin, tokensIn, minQuoteOut);
         IERC20(c.quote).safeTransfer(msg.sender, quoteOut);
@@ -281,7 +361,7 @@ contract CensusCurve is ReentrancyGuard {
         Curve storage c = curves[coin];
         if (!c.exists) revert UnknownCoin();
         if (c.graduated) revert AlreadyGraduated();
-        require(tokensIn > 0, "amount");
+        if (tokensIn == 0) revert ZeroAmount();
         IERC20(coin).safeTransferFrom(msg.sender, address(this), tokensIn);
         // Slippage is checked on the FINAL ETH below (0 here), so it spans the curve + the swap.
         uint256 quoteOut = _sell(c, coin, tokensIn, 0);
@@ -289,7 +369,7 @@ contract CensusCurve is ReentrancyGuard {
         if (wethOut < minEthOut) revert Slippage();
         IWETH(weth).withdraw(wethOut);
         (bool ok, ) = payable(msg.sender).call{value: wethOut}("");
-        require(ok, "eth transfer failed");
+        if (!ok) revert EthTransferFailed();
         ethOut = wethOut;
     }
 
@@ -298,7 +378,7 @@ contract CensusCurve is ReentrancyGuard {
     function _sell(Curve storage c, address coin, uint256 tokensIn, uint256 minQuoteOut) internal returns (uint256 quoteOut) {
         // constant product: quoteGross = V * tokensIn / (tokenReserve + tokensIn)
         uint256 quoteGross = Math.mulDiv(c.virtualQuote, tokensIn, c.tokenReserve + tokensIn);
-        require(quoteGross > 0 && quoteGross <= c.realQuote, "curve");
+        if (quoteGross == 0 || quoteGross > c.realQuote) revert CurveLimit();
 
         c.tokenReserve += tokensIn;
         c.virtualQuote -= quoteGross;
@@ -396,8 +476,10 @@ contract CensusCurve is ReentrancyGuard {
 
         uint160 adversePrice = current;
         bool zeroForOne = current > target; // selling token0 moves the price down
-        uint256 maxSpend = Math.mulDiv(zeroForOne ? amount0 : amount1, RECOVERY_MAX_SPEND_BPS, BPS);
-        require(maxSpend > 0 && maxSpend <= uint256(type(int256).max), "recovery spend");
+        uint16 boundBps = recoveryMaxSpendBps[coin];
+        if (boundBps == 0) boundBps = RECOVERY_MAX_SPEND_BPS;
+        uint256 maxSpend = Math.mulDiv(zeroForOne ? amount0 : amount1, boundBps, BPS);
+        if (maxSpend == 0 || maxSpend > uint256(type(int256).max)) revert RecoveryFailed();
 
         uint256 bal0Before = IERC20(token0).balanceOf(address(this));
         uint256 bal1Before = IERC20(token1).balanceOf(address(this));
@@ -407,7 +489,7 @@ contract CensusCurve is ReentrancyGuard {
         );
         recoveryPool = address(0);
         (current, , , , , , ) = IUniswapV3Pool(pool).slot0();
-        require(current == target, "recovery failed");
+        if (current != target) revert RecoveryFailed();
 
         emit MigrationPriceRestored(coin, pool, adversePrice, target, d0, d1);
         // The swap touches only these two assets, so the deltas belong entirely to this coin.
diff --git a/contracts/contracts/DividendVault.sol b/contracts/contracts/DividendVault.sol
index 506530d..ed10785 100644
--- a/contracts/contracts/DividendVault.sol
+++ b/contracts/contracts/DividendVault.sol
@@ -27,6 +27,10 @@ interface ISwapRouter02 {
     function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
 }
 
+interface ICensusKeeper {
+    function keeper() external view returns (address);
+}
+
 /// @title DividendVault (v2) — production dividend accounting
 /// @notice One per launched v2 token. It receives that token's protocol fee share (in the quote asset,
 ///         e.g. WETH), swaps it across a 1–4 tokenized-stock basket, and pays it out to holders pro-rata.
@@ -73,12 +77,29 @@ contract DividendVault is ReentrancyGuard {
     mapping(address => mapping(address => uint256)) private earnedFraction;
 
     bool private inited;
-    address public operator; // only address allowed to run distribute() (supplies off-chain slippage bounds)
+    /// @notice Distribution operator (defaults to the creator; may delegate). The Census keeper
+    ///         registered on the curve (`CensusCurve.keeper()`) is ALSO authorized, so rewards are
+    ///         converted and distributed automatically without every creator delegating first.
+    address public operator;
 
     event Distributed(uint256 quoteSpent);
     event Claimed(address indexed holder, address indexed stock, uint256 amount);
+    /// @notice A basket asset refused the transfer (issuer pause/blacklist). The entitlement stays
+    ///         reserved for the holder; the other assets in the same claim were still paid.
+    event ClaimDeferred(address indexed holder, address indexed stock, uint256 amount);
     event LaunchFeesConverted(uint256 tokenIn, uint256 quoteOut);
 
+    // Custom errors survive the global revertStrings=strip build, so wallets/UIs can decode reasons.
+    error NotOperator();
+    error MinOut();
+    error Insolvent();
+    error Excluded();
+    error BadParams();
+    error NotEnoughFees();
+    error Unspent();
+    error SwapFailed();
+    error Allocation();
+
     constructor(
         address quote_,
         address router_,
@@ -126,6 +147,8 @@ contract DividendVault is ReentrancyGuard {
         inited = true;
         token = token_;
         operator = operator_;
+        excluded[address(this)] = true; // the vault's own launch-token balance (LP fees) never earns
+        excludedList.push(address(this));
         for (uint256 i; i < excluded_.length; i++) {
             if (!excluded[excluded_[i]]) {
                 excluded[excluded_[i]] = true;
@@ -137,11 +160,19 @@ contract DividendVault is ReentrancyGuard {
     /// @notice Hand distribution rights to a keeper (defaults to the creator). The operator supplies
     ///         off-chain-computed minimum outputs so the basket swaps can't be sandwiched.
     function setOperator(address newOperator) external {
-        require(msg.sender == operator, "not operator");
+        if (msg.sender != operator) revert NotOperator();
         require(newOperator != address(0), "zero");
         operator = newOperator;
     }
 
+    /// @dev The per-coin operator OR the platform keeper registered on the curve may run conversions
+    ///      and distributions (both supply off-chain minimum outputs and are trusted for price bounds).
+    function _checkOperator() internal view {
+        if (msg.sender == operator) return;
+        if (census != address(0) && msg.sender == ICensusKeeper(census).keeper()) return;
+        revert NotOperator();
+    }
+
     address public census; // the CensusCurve, allowed to exclude the graduated pool once it exists
 
     /// @notice Wired once by the factory: the CensusCurve. It excludes the graduated Uniswap pool from
@@ -228,8 +259,8 @@ contract DividendVault is ReentrancyGuard {
     /// @param minOut per-stock minimum output (computed off-chain from a fair price) — the swap reverts
     ///        if the pool would give less. A minimum output bounds loss; it does not eliminate MEV.
     function distribute(uint256[] calldata minOut) external nonReentrant returns (uint256 spent) {
-        require(msg.sender == operator, "not operator");
-        require(minOut.length == basket.length, "minOut");
+        _checkOperator();
+        if (minOut.length != basket.length) revert BadParams();
         uint256 amt = availableQuote();
         uint256 elig = eligibleSupply();
         if (amt == 0 || elig == 0) return 0;
@@ -242,9 +273,9 @@ contract DividendVault is ReentrancyGuard {
                 // Anchor-paid dividend: fees are already in the payout asset (e.g. a HOOD-paired coin
                 // pays holders HOOD). No swap needed — credit the portion straight through.
                 got = portion;
-                require(got >= minOut[i], "minOut");
+                if (got < minOut[i]) revert MinOut();
             } else {
-                require(minOut[i] > 0, "minOut");
+                if (minOut[i] == 0) revert MinOut();
                 got = _sell(quote, basket[i], swapFee, paths[i], portion, minOut[i]);
             }
             _credit(basket[i], got, elig);
@@ -286,9 +317,9 @@ contract DividendVault is ReentrancyGuard {
             );
         }
         IERC20(tokenIn).forceApprove(address(router), 0);
-        require(beforeIn - IERC20(tokenIn).balanceOf(address(this)) == amountIn, "spent");
+        if (beforeIn - IERC20(tokenIn).balanceOf(address(this)) != amountIn) revert Unspent();
         got = IERC20(tokenOut).balanceOf(address(this)) - beforeOut;
-        require(got >= minOut, "minOut");
+        if (got < minOut) revert MinOut();
     }
 
     /// @notice Convert accumulated quote fees into the stock basket via the 0x Swap API and credit
@@ -307,10 +338,10 @@ contract DividendVault is ReentrancyGuard {
         nonReentrant
         returns (uint256 spent)
     {
-        require(msg.sender == operator, "not operator");
+        _checkOperator();
         require(allowanceHolder != address(0), "no 0x");
         uint256 len = basket.length;
-        require(sellAmounts.length == len && swapData.length == len && minOut.length == len, "len");
+        if (sellAmounts.length != len || swapData.length != len || minOut.length != len) revert BadParams();
         uint256 elig = eligibleSupply();
         if (elig == 0) return 0;
 
@@ -318,27 +349,27 @@ contract DividendVault is ReentrancyGuard {
 
         for (uint256 i; i < len; i++) {
             uint256 sell = sellAmounts[i];
-            require(sell == Math.mulDiv(available, weights[i], 10_000), "allocation");
+            if (sell != Math.mulDiv(available, weights[i], 10_000)) revert Allocation();
             if (sell == 0) continue;
             address s = basket[i];
             if (s == quote) {
-                require(swapData[i].length == 0 && sell >= minOut[i], "passthrough");
+                if (swapData[i].length != 0 || sell < minOut[i]) revert MinOut();
                 _credit(s, sell, elig);
                 spent += sell;
                 continue;
             }
-            require(swapData[i].length > 0 && minOut[i] > 0, "swap");
+            if (swapData[i].length == 0 || minOut[i] == 0) revert MinOut();
             uint256 pre = IERC20(s).balanceOf(address(this));
             uint256 preQuote = IERC20(quote).balanceOf(address(this));
 
             IERC20(quote).forceApprove(allowanceHolder, sell);
             (bool ok, ) = allowanceHolder.call(swapData[i]);
-            require(ok, "0x swap failed");
+            if (!ok) revert SwapFailed();
             IERC20(quote).forceApprove(allowanceHolder, 0); // never leave a standing allowance
-            require(preQuote - IERC20(quote).balanceOf(address(this)) == sell, "spent");
+            if (preQuote - IERC20(quote).balanceOf(address(this)) != sell) revert Unspent();
 
             uint256 got = IERC20(s).balanceOf(address(this)) - pre;
-            require(got >= minOut[i], "minOut");
+            if (got < minOut[i]) revert MinOut();
             _credit(s, got, elig);
             spent += sell;
         }
@@ -359,10 +390,10 @@ contract DividendVault is ReentrancyGuard {
         nonReentrant
         returns (uint256 quoteOut)
     {
-        require(msg.sender == operator, "not operator");
+        _checkOperator();
         require(token != address(0), "uninitialized");
-        require(amountIn > 0 && minQuoteOut > 0, "params");
-        require(amountIn <= IERC20(token).balanceOf(address(this)), "balance");
+        if (amountIn == 0 || minQuoteOut == 0) revert BadParams();
+        if (amountIn > IERC20(token).balanceOf(address(this))) revert NotEnoughFees();
         quoteOut = _sell(token, quote, poolFee, bytes(""), amountIn, minQuoteOut);
         emit LaunchFeesConverted(amountIn, quoteOut);
     }
@@ -388,19 +419,31 @@ contract DividendVault is ReentrancyGuard {
         _claim(holder);
     }
 
+    /// @dev Each basket asset is paid independently: if one issuer refuses the transfer (pause or
+    ///      blacklist), that asset stays reserved for the holder and the remaining assets are still
+    ///      paid, so a single frozen stock cannot brick a holder's whole basket or the keeper's push.
     function _claim(address holder) internal {
-        require(!excluded[holder], "excluded");
+        if (excluded[holder]) revert Excluded();
         uint256 len = basket.length;
         for (uint256 i; i < len; i++) {
             address s = basket[i];
             uint256 amt = withdrawableOf(holder, s);
             if (amt == 0) continue;
             // Never hide a reserve deficit by paying the first claimant preferentially.
-            require(IERC20(s).balanceOf(address(this)) >= reserved[s], "insolvent");
+            if (IERC20(s).balanceOf(address(this)) < reserved[s]) revert Insolvent();
+            if (!_tryTransfer(s, holder, amt)) {
+                emit ClaimDeferred(holder, s, amt);
+                continue;
+            }
             reserved[s] -= amt;
             withdrawn[s][holder] += amt;
-            IERC20(s).safeTransfer(holder, amt);
             emit Claimed(holder, s, amt);
         }
     }
+
+    /// @dev ERC20 transfer that reports failure instead of reverting (tolerates missing return data).
+    function _tryTransfer(address asset, address to, uint256 amount) internal returns (bool) {
+        (bool ok, bytes memory ret) = asset.call(abi.encodeCall(IERC20.transfer, (to, amount)));
+        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
+    }
 }
diff --git a/contracts/contracts/DividendVaultDeployer.sol b/contracts/contracts/DividendVaultDeployer.sol
new file mode 100644
index 0000000..555eeb7
--- /dev/null
+++ b/contracts/contracts/DividendVaultDeployer.sol
@@ -0,0 +1,33 @@
+// SPDX-License-Identifier: MIT
+pragma solidity ^0.8.24;
+
+import {DividendVault} from "./DividendVault.sol";
+
+/// @title DividendVaultDeployer
+/// @notice Creates and wires one DividendVault per Maxima launch on behalf of LaunchFactoryV2.
+///         Holding the vault creation code here (instead of inside the factory's runtime) keeps
+///         LaunchFactoryV2 well under the EIP-170 runtime limit, so vault fixes no longer compete
+///         with the factory for bytecode headroom. Only the factory that deployed this contract may
+///         use it; the vault's `factory` (init/setCensus authority) is this deployer, which performs
+///         the whole wiring in the same call.
+contract DividendVaultDeployer {
+    address public immutable launchFactory;
+
+    error NotLaunchFactory();
+
+    constructor() {
+        launchFactory = msg.sender;
+    }
+
+    function create(
+        address quote, address router, uint24 swapFee,
+        address[] calldata basket, uint16[] calldata weights, bytes[] calldata paths,
+        address allowanceHolder, address token, address[] calldata excluded_, address operator, address census
+    ) external returns (address vault) {
+        if (msg.sender != launchFactory) revert NotLaunchFactory();
+        DividendVault dv = new DividendVault(quote, router, swapFee, basket, weights, paths, allowanceHolder);
+        dv.init(token, excluded_, operator);
+        dv.setCensus(census);
+        vault = address(dv);
+    }
+}
diff --git a/contracts/contracts/LaunchFactoryV2.sol b/contracts/contracts/LaunchFactoryV2.sol
index 1269736..4d62761 100644
--- a/contracts/contracts/LaunchFactoryV2.sol
+++ b/contracts/contracts/LaunchFactoryV2.sol
@@ -3,7 +3,7 @@ pragma solidity ^0.8.24;
 
 import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
 import {LaunchToken} from "./LaunchToken.sol";
-import {DividendVault} from "./DividendVault.sol";
+import {DividendVaultDeployer} from "./DividendVaultDeployer.sol";
 
 interface ICensusCurve {
     function register(
@@ -26,6 +26,9 @@ contract LaunchFactoryV2 {
     address public immutable router;         // Uniswap SwapRouter02, for the vault's quote->stock swaps
     uint24 public immutable stockSwapFee;    // fallback tier for the vault's quote->stock swaps
     address public immutable allowanceHolder; // 0x AllowanceHolder, handed to each vault for its 0x path
+    /// @notice Creates + wires each launch's DividendVault. Keeping the vault creation code out of this
+    ///         contract's runtime keeps the factory far below the EIP-170 limit.
+    DividendVaultDeployer public immutable vaultDeployer;
 
     uint256 private constant ANTISNIPE_WINDOW = 100;
     uint16 private constant ANTISNIPE_MAX_WALLET_BPS = 200; // 2%
@@ -50,6 +53,7 @@ contract LaunchFactoryV2 {
         router = router_;
         stockSwapFee = stockSwapFee_;
         allowanceHolder = allowanceHolder_;
+        vaultDeployer = new DividendVaultDeployer();
     }
 
     /// @dev Default entrypoint: ETH-quoted, 100% of the creator side to holders, no launch-bundle.
@@ -71,11 +75,7 @@ contract LaunchFactoryV2 {
     ) public returns (address token, address vault) {
         address q = quote == address(0) ? weth : quote;
 
-        // 1. Per-token dividend vault (fee asset = the quote).
-        DividendVault dv = new DividendVault(q, router, stockSwapFee, basket, weights, paths, allowanceHolder);
-        vault = address(dv);
-
-        // 2. Token: whole supply mints to this factory.
+        // 1. Token: whole supply mints to this factory.
         LaunchToken t;
         if (salt == bytes32(0)) {
             t = new LaunchToken(p.name, p.symbol, p.totalSupply, p.decimals, address(this));
@@ -85,6 +85,16 @@ contract LaunchFactoryV2 {
         }
         token = address(t);
 
+        // 2. Per-token dividend vault (fee asset = the quote), created and wired by the deployer:
+        //    the curve/factory/dead addresses (and the vault itself) never earn; the creator is the default distribution
+        //    operator (the Census keeper registered on the curve may also run distributions); the curve
+        //    may exclude the graduated pool later.
+        address[] memory ex = new address[](3);
+        ex[0] = curve;
+        ex[1] = address(this);
+        ex[2] = DEAD;
+        vault = _createVault(q, basket, weights, paths, token, ex, msg.sender);
+
         // 3. Seed the whole supply into the curve (before the dividend hook is wired + before anti-snipe).
         IERC20(token).transfer(curve, p.totalSupply);
 
@@ -95,15 +105,7 @@ contract LaunchFactoryV2 {
         for (uint256 i; i < exemptBuyers.length; i++) exempt[i + 2] = exemptBuyers[i];
         t.initAntiSnipe(curve, ANTISNIPE_WINDOW, ANTISNIPE_MAX_WALLET_BPS, ANTISNIPE_MAX_BUY_BPS, address(0), exempt);
 
-        // 5. Wire the vault: exclude the curve/factory/vault/dead from dividends; grant the curve the
-        //    right to also exclude the graduated pool later; wire the token's transfer hook.
-        address[] memory ex = new address[](4);
-        ex[0] = curve;
-        ex[1] = address(this);
-        ex[2] = vault;
-        ex[3] = DEAD;
-        dv.init(token, ex, msg.sender); // creator is the default distribution operator
-        dv.setCensus(curve);
+        // 5. Wire the token's transfer hook to the vault.
         t.setDividendVault(vault);
 
         // 6. Register the curve with the vault + split.
@@ -111,4 +113,11 @@ contract LaunchFactoryV2 {
 
         emit LaunchedV2(token, msg.sender, curve, vault, holdersBps);
     }
+
+    function _createVault(
+        address q, address[] calldata basket, uint16[] calldata weights, bytes[] calldata paths,
+        address token, address[] memory ex, address creator
+    ) internal returns (address) {
+        return vaultDeployer.create(q, router, stockSwapFee, basket, weights, paths, allowanceHolder, token, ex, creator, curve);
+    }
 }
```
