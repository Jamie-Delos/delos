// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {INonfungiblePositionManager, IUniswapV3Pool, ISwapRouter} from "./interfaces/IUniswap.sol";

interface ILauncherLocker {
    function register(
        uint256 tokenId, address creator, address token0, address token1, address pool,
        int24 graduationTick, bool tokenIsToken0, address feeRecipient
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
/// @notice The bonding-curve venue for every Census coin — the answer to "how do Pons/Flap/pump.fun
///         take a fee retail can't dodge." The whole supply mints straight into this contract; buys
///         and sells trade against a constant-product curve here, NOT against any DEX pool, so there is
///         no pool to route around: every trade — from our app, gmgn, fomo, an aggregator, anything —
///         pays the 2% fee. When the curve fills to its graduation reserve, it deposits the remaining
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
    int24 private constant MIN_TICK = -887272;
    int24 private constant MAX_TICK = 887272;

    INonfungiblePositionManager public immutable npm;
    address public immutable platform; // protocol fee recipient
    address public immutable locker;   // LaunchLocker — holds every graduated LP forever
    address public immutable weth;     // wrapped native, for one-tap ETH buy/sell on ETH-quoted coins
    ISwapRouter public immutable swapRouter; // Uniswap V3 SwapRouter02 — for the ETH zap on non-ETH coins
    address public immutable deployer;
    mapping(address => bool) public factory; // authorised launch factories

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
    event ZapPathSet(address indexed quote, bytes pathIn, bytes pathOut);
    event Registered(address indexed coin, address quote, address creator, address vault, uint16 holdersBps, uint256 virtualQuote, uint256 graduationQuote);
    event Traded(address indexed coin, address indexed trader, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 fee);
    event Graduated(address indexed coin, address pool, uint256 tokenId, uint256 tokensIn, uint256 quoteIn);

    error NotDeployer();
    error NotFactory();
    error AlreadyRegistered();
    error UnknownCoin();
    error AlreadyGraduated();
    error NotReady();
    error Slippage();
    error NotZappable();

    constructor(address npm_, address platform_, address locker_, address weth_, address swapRouter_) {
        require(npm_ != address(0) && platform_ != address(0) && locker_ != address(0) && weth_ != address(0) && swapRouter_ != address(0), "zero");
        npm = INonfungiblePositionManager(npm_);
        platform = platform_;
        locker = locker_;
        weth = weth_;
        swapRouter = ISwapRouter(swapRouter_);
        deployer = msg.sender;
    }

    /// @dev Accept native ETH from WETH.withdraw() during sellForETH. Not a general deposit.
    receive() external payable {}

    function setFactory(address f, bool ok) external {
        if (msg.sender != deployer) revert NotDeployer();
        factory[f] = ok;
        emit FactorySet(f, ok);
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
        require(holdersBps <= BPS, "bps");
        require(vault != address(0) || holdersBps == 0, "vault required for holders");
        require(virtualQuote > 0 && tokenSupply > 0 && graduationQuote > 0, "params");
        require(IERC20(coin).balanceOf(address(this)) >= tokenSupply, "supply not funded");
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
        if (protocol > 0) IERC20(c.quote).safeTransfer(platform, protocol);
        if (toHolders > 0) IERC20(c.quote).safeTransfer(c.vault, toHolders);
        if (toCreator > 0) IERC20(c.quote).safeTransfer(c.creator, toCreator);
    }

    // ----------------------------- trading -----------------------------

    /// @notice Buy `coin` with `quoteIn` of the quote asset. Fee is 2% of the input.
    /// @dev Caller must approve `quoteIn` of the quote asset to this contract first.
    function buy(address coin, uint256 quoteIn, uint256 minTokensOut) external nonReentrant returns (uint256 tokensOut) {
        Curve storage c = curves[coin];
        if (!c.exists) revert UnknownCoin();
        if (c.graduated) revert AlreadyGraduated();
        require(quoteIn > 0, "amount");
        IERC20(c.quote).safeTransferFrom(msg.sender, address(this), quoteIn);
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
        require(msg.value > 0, "amount");
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
        require(tokensOut > 0 && tokensOut < c.tokenReserve, "curve"); // never drain the curve dry
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
        require(tokensIn > 0, "amount");
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
        require(tokensIn > 0, "amount");
        IERC20(coin).safeTransferFrom(msg.sender, address(this), tokensIn);
        // Slippage is checked on the FINAL ETH below (0 here), so it spans the curve + the swap.
        uint256 quoteOut = _sell(c, coin, tokensIn, 0);
        uint256 wethOut = c.quote == weth ? quoteOut : _swap(c.quote, zapPathOut[c.quote], quoteOut);
        if (wethOut < minEthOut) revert Slippage();
        IWETH(weth).withdraw(wethOut);
        (bool ok, ) = payable(msg.sender).call{value: wethOut}("");
        require(ok, "eth transfer failed");
        ethOut = wethOut;
    }

    /// @dev Shared sell core: pulls the coin in via the caller, updates reserves, pays the fee, and
    ///      returns the net quote owed to the seller (still held by this contract as the quote asset).
    function _sell(Curve storage c, address coin, uint256 tokensIn, uint256 minQuoteOut) internal returns (uint256 quoteOut) {
        // constant product: quoteGross = V * tokensIn / (tokenReserve + tokensIn)
        uint256 quoteGross = Math.mulDiv(c.virtualQuote, tokensIn, c.tokenReserve + tokensIn);
        require(quoteGross > 0 && quoteGross <= c.realQuote, "curve");

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

        // Full-range two-sided position with everything the curve holds.
        (int24 tickLower, int24 tickUpper) = _fullRange(c.poolFee);
        IERC20(coin).forceApprove(address(npm), tokenAmt);
        IERC20(c.quote).forceApprove(address(npm), quoteAmt);
        uint256 used0;
        uint256 used1;
        (tokenId, , used0, used1) = npm.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0, token1: token1, fee: c.poolFee, tickLower: tickLower, tickUpper: tickUpper,
                amount0Desired: amount0, amount1Desired: amount1, amount0Min: 0, amount1Min: 0,
                recipient: locker, deadline: block.timestamp
            })
        );

        // Register with the locker as already-graduated (protocol takes its LP-fee share from block one
        // of the pool): pass the pool's current tick as the graduation tick so isGraduated() is true now.
        (, int24 tick, , , , , ) = IUniswapV3Pool(pool).slot0();
        address feeRecipient = c.vault; // Maxima -> holders' vault; Prima -> 0 (global feeVault)
        ILauncherLocker(locker).register(tokenId, c.creator, token0, token1, pool, tick, tokenIsToken0, feeRecipient);

        // Maxima: the graduated pool holds LP token balance — exclude it from dividends so it can't accrue.
        if (c.vault != address(0)) IDividendVault(c.vault).excludeAddress(pool);

        // Clear approvals and return THIS coin's own rounding leftovers (mint may use slightly less than
        // desired) to the creator. Computed from the mint's reported amounts, so it never touches another
        // coin's segregated reserves.
        IERC20(coin).forceApprove(address(npm), 0);
        IERC20(c.quote).forceApprove(address(npm), 0);
        uint256 leftToken = tokenAmt - (tokenIsToken0 ? used0 : used1);
        uint256 leftQuote = quoteAmt - (tokenIsToken0 ? used1 : used0);
        if (leftToken > 0) IERC20(coin).safeTransfer(c.creator, leftToken);
        if (leftQuote > 0) IERC20(c.quote).safeTransfer(c.creator, leftQuote);

        emit Graduated(coin, pool, tokenId, tokenAmt, quoteAmt);
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
