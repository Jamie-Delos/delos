// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {INonfungiblePositionManager, IUniswapV3Pool, ISwapRouter} from "./interfaces/IUniswap.sol";

interface ILauncherLocker {
    function registerGraduated(
        uint256 tokenId, address creator, address token0, address token1, address pool,
        bool tokenIsToken0, address vault, uint16 holdersBps
    ) external;
}

interface IDividendVault {
    function excludeAddress(address a) external;
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/// @title CensusCurve
/// @notice The bonding-curve venue for Census coins. Trades executed here pay the 2% fee.
///         Tokens remain transferable: external pools and OTC trades do not pay this curve's fee.
///         When the curve fills to its graduation reserve, it deposits the remaining
///         tokens + the raised quote into a permanently-locked Uniswap V3 pool (the coin's home for
///         life) and stops.
///
///         Pricing: a constant-product AMM with a *virtual* quote reserve V. The curve holds `realQuote`
///         quote and `tokenReserve` tokens; k = V * tokenReserve is invariant (the 2% fee is taken
///         outside the curve, so it never leaks k). Starting FDV (in quote) ≈ the initial V.
///
///         Fee: flat 2% on every buy and sell, split exactly as the rest of Census — 25% platform,
///         and the 75% "creator side" split between the creator and the DividendVault (holders) by a
///         per-coin `holdersBps` (0 = creator only, 10000 = holders only, in-between = both).
contract CensusCurve is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant FEE_BPS = 200;        // 2.00% trade fee
    uint16 public constant PROTOCOL_BPS = 2500;  // 25% of the fee -> platform; 75% -> creator side
    uint16 public constant BPS = 10_000;
    uint16 public constant MIGRATION_MIN_BPS = 9_999; // retain at least 99.99% of each intended LP asset
    /// @notice At most this share of ONE migration leg may be swapped through an adversarially
    ///         pre-initialized pool to restore the migration price. Each unit swapped executes at a
    ///         price better than the migration price (it moves the pool TOWARD it), so the recovery
    ///         never gives value away — but a pool too deep to restore within this bound makes
    ///         graduation revert (fail closed) rather than migrate at a manipulated price.
    uint16 public constant RECOVERY_MAX_SPEND_BPS = 1_000; // 10%
    /// @notice Hard ceiling for a per-coin recovery-bound override (see setRecoveryMaxSpendBps).
    uint16 public constant RECOVERY_MAX_SPEND_CAP_BPS = 5_000; // 50%
    /// @notice Deployer-raised recovery bound for one coin whose graduation is being griefed by
    ///         parked liquidity (0 = use RECOVERY_MAX_SPEND_BPS). Every unit swapped still executes
    ///         at better than the migration price, so a wider bound never gives value away; it only
    ///         lets the curve absorb more of the attacker's liquidity before minting.
    mapping(address => uint16) public recoveryMaxSpendBps;
    mapping(address => uint256) public migrationTokenDust;
    mapping(address => uint256) public migrationQuoteDust;
    /// @notice Fees a recipient could not receive (issuer pause/blacklist on the quote asset). Trading
    ///         never halts on a blocked fee recipient: the amount is held here and can be pushed to
    ///         the recipient later by anyone via withdrawDeferredFee().
    mapping(address => mapping(address => uint256)) public deferredFee; // quote => recipient => amount
    /// @notice Platform keeper: also authorized to run every DividendVault's conversions/distributions
    ///         (see DividendVault._checkOperator), so rewards are auto-distributed without per-coin delegation.
    address public keeper;
    address private recoveryPool; // pool allowed to invoke the swap callback, only during graduate()
    int24 private constant MIN_TICK = -887272;
    int24 private constant MAX_TICK = 887272;

