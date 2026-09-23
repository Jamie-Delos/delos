// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {CensusFeeMath} from "./CensusFeeMath.sol";
import {CensusV4Graduator} from "./CensusV4Graduator.sol";

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/// @dev Uniswap V3 SwapRouter02 multi-hop, used only for the optional native-ETH zap on non-ETH quotes.
interface IV3ExactInputRouter {
    struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @title CensusCurveV4
/// @notice Pump.fun-style bonding curve for every new Census launch (meme and company alike), graduating
///         into a permanently custodied Uniswap V4 pool guarded by the Census hook.
///
///         Pricing: k = V * (tokenReserve + virtualTokenOffset); the offset is never minted. The whole
///         1B supply is real; at the graduation reserve the remaining tokens and the raised quote fit the
///         exit price, so nothing is burned or parked. Rounding dust from the V4 mint returns here.
///
///         Fees (CensusFeeMath, shared with the V4 hook): 2% base on every buy and sell, split 90% Census
///         / 10% creator while on the curve (30/70 after graduation, applied by the hook). An optional
///         1-4% holder reflection is charged ON TOP and paid to the launch's reward vault. Buys in the
///         first three seconds pay the mandatory anti-snipe penalty (99% at launch, decaying), which
///         follows the same 90/10 split; the combined charge never exceeds 99%.
contract CensusCurveV4 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant FEE_BPS = CensusFeeMath.BASE_BPS;
    uint16 public constant SNIPE_TAX_START_BPS = 9900;
    uint256 public constant SNIPE_TAX_SECONDS = CensusFeeMath.WINDOW;
    uint16 public constant CURVE_PROTOCOL_BPS = 9000; // Census share of the base fee (and penalty) on the curve
    uint16 public constant BPS = 10_000;
    /// @dev Gas the filling buy must still hold before the in-buy graduation self-call. Without a floor,
    ///      eth_estimateGas would converge on the cheaper "deferred" outcome (graduation out of gas,
    ///      caught, event emitted) and every wallet would fill the curve without seeding the pool.
    uint256 public constant GRADUATION_GAS_FLOOR = 1_500_000;

    address public immutable platform; // Census treasury: receives the protocol share of every fee
    address public immutable weth;
    IV3ExactInputRouter public immutable swapRouter; // V3 router for the ETH zap on non-ETH quotes
    address public immutable deployer;
    CensusV4Graduator public graduator; // set once; owns every graduated pool's liquidity forever
    address public keeper; // platform keeper, accepted as operator by every reward vault
    mapping(address => bool) public factory;
    mapping(address => bool) public allowedQuote;
    /// @notice Reward assets a launch may put in its basket (tokenised stocks). Deployer-managed and
    ///         additive over time: new stocks are listed here, never by changing contracts. A launch's
    ///         basket is validated against this list at launch and then frozen for that launch.
    mapping(address => bool) public allowedRewardAsset;
    mapping(address => bytes) public zapPathIn;
    mapping(address => bytes) public zapPathOut;

    struct Curve {
        address quote;
        address creator;
        address vault;          // reward vault (holders); zero when reflection is disabled
        uint16 reflectionBps;   // 0, or 100..400 charged on top of the 2% base fee
        uint256 virtualQuote;
        uint256 tokenReserve;
        uint256 realQuote;
        uint256 graduationQuote;
        bool graduated;
        bool exists;
    }
    mapping(address => Curve) public curves;
    mapping(address => uint256) public virtualTokenOffset;
    mapping(address => uint256) public launchedAt;
    mapping(address => mapping(address => bool)) public snipeTaxExempt;
    mapping(address => PoolId) public poolIds;
    mapping(address => uint256) public migrationTokenDust;
    mapping(address => uint256) public migrationQuoteDust;
    mapping(address => mapping(address => uint256)) public deferredFee; // quote => recipient => amount

