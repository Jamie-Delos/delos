// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {LaunchLocker} from "./LaunchLocker.sol";
import {DividendVault} from "./DividendVault.sol";
import {INonfungiblePositionManager} from "./interfaces/IUniswap.sol";

/// @title LaunchFactoryV2 (stock-dividend basket)
/// @notice Same single-sided, locked-LP launch as v1, but each token gets a DividendVault: its
///         protocol fee share is routed to the vault, swapped into a chosen 1–4 stock basket, and
///         paid out to holders. "A memecoin that pays a stock-dividend basket."
contract LaunchFactoryV2 {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    INonfungiblePositionManager public immutable npm;
    address public immutable weth; // quote asset for the launch pool AND the vault's fee asset
    LaunchLocker public immutable locker;
    address public immutable router; // SwapRouter02, for the vault's quote->stock swaps
    uint24 public immutable stockSwapFee; // fee tier of the stock/quote pools the vault buys through

    struct LaunchParams {
        string name;
        string symbol;
        uint256 totalSupply;
        uint8 decimals;
        uint24 fee; // launch pool fee tier (1% standard)
        uint160 sqrtPriceX96;
        int24 tickLower;
        int24 tickUpper;
        int24 graduationTick;
    }

    event LaunchedV2(address indexed token, address indexed creator, address pool, uint256 tokenId, address vault);

    constructor(address npm_, address weth_, address locker_, address router_, uint24 stockSwapFee_) {
        npm = INonfungiblePositionManager(npm_);
        weth = weth_;
        locker = LaunchLocker(locker_);
        router = router_;
        stockSwapFee = stockSwapFee_;
    }

    function createLaunch(LaunchParams calldata p, address[] calldata basket, uint16[] calldata weights)
        external
        returns (address token, address pool, uint256 tokenId, address vault)
    {
        // 1. Per-token dividend vault (holds fee->basket->holder logic).
        DividendVault dv = new DividendVault(weth, router, stockSwapFee, basket, weights);
        vault = address(dv);

        // 2. Token: whole supply minted to this factory.
        LaunchToken launchToken = new LaunchToken(p.name, p.symbol, p.totalSupply, p.decimals, address(this));
        token = address(launchToken);

        // 3. Single-sided Uniswap V3 position, same as v1.
        (address token0, address token1) = token < weth ? (token, weth) : (weth, token);
        bool tokenIsToken0 = token == token0;
        pool = npm.createAndInitializePoolIfNecessary(token0, token1, p.fee, p.sqrtPriceX96);

        IERC20(token).approve(address(npm), p.totalSupply);
        uint256 amount0Desired = tokenIsToken0 ? p.totalSupply : 0;
        uint256 amount1Desired = tokenIsToken0 ? 0 : p.totalSupply;
        (tokenId, , , ) = npm.mint(
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

        uint256 leftover = IERC20(token).balanceOf(address(this));
        if (leftover > 0) IERC20(token).transfer(msg.sender, leftover);

        // 4. Route this token's protocol fee share to its vault, and wire the vault.
        locker.register(tokenId, msg.sender, token0, token1, pool, p.graduationTick, tokenIsToken0, vault);
        address[] memory ex = new address[](5);
        ex[0] = pool;
        ex[1] = address(locker);
        ex[2] = address(this);
        ex[3] = vault;
        ex[4] = DEAD;
        dv.init(token, ex);

        emit LaunchedV2(token, msg.sender, pool, tokenId, vault);
    }
}