    INonfungiblePositionManager public immutable npm;
    address public immutable platform; // protocol fee recipient
    address public immutable locker;   // LaunchLocker — holds every graduated LP forever
    address public immutable weth;     // wrapped native, for one-tap ETH buy/sell on ETH-quoted coins
    ISwapRouter public immutable swapRouter; // Uniswap V3 SwapRouter02 — for the ETH zap on non-ETH coins
    address public immutable deployer;
    mapping(address => bool) public factory; // authorised launch factories
    /// @notice Supported quote (collateral) assets. Arbitrary quote tokens are rejected at
    ///         registration: shared custody means one misbehaving quote asset (fee-on-transfer,
    ///         rebasing, freezable) could otherwise damage every launch using it. Deployer-managed;
    ///         WETH is enabled at deployment.
    mapping(address => bool) public allowedQuote;

    /// @notice The ETH "zap": for a coin quoted in a non-ETH asset (e.g. HOOD), one-tap ETH buy/sell
    ///         routes WETH<->quote through a Uniswap V3 multi-hop path. Keyed by the quote token and set by
    ///         the deployer. `zapPathIn` is the buy route WETH->...->quote; `zapPathOut` is the sell route
    ///         quote->...->WETH (usually the reverse). Empty path = that quote can't be zapped, so
    ///         buyWithETH/sellForETH only serve WETH coins. HOOD has no direct WETH pool (its liquidity is
    ///         HOOD/USDG), so its path is WETH->USDG->HOOD — a real path only exists on mainnet.
    mapping(address => bytes) public zapPathIn;
    mapping(address => bytes) public zapPathOut;

    struct Curve {
        address quote;          // WETH / HOOD — the reserve asset; all fees + reserves are in it
        address creator;        // creator side recipient
        address vault;          // DividendVault (holders) — 0 for Prima
        uint16 holdersBps;      // share of the 75% creator side to holders via the vault
        uint24 poolFee;         // Uniswap V3 fee tier for the graduated pool
        uint256 virtualQuote;   // V — current virtual quote reserve (starts at the launch's start-FDV)
        uint256 tokenReserve;   // tokens remaining in the curve
        uint256 realQuote;      // quote actually collected (held by this contract for this coin)
        uint256 graduationQuote; // graduate once realQuote >= this
        bool graduated;
        bool exists;
    }
    mapping(address => Curve) public curves; // coin => curve

    event FactorySet(address indexed factory, bool allowed);
    event QuoteAllowed(address indexed quote, bool allowed);
    event ZapPathSet(address indexed quote, bytes pathIn, bytes pathOut);
    event Registered(address indexed coin, address quote, address creator, address vault, uint16 holdersBps, uint256 virtualQuote, uint256 graduationQuote);
    event Traded(address indexed coin, address indexed trader, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 fee);
    event Graduated(address indexed coin, address pool, uint256 tokenId, uint256 tokensIn, uint256 quoteIn);
    event MigrationPriceRestored(address indexed coin, address pool, uint160 poolSqrtPriceX96, uint160 targetSqrtPriceX96, int256 amount0Delta, int256 amount1Delta);
    event KeeperSet(address indexed keeper);
    event RecoveryBoundSet(address indexed coin, uint16 bps);
    event FeeDeferred(address indexed quote, address indexed recipient, uint256 amount);
    event DeferredFeeWithdrawn(address indexed quote, address indexed recipient, uint256 amount);
    event MigrationDustSwept(address indexed coin, uint256 tokenAmount, uint256 quoteAmount);

    error NotDeployer();
    error NotFactory();
    error AlreadyRegistered();
    error UnknownCoin();
    error AlreadyGraduated();
    error NotReady();
    error Slippage();
    error NotZappable();
    error QuoteNotSupported();
    error BadParams();
    error BadPoolFee();
    error SupplyNotFunded();
    error ZeroAmount();
    error CurveLimit();
    error UnsupportedQuote();
    error RecoveryFailed();
    error EthTransferFailed();
    error NotGraduated();

    constructor(address npm_, address platform_, address locker_, address weth_, address swapRouter_) {
        require(npm_ != address(0) && platform_ != address(0) && locker_ != address(0) && weth_ != address(0) && swapRouter_ != address(0), "zero");
        npm = INonfungiblePositionManager(npm_);
        platform = platform_;
        locker = locker_;
        weth = weth_;
        swapRouter = ISwapRouter(swapRouter_);
        deployer = msg.sender;
        allowedQuote[weth_] = true;
        emit QuoteAllowed(weth_, true);
    }