    event FactorySet(address indexed factory, bool allowed);
    event QuoteAllowed(address indexed quote, bool allowed);
    event RewardAssetAllowed(address indexed asset, bool allowed);
    event ZapPathSet(address indexed quote, bytes pathIn, bytes pathOut);
    event GraduatorSet(address indexed graduator, address hook);
    event KeeperSet(address indexed keeper);
    event Registered(address indexed coin, address quote, address creator, address vault, uint16 reflectionBps, uint256 virtualQuote, uint256 graduationQuote, uint256 virtualTokenOffset);
    event LaunchWindow(address indexed coin, uint256 launchedAt, uint256 secondsWindow, uint16 startBps);
    event SnipeTaxExempted(address indexed coin, address indexed account);
    event SnipeTaxCharged(address indexed coin, address indexed buyer, uint256 amount);
    event Traded(address indexed coin, address indexed trader, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 fee);
    event FeeAllocated(address indexed coin, bool isBuy, uint256 protocolFee, uint256 creatorFee, uint256 holderFee, uint256 penalty);
    event BuyRefunded(address indexed coin, address indexed buyer, address quote, uint256 amount, bool nativeRefund);
    event Graduated(address indexed coin, bytes32 indexed poolId, uint256 tokensIn, uint256 quoteIn, uint128 liquidity);
    /// @notice The filling buy could not seed the V4 pool (revert data attached); the curve is frozen and
    ///         the permissionless `graduate()` retries (the keeper does this automatically).
    event GraduationDeferred(address indexed coin, bytes reason);
    event FeeDeferred(address indexed quote, address indexed recipient, uint256 amount);
    event DeferredFeeWithdrawn(address indexed quote, address indexed recipient, uint256 amount);
    event MigrationDustSwept(address indexed coin, uint256 tokenAmount, uint256 quoteAmount);

    error NotDeployer();
    error NotFactory();
    error AlreadyRegistered();
    error UnknownCoin();
    error AlreadyGraduated();
    error NotReady();
    error NotSelf();
    error InsufficientGas();
    error NotConfigured();
    error Slippage();
    error NotZappable();
    error QuoteNotSupported();
    error BadParams();
    error SupplyNotFunded();
    error ZeroAmount();
    error CurveLimit();
    error UnsupportedQuote();
    error EthTransferFailed();
    error NotGraduated();
    error CurveFilled();

    constructor(address platform_, address weth_, address swapRouter_) {
        if (platform_ == address(0) || weth_ == address(0) || swapRouter_ == address(0)) revert BadParams();
        platform = platform_;
        weth = weth_;
        swapRouter = IV3ExactInputRouter(swapRouter_);
        deployer = msg.sender;
        allowedQuote[weth_] = true;
        emit QuoteAllowed(weth_, true);
    }

    receive() external payable {}

    // ----------------------------- deployer configuration -----------------------------

