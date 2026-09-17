// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal Uniswap V3 interfaces so the launchpad can compile on Solidity 0.8.x
///      without pulling in the 0.7.6 Uniswap sources.

interface INonfungiblePositionManager {
    function factory() external view returns (address);

    function createAndInitializePoolIfNecessary(
        address token0,
        address token1,
        uint24 fee,
        uint160 sqrtPriceX96
    ) external payable returns (address pool);

    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );

    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// @dev SwapRouter02 exactInput (multi-hop, no deadline param — the SwapRouter02 shape used on Robinhood
///      Chain). Used by CensusCurve's ETH zap to swap WETH<->a non-ETH quote (e.g. HOOD) in one tap.
///      A path is abi.encodePacked(tokenIn, fee, tokenMid, fee, ..., tokenOut) so it supports HOOD, whose
///      only real liquidity is HOOD/USDG (route WETH->USDG->HOOD), not a direct WETH pool.
interface ISwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface IUniswapV3Pool {
    /// @return sqrtPriceX96 current price, tick current tick, and pool state flags.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    /// @dev Direct pool swap (exact-input when amountSpecified > 0). Stops at sqrtPriceLimitX96.
    ///      The caller must implement uniswapV3SwapCallback and pay the positive delta.
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);

    /// @dev Grow the price-oracle ring buffer so the pool can serve a TWAP via observe(). New V3 pools
    ///      start at cardinality 1 (spot only); graduation grows it so the frontend can price/mcap and
    ///      bound trades off a manipulation-resistant average instead of a one-block spot.
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
}