    /// @dev Accept native ETH from WETH.withdraw() during sellForETH. Not a general deposit.
    receive() external payable {}

    function setFactory(address f, bool ok) external {
        if (msg.sender != deployer) revert NotDeployer();
        factory[f] = ok;
        emit FactorySet(f, ok);
    }

    /// @notice Enable/disable a quote (collateral) asset for NEW launches. Review the token's
    ///         transfer/rebase/freeze/upgrade behavior before enabling. Existing curves keep working;
    ///         this gates registration only.
    function setQuoteAllowed(address quote, bool ok) external {
        if (msg.sender != deployer) revert NotDeployer();
        allowedQuote[quote] = ok;
        emit QuoteAllowed(quote, ok);
    }

    /// @notice Register the platform keeper (an address every Maxima vault also accepts as operator).
    function setKeeper(address keeper_) external {
        if (msg.sender != deployer) revert NotDeployer();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    /// @notice Escape hatch for a griefed graduation: widen ONE coin's bounded recovery swap (up to
    ///         RECOVERY_MAX_SPEND_CAP_BPS). 0 restores the default. Deployer-only (production custody).
    function setRecoveryMaxSpendBps(address coin, uint16 bps) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (bps > RECOVERY_MAX_SPEND_CAP_BPS) revert BadParams();
        recoveryMaxSpendBps[coin] = bps;
        emit RecoveryBoundSet(coin, bps);
    }

    /// @notice Move a graduated coin's recorded migration leftovers (mint rounding + recovery-swap
    ///         surplus taken from a mispriced pool) to the platform. Deployer-only; never touches
    ///         active reserves, and a coin's dust can only be swept once.
    function sweepMigrationDust(address coin) external nonReentrant {
        if (msg.sender != deployer) revert NotDeployer();
        Curve storage c = curves[coin];
        if (!c.graduated) revert NotGraduated();
        uint256 t = migrationTokenDust[coin];
        uint256 q = migrationQuoteDust[coin];
        migrationTokenDust[coin] = 0;
        migrationQuoteDust[coin] = 0;
        if (t > 0) IERC20(coin).safeTransfer(platform, t);
        if (q > 0) IERC20(c.quote).safeTransfer(platform, q);
        emit MigrationDustSwept(coin, t, q);
    }

    /// @notice Push fees that were deferred because `recipient` could not receive them at trade time.
    ///         Permissionless; reverts (leaving the amount deferred) if the recipient is still blocked.
    function withdrawDeferredFee(address quote, address recipient) external nonReentrant {
        uint256 amt = deferredFee[quote][recipient];
        if (amt == 0) revert ZeroAmount();
        deferredFee[quote][recipient] = 0;
        IERC20(quote).safeTransfer(recipient, amt);
        emit DeferredFeeWithdrawn(quote, recipient, amt);
    }

    /// @notice Meme pairing: a COMPANY coin launched on this curve becomes an eligible quote for new
    ///         launches once it has graduated (its permanently-locked canonical pool then exists, so
    ///         it has real price discovery and an ETH-zap route that pays LP fees into the locked
    ///         position). Only company coins qualify: the candidate's own quote must be a
    ///         deployer-approved collateral, so meme-quoted memes cannot chain further.
    function isPairableCompanyCoin(address q) public view returns (bool) {
        Curve storage qc = curves[q];
        return qc.exists && qc.graduated && allowedQuote[qc.quote];
    }

    /// @notice Enable the ETH zap for a non-ETH quote token by setting its Uniswap V3 multi-hop paths:
    ///         `pathIn` = WETH->...->quote (buy), `pathOut` = quote->...->WETH (sell). Pass empty paths to
    ///         disable. Deployer-only; the quote asset a coin is registered with is unaffected — this only
    ///         powers the buyWithETH/sellForETH convenience. Example (HOOD): pathIn = abi.encodePacked(
    ///         WETH, feeWethUsdg, USDG, feeUsdgHood, HOOD); pathOut = the reverse.
    function setZapPath(address quote, bytes calldata pathIn, bytes calldata pathOut) external {
        if (msg.sender != deployer) revert NotDeployer();
        zapPathIn[quote] = pathIn;
        zapPathOut[quote] = pathOut;
        emit ZapPathSet(quote, pathIn, pathOut);
    }