    /// @notice One-time wiring of the V4 graduator (which must already have its hook). The graduator
    ///         must be built for this curve and pay the same Census treasury.
    function setGraduator(CensusV4Graduator g) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (address(graduator) != address(0)) revert AlreadyRegistered();
        if (g.curve() != address(this) || g.protocol() != platform || address(g.hook()) == address(0)) revert BadParams();
        graduator = g;
        emit GraduatorSet(address(g), address(g.hook()));
    }

    function setFactory(address f, bool ok) external {
        if (msg.sender != deployer) revert NotDeployer();
        factory[f] = ok;
        emit FactorySet(f, ok);
    }

    function setQuoteAllowed(address quote, bool ok) external {
        if (msg.sender != deployer) revert NotDeployer();
        allowedQuote[quote] = ok;
        emit QuoteAllowed(quote, ok);
    }

    /// @notice List (or delist, for NEW launches only) a tokenised stock as a basket asset.
    function setRewardAssetAllowed(address asset, bool ok) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (asset == address(0) || asset.code.length == 0) revert BadParams();
        allowedRewardAsset[asset] = ok;
        emit RewardAssetAllowed(asset, ok);
    }

    function setKeeper(address keeper_) external {
        if (msg.sender != deployer) revert NotDeployer();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function setZapPath(address quote, bytes calldata pathIn, bytes calldata pathOut) external {
        if (msg.sender != deployer) revert NotDeployer();
        zapPathIn[quote] = pathIn;
        zapPathOut[quote] = pathOut;
        emit ZapPathSet(quote, pathIn, pathOut);
    }

    /// @notice Move a graduated coin's recorded V4 mint rounding dust to the treasury. Never touches
    ///         active reserves; a coin's dust can only be swept once.
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

    function withdrawDeferredFee(address quote, address recipient) external nonReentrant {
        uint256 amt = deferredFee[quote][recipient];
        if (amt == 0) revert ZeroAmount();
        deferredFee[quote][recipient] = 0;
        IERC20(quote).safeTransfer(recipient, amt);
        emit DeferredFeeWithdrawn(quote, recipient, amt);
    }

    /// @notice A graduated company coin whose own quote is deployer-approved collateral can quote new launches.
    function isPairableCompanyCoin(address q) public view returns (bool) {
        Curve storage qc = curves[q];
        return qc.exists && qc.graduated && allowedQuote[qc.quote];
    }

    // ----------------------------- registration -----------------------------

    /// @notice Called by a launch factory after it has minted the whole supply to this contract.
    function register(
        address coin, address quote, address creator, address vault, uint16 reflectionBps,
        uint256 virtualQuote, uint256 tokenSupply, uint256 graduationQuote
    ) public {
        if (!factory[msg.sender]) revert NotFactory();
        if (address(graduator) == address(0)) revert NotConfigured();
        if (curves[coin].exists) revert AlreadyRegistered();
        if (!(allowedQuote[quote] || isPairableCompanyCoin(quote))) revert QuoteNotSupported();
        if (coin == quote || creator == address(0)) revert BadParams();
        CensusFeeMath.validateReflection(reflectionBps);
        if ((reflectionBps == 0) != (vault == address(0))) revert BadParams();
        if (virtualQuote == 0 || tokenSupply == 0 || graduationQuote == 0) revert BadParams();
        if (IERC20(coin).balanceOf(address(this)) < tokenSupply) revert SupplyNotFunded();
        uint256 offset = Math.mulDiv(Math.mulDiv(tokenSupply, virtualQuote, graduationQuote), virtualQuote, graduationQuote + 2 * virtualQuote);
        if (offset == 0) revert BadParams();
        uint256 initialTokenReserve = tokenSupply + offset;
        if (initialTokenReserve <= tokenSupply) revert BadParams();
        virtualTokenOffset[coin] = offset;
        curves[coin] = Curve({
            quote: quote, creator: creator, vault: vault, reflectionBps: reflectionBps,
            virtualQuote: virtualQuote, tokenReserve: tokenSupply, realQuote: 0,
            graduationQuote: graduationQuote, graduated: false, exists: true
        });
        emit Registered(coin, quote, creator, vault, reflectionBps, virtualQuote, graduationQuote, offset);
        launchedAt[coin] = block.timestamp;
        snipeTaxExempt[coin][creator] = true;
        emit LaunchWindow(coin, block.timestamp, SNIPE_TAX_SECONDS, SNIPE_TAX_START_BPS);
        emit SnipeTaxExempted(coin, creator);
    }

    /// @notice Register and freeze creator-authorised launch-bundle exemptions atomically.
    function registerWithExemptions(
        address coin, address quote, address creator, address vault, uint16 reflectionBps,
        uint256 virtualQuote, uint256 tokenSupply, uint256 graduationQuote, address[] calldata exemptBuyers
    ) external {
        if (exemptBuyers.length > 32) revert BadParams();
        register(coin, quote, creator, vault, reflectionBps, virtualQuote, tokenSupply, graduationQuote);
        for (uint256 i; i < exemptBuyers.length; ++i) {
            if (exemptBuyers[i] == address(0)) revert BadParams();
            snipeTaxExempt[coin][exemptBuyers[i]] = true;
            emit SnipeTaxExempted(coin, exemptBuyers[i]);
        }
    }

    // ----------------------------- fees -----------------------------

    function _fees(address coin, Curve storage c, uint256 gross, bool isBuy, address buyer) internal view returns (CensusFeeMath.Fees memory f) {
        bool penalized = isBuy && !snipeTaxExempt[coin][buyer];
        f = CensusFeeMath.calculate(gross, c.reflectionBps, block.timestamp - launchedAt[coin], penalized, false);
    }

    function _distributeFee(address coin, Curve storage c, CensusFeeMath.Fees memory f, bool isBuy) internal {
        if (f.total == 0) return;
        if (f.protocol > 0) _payFee(c.quote, platform, f.protocol);
        if (f.creator > 0) _payFee(c.quote, c.creator, f.creator);
        if (f.holders > 0) _payFee(c.quote, c.vault, f.holders);
        emit FeeAllocated(coin, isBuy, f.protocol, f.creator, f.holders, f.penalty);
    }

    /// @dev Push a fee share; a recipient that cannot receive the quote right now (issuer pause or
    ///      blacklist) gets a deferred balance instead of halting every trade of the coin.
    function _payFee(address quote, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = quote.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) return;
        deferredFee[quote][to] += amount;
        emit FeeDeferred(quote, to, amount);
    }

    // ----------------------------- trading -----------------------------

    function buy(address coin, uint256 quoteIn, uint256 minTokensOut) external nonReentrant returns (uint256 tokensOut) {
        Curve storage c = curves[coin];
        if (!c.exists) revert UnknownCoin();
        if (c.graduated) revert AlreadyGraduated();
        if (quoteIn == 0) revert ZeroAmount();
        uint256 beforeQuote = IERC20(c.quote).balanceOf(address(this));
        IERC20(c.quote).safeTransferFrom(msg.sender, address(this), quoteIn);
        if (IERC20(c.quote).balanceOf(address(this)) - beforeQuote != quoteIn) revert UnsupportedQuote();
        return _buy(c, coin, quoteIn, minTokensOut, false);
    }

    /// @notice One-tap native ETH buy: wraps to WETH, or zaps WETH into a non-ETH quote through the
    ///         configured V3 route first. Excess on a capped final fill is refunded (ETH for WETH coins).
    function buyWithETH(address coin, uint256 minTokensOut) external payable nonReentrant returns (uint256 tokensOut) {
        Curve storage c = curves[coin];
        if (!c.exists) revert UnknownCoin();
        if (c.graduated) revert AlreadyGraduated();
        if (msg.value == 0) revert ZeroAmount();
        IWETH9(weth).deposit{value: msg.value}();
        uint256 quoteIn = c.quote == weth ? msg.value : _swap(weth, zapPathIn[c.quote], msg.value);
        return _buy(c, coin, quoteIn, minTokensOut, c.quote == weth);
    }

    function _swap(address tokenIn, bytes storage path, uint256 amountIn) internal returns (uint256 amountOut) {
        if (path.length == 0) revert NotZappable();
        IERC20(tokenIn).forceApprove(address(swapRouter), amountIn);
        amountOut = swapRouter.exactInput(IV3ExactInputRouter.ExactInputParams({ path: path, recipient: address(this), amountIn: amountIn, amountOutMinimum: 0 }));
    }

    function _buy(Curve storage c, address coin, uint256 quoteIn, uint256 minTokensOut, bool nativeRefund) internal returns (uint256 tokensOut) {
        uint256 feeBps = buyFeeBps(coin, msg.sender);
        uint256 maximum = _maxBuy(c, feeBps);
        if (maximum == 0) revert CurveFilled();
        uint256 refund = quoteIn > maximum ? quoteIn - maximum : 0;
        quoteIn -= refund;
        CensusFeeMath.Fees memory f = _fees(coin, c, quoteIn, true, msg.sender);
        uint256 netIn = quoteIn - f.total;

        tokensOut = Math.mulDiv(c.tokenReserve + virtualTokenOffset[coin], netIn, c.virtualQuote + netIn);
        if (tokensOut == 0 || tokensOut >= c.tokenReserve) revert CurveLimit();
        if (tokensOut < minTokensOut) revert Slippage();

        c.tokenReserve -= tokensOut;
        c.virtualQuote += netIn;
        c.realQuote += netIn;

        _distributeFee(coin, c, f, true);
        IERC20(coin).safeTransfer(msg.sender, tokensOut);
        emit Traded(coin, msg.sender, true, quoteIn, tokensOut, f.total);
        if (f.penalty > 0) emit SnipeTaxCharged(coin, msg.sender, f.penalty);
        if (refund > 0) {
            if (nativeRefund) {
                IWETH9(weth).withdraw(refund);
                (bool ok, ) = payable(msg.sender).call{value: refund}("");
                if (!ok) revert EthTransferFailed();
            } else {
                IERC20(c.quote).safeTransfer(msg.sender, refund);
            }
            emit BuyRefunded(coin, msg.sender, c.quote, refund, nativeRefund);
        }
        // The buy that fills the reserve graduates the coin in the same transaction.
        if (c.realQuote >= c.graduationQuote) _autoGraduate(coin);
    }

    function sell(address coin, uint256 tokensIn, uint256 minQuoteOut) external nonReentrant returns (uint256 quoteOut) {
        Curve storage c = curves[coin];
        if (!c.exists) revert UnknownCoin();
        if (c.graduated) revert AlreadyGraduated();
        if (tokensIn == 0) revert ZeroAmount();
        IERC20(coin).safeTransferFrom(msg.sender, address(this), tokensIn);
        quoteOut = _sell(c, coin, tokensIn, minQuoteOut);
        IERC20(c.quote).safeTransfer(msg.sender, quoteOut);
    }

    function sellForETH(address coin, uint256 tokensIn, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        Curve storage c = curves[coin];
        if (!c.exists) revert UnknownCoin();
        if (c.graduated) revert AlreadyGraduated();
        if (tokensIn == 0) revert ZeroAmount();
        IERC20(coin).safeTransferFrom(msg.sender, address(this), tokensIn);
        uint256 quoteOut = _sell(c, coin, tokensIn, 0);
        uint256 wethOut = c.quote == weth ? quoteOut : _swap(c.quote, zapPathOut[c.quote], quoteOut);
        if (wethOut < minEthOut) revert Slippage();
        IWETH9(weth).withdraw(wethOut);
        (bool ok, ) = payable(msg.sender).call{value: wethOut}("");
        if (!ok) revert EthTransferFailed();
        ethOut = wethOut;
    }

    function _sell(Curve storage c, address coin, uint256 tokensIn, uint256 minQuoteOut) internal returns (uint256 quoteOut) {
        // A filled curve is frozen: once the reserve is raised nothing can push it back under the target
        // (only reachable when the in-buy graduation was deferred; the retry completes it).
        if (c.realQuote >= c.graduationQuote) revert CurveFilled();
        uint256 quoteGross = Math.mulDiv(c.virtualQuote, tokensIn, c.tokenReserve + virtualTokenOffset[coin] + tokensIn);
        if (quoteGross == 0 || quoteGross > c.realQuote) revert CurveLimit();

        c.tokenReserve += tokensIn;
        c.virtualQuote -= quoteGross;
        c.realQuote -= quoteGross;

        CensusFeeMath.Fees memory f = _fees(coin, c, quoteGross, false, msg.sender);
        _distributeFee(coin, c, f, false);
        quoteOut = quoteGross - f.total;
        if (quoteOut < minQuoteOut) revert Slippage();
        emit Traded(coin, msg.sender, false, tokensIn, quoteOut, f.total);
    }

    // ----------------------------- graduation -----------------------------

    /// @notice Migrate a filled curve into its permanent Uniswap V4 pool. Graduation is AUTOMATIC: the
    ///         buy that fills the reserve performs it in the same transaction (_autoGraduate). This entry
    ///         stays permissionless as the retry path after a GraduationDeferred (the PoolManager or the
    ///         quote token rejected the seeding once); until it succeeds the filled curve is frozen. The
    ///         graduator registers the hook policy (quote, creator, vault, reflection, launch time),
    ///         initialises the pool at the curve's exit price and locks a full-range position it can never
    ///         remove. Mint rounding dust comes back here.
    function graduate(address coin) external nonReentrant returns (PoolId id) {
        return _graduate(coin);
    }

    /// @dev Self-call target for the in-buy graduation: a separate external frame so a V4 or quote-token
    ///      rejection rolls back only the graduation, never the buy that filled the curve.
    function graduateFromBuy(address coin) external returns (PoolId id) {
        if (msg.sender != address(this)) revert NotSelf();
        return _graduate(coin);
    }

    /// @dev Two phases, like a Pons / pump.fun crossing buy. Phase 1 is done by the fill itself: the curve
    ///      is frozen (buys and sells revert CurveFilled). Phase 2 seeds the pool right now; if it reverts
    ///      the reason is surfaced in GraduationDeferred and `graduate()` (keeper-retried) finishes it, so
    ///      reserves can never be stranded and a user's fill never fails because of the pool.
    function _autoGraduate(address coin) internal {
        if (gasleft() < GRADUATION_GAS_FLOOR) revert InsufficientGas();
        try this.graduateFromBuy(coin) {} catch (bytes memory reason) { emit GraduationDeferred(coin, reason); }
    }

    function _graduate(address coin) internal returns (PoolId id) {
        Curve storage c = curves[coin];
        if (!c.exists) revert UnknownCoin();
        if (c.graduated) revert AlreadyGraduated();
        if (c.realQuote < c.graduationQuote) revert NotReady();
        CensusV4Graduator g = graduator;
        if (address(g) == address(0)) revert NotConfigured();
        c.graduated = true;

        uint256 tokenAmt = c.tokenReserve;
        uint256 quoteAmt = c.realQuote;
        c.tokenReserve = 0;
        c.realQuote = 0;

        // Exit price from BOTH virtual reserves; at the capped threshold the real assets match it up to
        // integer rounding (the graduator enforces >= 99.99% consumption of both legs).
        bool coin0 = coin < c.quote;
        uint256 virtualTokens = tokenAmt + virtualTokenOffset[coin];
        uint256 priceNumerator = coin0 ? c.virtualQuote : virtualTokens;
        uint256 priceDenominator = coin0 ? virtualTokens : c.virtualQuote;
        uint256 sqrtRatio = priceNumerator / priceDenominator > type(uint64).max
            ? Math.sqrt(Math.mulDiv(priceNumerator, 1 << 128, priceDenominator)) << 32
            : Math.sqrt(Math.mulDiv(priceNumerator, 1 << 192, priceDenominator));
        if (sqrtRatio > type(uint160).max) revert BadParams();

        IERC20(coin).forceApprove(address(g), tokenAmt);
        IERC20(c.quote).forceApprove(address(g), quoteAmt);
        uint256 coinUsed;
        uint256 quoteUsed;
        (id, coinUsed, quoteUsed) = g.graduate(CensusV4Graduator.Graduation({
            coin: coin, quote: c.quote, creator: c.creator, rewards: c.vault, reflectionBps: c.reflectionBps,
            launchedAt: uint64(launchedAt[coin]), coinAmount: tokenAmt, quoteAmount: quoteAmt, sqrtPriceX96: uint160(sqrtRatio)
        }));
        IERC20(coin).forceApprove(address(g), 0);
        IERC20(c.quote).forceApprove(address(g), 0);
        poolIds[coin] = id;
        migrationTokenDust[coin] = tokenAmt - coinUsed;
        migrationQuoteDust[coin] = quoteAmt - quoteUsed;
        emit Graduated(coin, PoolId.unwrap(id), coinUsed, quoteUsed, g.lockedLiquidity(coin));
    }

    // ----------------------------- views -----------------------------

    function isGraduated(address coin) external view returns (bool) { return curves[coin].graduated; }

    function maxQuoteIn(address coin) external view returns (uint256) {
        return _maxBuy(curves[coin], buyFeeBps(coin, msg.sender));
    }

    function maxQuoteInFor(address coin, address buyer) external view returns (uint256) {
        return _maxBuy(curves[coin], buyFeeBps(coin, buyer));
    }

    /// @notice Penalty bps a buyer would pay right now (already capped so base + reflection + penalty <= 99%).
    function currentSnipeTaxBps(address coin, address buyer) public view returns (uint256) {
        Curve storage c = curves[coin];
        if (!c.exists || c.graduated || snipeTaxExempt[coin][buyer]) return 0;
        (, uint256 penalty) = CensusFeeMath.rates(c.reflectionBps, block.timestamp - launchedAt[coin], true);
        return penalty;
    }

    /// @notice Total buy fee bps for `buyer`: base + reflection + any launch penalty.
    function buyFeeBps(address coin, address buyer) public view returns (uint256) {
        Curve storage c = curves[coin];
        if (!c.exists) return 0;
        (uint256 total, ) = CensusFeeMath.rates(c.reflectionBps, block.timestamp - launchedAt[coin], !c.graduated && !snipeTaxExempt[coin][buyer]);
        return total;
    }

    /// @notice Total sell fee bps: base + reflection.
    function sellFeeBps(address coin) public view returns (uint256) {
        Curve storage c = curves[coin];
        return c.exists ? uint256(FEE_BPS) + c.reflectionBps : 0;
    }

    function _maxBuy(Curve memory c, uint256 feeBps) internal pure returns (uint256) {
        if (!c.exists || c.graduated || c.realQuote >= c.graduationQuote) return 0;
        return Math.mulDiv(c.graduationQuote - c.realQuote, BPS, BPS - feeBps);
    }

    function quoteBuy(address coin, uint256 quoteIn) external view returns (uint256 tokensOut) {
        return quoteBuyFor(coin, quoteIn, msg.sender);
    }

    function quoteBuyFor(address coin, uint256 quoteIn, address buyer) public view returns (uint256 tokensOut) {
        Curve memory c = curves[coin];
        if (!c.exists || c.graduated || quoteIn == 0) return 0;
        uint256 feeBps = buyFeeBps(coin, buyer);
        quoteIn = Math.min(quoteIn, _maxBuy(c, feeBps));
        uint256 netIn = quoteIn - Math.mulDiv(quoteIn, feeBps, BPS);
        tokensOut = Math.mulDiv(c.tokenReserve + virtualTokenOffset[coin], netIn, c.virtualQuote + netIn);
    }

    function quoteSell(address coin, uint256 tokensIn) external view returns (uint256 quoteOut) {
        Curve memory c = curves[coin];
        if (!c.exists || c.graduated || tokensIn == 0) return 0;
        uint256 gross = Math.mulDiv(c.virtualQuote, tokensIn, c.tokenReserve + virtualTokenOffset[coin] + tokensIn);
        if (gross > c.realQuote) return 0;
        quoteOut = gross - Math.mulDiv(gross, sellFeeBps(coin), BPS);
    }

    function graduationProgress(address coin) external view returns (uint256) {
        Curve memory c = curves[coin];
        if (!c.exists || c.graduationQuote == 0) return 0;
        if (c.graduated || c.realQuote >= c.graduationQuote) return BPS;
        return (c.realQuote * BPS) / c.graduationQuote;
    }
}
