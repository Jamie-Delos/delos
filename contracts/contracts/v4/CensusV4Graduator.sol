// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {CensusV4Hook} from "./CensusV4Hook.sol";

/// @notice Custodies permanent full-range V4 positions. There is no liquidity-removal path.
/// @dev The curve supplies its exit price and reserves; rounding dust returns to the curve.
contract CensusV4Graduator is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    uint256 private constant Q96 = 1 << 96;
    int24 public constant TICK_LOWER = -887220;
    int24 public constant TICK_UPPER = 887220;
    IPoolManager public immutable manager;
    address public immutable curve;
    address public immutable protocol;
    address public immutable deployer;
    CensusV4Hook public hook;
    bytes32 private activeCallback;
    mapping(address => PoolId) public poolIds;
    mapping(address => bool) public graduated;
    mapping(address => uint128) public lockedLiquidity;

    struct Graduation {
        address coin;
        address quote;
        address creator;
        address rewards;
        uint16 reflectionBps;
        uint64 launchedAt;
        uint256 coinAmount;
        uint256 quoteAmount;
        uint160 sqrtPriceX96;
    }
    error Unauthorized();
    error InvalidConfiguration();
    error InvalidReserves();
    error UnsupportedToken();
    event Graduated(address indexed coin, PoolId indexed poolId, uint128 liquidity, uint256 coinUsed, uint256 quoteUsed);

    constructor(IPoolManager manager_, address curve_, address protocol_) {
        if (address(manager_).code.length == 0 || curve_ == address(0) || protocol_ == address(0)) revert InvalidConfiguration();
        manager = manager_; curve = curve_; protocol = protocol_; deployer = msg.sender;
    }

    /// @dev One-time wiring resolves the hook's CREATE2 address dependency.
    function setHook(CensusV4Hook hook_) external {
        if (msg.sender != deployer || address(hook) != address(0)) revert Unauthorized();
        if (address(hook_.manager()) != address(manager) || hook_.registrar() != address(this)
            || hook_.protocol() != protocol) revert InvalidConfiguration();
        hook = hook_;
    }

    function graduate(Graduation calldata g) external nonReentrant returns (PoolId id, uint256 coinUsed, uint256 quoteUsed) {
        if (msg.sender != curve) revert Unauthorized();
        if (address(hook) == address(0) || graduated[g.coin] || g.coin == g.quote
            || g.coin == address(0) || g.quote == address(0) || g.coinAmount == 0 || g.quoteAmount == 0) revert InvalidConfiguration();
        bool coin0 = g.coin < g.quote;
        PoolKey memory key = PoolKey(Currency.wrap(coin0 ? g.coin : g.quote), Currency.wrap(coin0 ? g.quote : g.coin), 0, 60, IHooks(address(hook)));
        uint256 amount0 = coin0 ? g.coinAmount : g.quoteAmount;
        uint256 amount1 = coin0 ? g.quoteAmount : g.coinAmount;
        uint160 lower = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 upper = TickMath.getSqrtPriceAtTick(TICK_UPPER);
        if (g.sqrtPriceX96 <= lower || g.sqrtPriceX96 >= upper) revert InvalidReserves();
        uint256 l0 = Math.mulDiv(amount0, Math.mulDiv(g.sqrtPriceX96, upper, Q96), upper - g.sqrtPriceX96);
        uint256 l1 = Math.mulDiv(amount1, Q96, g.sqrtPriceX96 - lower);
        uint256 liq = Math.min(l0, l1);
        if (liq == 0 || liq > uint256(uint128(type(int128).max))) revert InvalidReserves();
        id = key.toId();
        graduated[g.coin] = true;
        poolIds[g.coin] = id;
        lockedLiquidity[g.coin] = uint128(liq);
        hook.register(key, g.quote, g.creator, g.rewards, g.reflectionBps, g.launchedAt);
        manager.initialize(key, g.sqrtPriceX96);
        _pull(g.coin, g.coinAmount);
        _pull(g.quote, g.quoteAmount);
        bytes memory data = abi.encode(key, uint128(liq), amount0, amount1);
        activeCallback = keccak256(data);
        (uint256 used0, uint256 used1) = abi.decode(manager.unlock(data), (uint256, uint256));
        if (activeCallback != bytes32(0)) revert Unauthorized();
        coinUsed = coin0 ? used0 : used1;
        quoteUsed = coin0 ? used1 : used0;
        // No launch inventory is silently burned or parked in this adapter.
        if (g.coinAmount > coinUsed) IERC20(g.coin).safeTransfer(curve, g.coinAmount - coinUsed);
        if (g.quoteAmount > quoteUsed) IERC20(g.quote).safeTransfer(curve, g.quoteAmount - quoteUsed);
        emit Graduated(g.coin, id, uint128(liq), coinUsed, quoteUsed);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager) || activeCallback == bytes32(0) || keccak256(data) != activeCallback) revert Unauthorized();
        activeCallback = bytes32(0);
        (PoolKey memory key, uint128 liq, uint256 amount0, uint256 amount1) = abi.decode(data, (PoolKey, uint128, uint256, uint256));
        (BalanceDelta delta,) = manager.modifyLiquidity(key, ModifyLiquidityParams(TICK_LOWER, TICK_UPPER, int256(uint256(liq)), bytes32(0)), "");
        if (delta.amount0() >= 0 || delta.amount1() >= 0) revert InvalidReserves();
        uint256 used0 = uint256(-int256(delta.amount0()));
        uint256 used1 = uint256(-int256(delta.amount1()));
        // Require >=99.99% of both intended legs, rounding up the minimum.
        if (used0 > amount0 || used1 > amount1 || used0 < amount0 - amount0 / 10000 || used1 < amount1 - amount1 / 10000) revert InvalidReserves();
        _settle(key.currency0, used0);
        _settle(key.currency1, used1);
        return abi.encode(used0, used1);
    }

    function _pull(address asset, uint256 amount) private {
        uint256 beforeBalance = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(curve, address(this), amount);
        if (IERC20(asset).balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedToken();
    }

    function _settle(Currency asset, uint256 amount) private {
        manager.sync(asset);
        IERC20(Currency.unwrap(asset)).safeTransfer(address(manager), amount);
        if (manager.settle() != amount) revert UnsupportedToken();
    }
}