    /// @notice Called by a launch factory after it has minted the whole supply to this contract.
    /// @param virtualQuote V0 — the virtual quote reserve; ≈ the starting FDV in quote terms.
    /// @param tokenSupply the whole supply now held by this contract for `coin`.
    /// @param graduationQuote graduate once `realQuote` reaches this (e.g. 4 ETH).
    function register(
        address coin, address quote, address creator, address vault, uint16 holdersBps,
        uint24 poolFee, uint256 virtualQuote, uint256 tokenSupply, uint256 graduationQuote
    ) external {
        if (!factory[msg.sender]) revert NotFactory();
        if (curves[coin].exists) revert AlreadyRegistered();
        if (!(allowedQuote[quote] || isPairableCompanyCoin(quote))) revert QuoteNotSupported();
        if (holdersBps > BPS || (vault == address(0) && holdersBps != 0)) revert BadParams();
        if (poolFee != 100 && poolFee != 500 && poolFee != 3000 && poolFee != 10000) revert BadPoolFee();
        if (virtualQuote == 0 || tokenSupply == 0 || graduationQuote == 0) revert BadParams();
        if (IERC20(coin).balanceOf(address(this)) < tokenSupply) revert SupplyNotFunded();
        curves[coin] = Curve({
            quote: quote, creator: creator, vault: vault, holdersBps: holdersBps, poolFee: poolFee,
            virtualQuote: virtualQuote, tokenReserve: tokenSupply, realQuote: 0,
            graduationQuote: graduationQuote, graduated: false, exists: true
        });
        emit Registered(coin, quote, creator, vault, holdersBps, virtualQuote, graduationQuote);
    }

    function _distributeFee(Curve storage c, uint256 fee) internal {
        if (fee == 0) return;
        uint256 protocol = (fee * PROTOCOL_BPS) / BPS;
        uint256 creatorSide = fee - protocol;
        uint256 toHolders = c.holdersBps == 0 ? 0 : (creatorSide * c.holdersBps) / BPS;
        uint256 toCreator = creatorSide - toHolders;
        if (protocol > 0) _payFee(c.quote, platform, protocol);
        if (toHolders > 0) _payFee(c.quote, c.vault, toHolders);
        if (toCreator > 0) _payFee(c.quote, c.creator, toCreator);
    }

