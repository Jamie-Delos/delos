// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {LaunchLocker} from "./LaunchLocker.sol";
import {INonfungiblePositionManager} from "./interfaces/IUniswap.sol";

/// @title LaunchFactory
/// @notice Deploys a fixed-supply ERC-20 and opens a single-sided Uniswap V3 position for it
///         in one transaction, then locks the LP NFT forever in the LaunchLocker.
///
/// @dev Tick math is done OFF-CHAIN by the caller (see scripts/lib/launchParams.js). The caller
///      passes a `sqrtPriceX96` starting price and a `[tickLower, tickUpper]` range placed entirely
///      on the sell side of that price, so the position is 100% token / 0% WETH ("single-sided").
contract LaunchFactory {
    INonfungiblePositionManager public immutable npm;
    address public immutable weth;
    LaunchLocker public immutable locker;

    struct LaunchParams {
        string name;
        string symbol;
        uint256 totalSupply; // in base units (already scaled by decimals)
        uint8 decimals;
        uint24 fee; // Uniswap V3 fee tier: 500 / 3000 / 10000
        uint160 sqrtPriceX96; // starting price, ordered as token1/token0
        int24 tickLower;
        int24 tickUpper;
        int24 graduationTick; // tick at which the token graduates (fees flip 100% -> 80/20)
    }

    event Launched(
        address indexed token,
        address indexed creator,
        address pool,
        uint256 tokenId,
        uint128 liquidity
    );

    constructor(address npm_, address weth_, address locker_) {
        npm = INonfungiblePositionManager(npm_);
        weth = weth_;
        locker = LaunchLocker(locker_);
    }

    function createLaunch(LaunchParams calldata p)
        external
        returns (address token, address pool, uint256 tokenId)
    {
        // 1. Deploy the token; whole supply is minted to this factory.
        LaunchToken launchToken =
            new LaunchToken(p.name, p.symbol, p.totalSupply, p.decimals, address(this));
        token = address(launchToken);

        // 2. Determine canonical Uniswap ordering.
        (address token0, address token1) =
            token < weth ? (token, weth) : (weth, token);
        bool tokenIsToken0 = token == token0;

        // 3. Create + initialize the pool at the starting price.
        pool = npm.createAndInitializePoolIfNecessary(token0, token1, p.fee, p.sqrtPriceX96);

        // 4. Mint the single-sided position (all TOKEN, zero WETH) to the locker.
        IERC20(token).approve(address(npm), p.totalSupply);

        uint256 amount0Desired = tokenIsToken0 ? p.totalSupply : 0;
        uint256 amount1Desired = tokenIsToken0 ? 0 : p.totalSupply;

        uint128 liquidity;
        (tokenId, liquidity, , ) = npm.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: p.fee,
                tickLower: p.tickLower,
                tickUpper: p.tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(locker),
                deadline: block.timestamp
            })
        );

        // 5. Sweep any token dust the position rounding left behind to the creator, so nothing
        //    is stranded in the factory.
        uint256 leftover = IERC20(token).balanceOf(address(this));
        if (leftover > 0) IERC20(token).transfer(msg.sender, leftover);

        // 6. Register the lock so fees route to the creator (and flip to 80/20 at graduation).
        //    feeRecipient = 0 => protocol share goes to the global FeeVault (v1 behaviour).
        locker.register(tokenId, msg.sender, token0, token1, pool, p.graduationTick, tokenIsToken0, address(0));

        emit Launched(token, msg.sender, pool, tokenId, liquidity);
    }
}