    /// @dev Push a fee share; if the recipient cannot receive the quote asset right now (issuer
    ///      blacklist/pause), hold it as a deferred fee instead of halting every trade of the coin.
    function _payFee(address quote, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = quote.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) return;
        deferredFee[quote][to] += amount;
        emit FeeDeferred(quote, to, amount);
    }

    // ----------------------------- trading -----------------------------

    /// @notice Buy `coin` with `quoteIn` of the quote asset. Fee is 2% of the input.
    /// @dev Caller must approve `quoteIn` of the quote asset to this contract first.
    function buy(address coin, uint256 quoteIn, uint256 minTokensOut) external nonReentrant returns (uint256 tokensOut) {
        Curve storage c = curves[coin];
        if (!c.exists) revert UnknownCoin();
        if (c.graduated) revert AlreadyGraduated();
        if (quoteIn == 0) revert ZeroAmount();
        uint256 beforeQuote = IERC20(c.quote).balanceOf(address(this));
        IERC20(c.quote).safeTransferFrom(msg.sender, address(this), quoteIn);
        if (IERC20(c.quote).balanceOf(address(this)) - beforeQuote != quoteIn) revert UnsupportedQuote();
        return _buy(c, coin, quoteIn, minTokensOut);
    }

    /// @notice One-tap buy with native ETH. For an ETH-quoted coin it just wraps msg.value to WETH. For a
    ///         coin quoted in another asset (e.g. HOOD) it *zaps*: wraps to WETH, then swaps WETH->quote
    ///         through the quote's configured V3 pool, and buys with the proceeds — all in one call, no
    ///         pre-wrap and no approval. `msg.sender` stays the buyer, so the anti-snipe still applies per
    ///         wallet. `minTokensOut` guards the whole path (swap + curve), so intermediate slippage on
    ///         the swap is covered by the final token check.
    function buyWithETH(address coin, uint256 minTokensOut) external payable nonReentrant returns (uint256 tokensOut) {
        Curve storage c = curves[coin];
        if (!c.exists) revert UnknownCoin();
        if (c.graduated) revert AlreadyGraduated();
        if (msg.value == 0) revert ZeroAmount();
        IWETH(weth).deposit{value: msg.value}(); // this contract now holds msg.value WETH
        uint256 quoteIn = c.quote == weth ? msg.value : _swap(weth, zapPathIn[c.quote], msg.value);
        return _buy(c, coin, quoteIn, minTokensOut);
    }

    /// @dev Swap `amountIn` of `tokenIn` along a Uniswap V3 multi-hop `path`, paid to this contract.
    ///      Reverts if the quote isn't zap-enabled (empty path). Slippage on the leg is left to the
    ///      caller's final min-out check (min tokens on buy, min ETH on sell).
    function _swap(address tokenIn, bytes storage path, uint256 amountIn) internal returns (uint256 amountOut) {
        if (path.length == 0) revert NotZappable();
        IERC20(tokenIn).forceApprove(address(swapRouter), amountIn);
        amountOut = swapRouter.exactInput(
            ISwapRouter.ExactInputParams({ path: path, recipient: address(this), amountIn: amountIn, amountOutMinimum: 0 })
        );
    }

    /// @dev Shared buy core. Assumes `quoteIn` of `c.quote` is already held by this contract.
    function _buy(Curve storage c, address coin, uint256 quoteIn, uint256 minTokensOut) internal returns (uint256 tokensOut) {
        uint256 fee = (quoteIn * FEE_BPS) / BPS;
        uint256 netIn = quoteIn - fee;

        // constant product: tokensOut = tokenReserve * netIn / (V + netIn)
        tokensOut = Math.mulDiv(c.tokenReserve, netIn, c.virtualQuote + netIn);
        if (tokensOut == 0 || tokensOut >= c.tokenReserve) revert CurveLimit(); // never drain the curve dry
        if (tokensOut < minTokensOut) revert Slippage();

        // effects
        c.tokenReserve -= tokensOut;
        c.virtualQuote += netIn;
        c.realQuote += netIn;

        // interactions: pay out the fee, then send the coin (the token's anti-snipe, pool == this curve,
        // guards early buys on this last transfer).
        _distributeFee(c, fee);
        IERC20(coin).safeTransfer(msg.sender, tokensOut);
        emit Traded(coin, msg.sender, true, quoteIn, tokensOut, fee);
    }

    /// @notice Sell `tokensIn` of `coin` back to the curve for the quote asset. Fee is 2% of proceeds.
    /// @dev Caller must approve `tokensIn` of the coin to this contract first.
    function sell(address coin, uint256 tokensIn, uint256 minQuoteOut) external nonReentrant returns (uint256 quoteOut) {
        Curve storage c = curves[coin];
        if (!c.exists) revert UnknownCoin();
        if (c.graduated) revert AlreadyGraduated();
        if (tokensIn == 0) revert ZeroAmount();
        IERC20(coin).safeTransferFrom(msg.sender, address(this), tokensIn);
        quoteOut = _sell(c, coin, tokensIn, minQuoteOut);
        IERC20(c.quote).safeTransfer(msg.sender, quoteOut);
    }

    /// @notice Sell a coin and receive native ETH. For an ETH-quoted coin the curve simply unwraps the
    ///         WETH proceeds. For a coin quoted in another asset (e.g. HOOD) it *zaps*: takes the quote
    ///         proceeds from the curve, swaps quote->WETH, unwraps, and sends ETH. `minEthOut` guards the
    ///         final native amount (so it covers both the curve and the swap leg). Caller must approve
    ///         `tokensIn` of the coin first.
    function sellForETH(address coin, uint256 tokensIn, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        Curve storage c = curves[coin];
        if (!c.exists) revert UnknownCoin();
        if (c.graduated) revert AlreadyGraduated();
        if (tokensIn == 0) revert ZeroAmount();
        IERC20(coin).safeTransferFrom(msg.sender, address(this), tokensIn);
        // Slippage is checked on the FINAL ETH below (0 here), so it spans the curve + the swap.
        uint256 quoteOut = _sell(c, coin, tokensIn, 0);
        uint256 wethOut = c.quote == weth ? quoteOut : _swap(c.quote, zapPathOut[c.quote], quoteOut);
        if (wethOut < minEthOut) revert Slippage();
        IWETH(weth).withdraw(wethOut);
        (bool ok, ) = payable(msg.sender).call{value: wethOut}("");
        if (!ok) revert EthTransferFailed();
        ethOut = wethOut;
    }

    /// @dev Shared sell core: pulls the coin in via the caller, updates reserves, pays the fee, and
    ///      returns the net quote owed to the seller (still held by this contract as the quote asset).
    function _sell(Curve storage c, address coin, uint256 tokensIn, uint256 minQuoteOut) internal returns (uint256 quoteOut) {
        // constant product: quoteGross = V * tokensIn / (tokenReserve + tokensIn)
        uint256 quoteGross = Math.mulDiv(c.virtualQuote, tokensIn, c.tokenReserve + tokensIn);
        if (quoteGross == 0 || quoteGross > c.realQuote) revert CurveLimit();

        c.tokenReserve += tokensIn;
        c.virtualQuote -= quoteGross;
        c.realQuote -= quoteGross;

        uint256 fee = (quoteGross * FEE_BPS) / BPS;
        _distributeFee(c, fee);
        quoteOut = quoteGross - fee;
        if (quoteOut < minQuoteOut) revert Slippage();

        emit Traded(coin, msg.sender, false, tokensIn, quoteOut, fee);
    }

    // ----------------------------- graduation -----------------------------

    /// @notice Migrate a filled curve into a permanently-locked Uniswap V3 pool. Permissionless: anyone
    ///         can call once the curve has raised its graduation reserve. Seeds the pool with the tokens
    ///         still in the curve + all the raised quote, at the price the curve left off, and locks the
    ///         LP NFT forever in the LaunchLocker (post-graduation, LP fees route through the locker
    ///         exactly as before — creator/protocol, and holders' vault for Maxima).
    function graduate(address coin) external nonReentrant returns (address pool, uint256 tokenId) {
        Curve storage c = curves[coin];
        if (!c.exists) revert UnknownCoin();
        if (c.graduated) revert AlreadyGraduated();
        if (c.realQuote < c.graduationQuote) revert NotReady();
        c.graduated = true;

        uint256 tokenAmt = c.tokenReserve;
        uint256 quoteAmt = c.realQuote;
        c.tokenReserve = 0;
        c.realQuote = 0;

        (address token0, address token1) = coin < c.quote ? (coin, c.quote) : (c.quote, coin);
        bool tokenIsToken0 = coin == token0;
        (uint256 amount0, uint256 amount1) = tokenIsToken0 ? (tokenAmt, quoteAmt) : (quoteAmt, tokenAmt);

        // Start price for the pool = the curve's exit price = amount1 / amount0.
        // sqrtPriceX96 = sqrt(amount1/amount0) * 2^96, computed overflow-safe via 512-bit mulDiv.
        uint160 sqrtPriceX96 = uint160(Math.sqrt(Math.mulDiv(amount1, 1 << 192, amount0)));
        pool = npm.createAndInitializePoolIfNecessary(token0, token1, c.poolFee, sqrtPriceX96);

        // If the pool pre-existed at a manipulated price, swap it back to the migration price before
        // minting. The swap is bounded (RECOVERY_MAX_SPEND_BPS of the input leg) and exact-price-limited:
        // every unit executes at better than the migration price (taken from whoever mispriced the pool),
        // and if the bound cannot restore the price the whole graduation reverts — funds stay in the curve.
        (amount0, amount1) = _restoreMigrationPrice(coin, pool, sqrtPriceX96, token0, token1, amount0, amount1);
        (tokenAmt, quoteAmt) = tokenIsToken0 ? (amount0, amount1) : (amount1, amount0);

        // Full-range two-sided position with everything the curve holds. Minimums are price-consistent:
        // the leg left in surplus by a recovery swap is expected to be only partially consumed, and the
        // surplus stays recorded below as migration dust instead of failing the mint.
        (uint256 min0, uint256 min1) = _migrationMinima(sqrtPriceX96, amount0, amount1);
        (int24 tickLower, int24 tickUpper) = _fullRange(c.poolFee);
        IERC20(coin).forceApprove(address(npm), tokenAmt);
        IERC20(c.quote).forceApprove(address(npm), quoteAmt);
        uint256 used0;
        uint256 used1;
        (tokenId, , used0, used1) = npm.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0, token1: token1, fee: c.poolFee, tickLower: tickLower, tickUpper: tickUpper,
                amount0Desired: amount0, amount1Desired: amount1,
                amount0Min: Math.mulDiv(min0, MIGRATION_MIN_BPS, BPS),
                amount1Min: Math.mulDiv(min1, MIGRATION_MIN_BPS, BPS),
                recipient: locker, deadline: block.timestamp
            })
        );

        ILauncherLocker(locker).registerGraduated(tokenId, c.creator, token0, token1, pool, tokenIsToken0, c.vault, c.holdersBps);

        // Maxima: the graduated pool holds LP token balance — exclude it from dividends so it can't accrue.
        if (c.vault != address(0)) IDividendVault(c.vault).excludeAddress(pool);

        // Clear approvals and retain this coin's bounded leftovers separately from active reserves.
        IERC20(coin).forceApprove(address(npm), 0);
        IERC20(c.quote).forceApprove(address(npm), 0);
        uint256 leftToken = tokenAmt - (tokenIsToken0 ? used0 : used1);
        uint256 leftQuote = quoteAmt - (tokenIsToken0 ? used1 : used0);
        // Retain and identify bounded rounding dust; the creator has no reserve-refund entitlement.
        migrationTokenDust[coin] = leftToken;
        migrationQuoteDust[coin] = leftQuote;

        emit Graduated(coin, pool, tokenId, tokenAmt - leftToken, quoteAmt - leftQuote);
    }

    /// @dev If `pool` is not at `target` (someone pre-initialized it at another price), push it back
    ///      with an exact-price-limited swap bounded by RECOVERY_MAX_SPEND_BPS of the input leg. The
    ///      balance deltas (spent input, received output — value-positive at the migration price) are
    ///      attributed to this coin's migration amounts. Reverts unless the pool ends exactly at `target`.
    function _restoreMigrationPrice(
        address coin, address pool, uint160 target, address token0, address token1,
        uint256 amount0, uint256 amount1
    ) internal returns (uint256, uint256) {
        (uint160 current, , , , , , ) = IUniswapV3Pool(pool).slot0();
        if (current == target) return (amount0, amount1);

        uint160 adversePrice = current;
        bool zeroForOne = current > target; // selling token0 moves the price down
        uint16 boundBps = recoveryMaxSpendBps[coin];
        if (boundBps == 0) boundBps = RECOVERY_MAX_SPEND_BPS;
        uint256 maxSpend = Math.mulDiv(zeroForOne ? amount0 : amount1, boundBps, BPS);
        if (maxSpend == 0 || maxSpend > uint256(type(int256).max)) revert RecoveryFailed();

        uint256 bal0Before = IERC20(token0).balanceOf(address(this));
        uint256 bal1Before = IERC20(token1).balanceOf(address(this));
        recoveryPool = pool;
        (int256 d0, int256 d1) = IUniswapV3Pool(pool).swap(
            address(this), zeroForOne, int256(maxSpend), target, abi.encode(token0, token1)
        );
        recoveryPool = address(0);
        (current, , , , , , ) = IUniswapV3Pool(pool).slot0();
        if (current != target) revert RecoveryFailed();

        emit MigrationPriceRestored(coin, pool, adversePrice, target, d0, d1);
        // The swap touches only these two assets, so the deltas belong entirely to this coin.
        amount0 = amount0 + IERC20(token0).balanceOf(address(this)) - bal0Before;
        amount1 = amount1 + IERC20(token1).balanceOf(address(this)) - bal1Before;
        return (amount0, amount1);
    }

    /// @dev Expected consumption of each leg for a full-range mint at sqrtPriceX96: the limiting leg is
    ///      consumed (nearly) fully and the other in the price-implied ratio; any surplus beyond that
    ///      ratio is legitimate leftover (recovery-swap proceeds), not migration slippage.
    function _migrationMinima(uint160 sqrtPriceX96, uint256 amount0, uint256 amount1)
        internal pure returns (uint256 min0, uint256 min1)
    {
        // amount1/amount0 consumed at price P: want1 = amount0 * P where P = (sqrtPriceX96/2^96)^2.
        uint256 want1 = Math.mulDiv(Math.mulDiv(amount0, sqrtPriceX96, 1 << 96), sqrtPriceX96, 1 << 96);
        if (want1 <= amount1) {
            (min0, min1) = (amount0, want1);
        } else {
            (min0, min1) = (Math.mulDiv(Math.mulDiv(amount1, 1 << 96, sqrtPriceX96), 1 << 96, sqrtPriceX96), amount1);
        }
    }

    /// @notice Uniswap V3 swap callback — pays the input side of the migration-recovery swap. Only the
    ///         pool being graduated, only while graduate() is executing.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        require(msg.sender == recoveryPool && msg.sender != address(0), "callback");
        (address token0, address token1) = abi.decode(data, (address, address));
        if (amount0Delta > 0) IERC20(token0).safeTransfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(token1).safeTransfer(msg.sender, uint256(amount1Delta));
    }

    function _fullRange(uint24 fee) internal pure returns (int24 lower, int24 upper) {
        int24 spacing = fee == 100 ? int24(1) : fee == 500 ? int24(10) : fee == 3000 ? int24(60) : int24(200);
        lower = (MIN_TICK / spacing) * spacing;
        upper = (MAX_TICK / spacing) * spacing;
    }

    // ----------------------------- views (for the UI/keepers) -----------------------------

    /// @notice Tokens a buyer would receive for `quoteIn` right now (net of the 2% fee).
    function quoteBuy(address coin, uint256 quoteIn) external view returns (uint256 tokensOut) {
        Curve memory c = curves[coin];
        if (!c.exists || c.graduated || quoteIn == 0) return 0;
        uint256 netIn = quoteIn - (quoteIn * FEE_BPS) / BPS;
        tokensOut = Math.mulDiv(c.tokenReserve, netIn, c.virtualQuote + netIn);
    }

    /// @notice Quote a seller would receive for `tokensIn` right now (net of the 2% fee).
    function quoteSell(address coin, uint256 tokensIn) external view returns (uint256 quoteOut) {
        Curve memory c = curves[coin];
        if (!c.exists || c.graduated || tokensIn == 0) return 0;
        uint256 gross = Math.mulDiv(c.virtualQuote, tokensIn, c.tokenReserve + tokensIn);
        quoteOut = gross - (gross * FEE_BPS) / BPS;
    }

    /// @notice Progress toward graduation in bps (0..10000).
    function graduationProgress(address coin) external view returns (uint256) {
        Curve memory c = curves[coin];
        if (!c.exists || c.graduationQuote == 0) return 0;
        if (c.graduated || c.realQuote >= c.graduationQuote) return BPS;
        return (c.realQuote * BPS) / c.graduationQuote;
    }
}
