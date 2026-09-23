// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {CensusFeeMath} from "./CensusFeeMath.sol";

/// @notice Canonical V4 fees in the quote asset. No LP fee; no transfer tax on the launch token.
///         Every router pays the hook fee. Independent pools without this hook are outside this policy.
///         Exact-input only in this migration stage: exact-output is rejected, never silently untaxed.
contract CensusV4Hook is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    // beforeInitialize, beforeSwap, afterSwap, beforeSwapReturnsDelta, afterSwapReturnsDelta.
    uint160 public constant REQUIRED_FLAGS = 0x20cc;
    IPoolManager public immutable manager;
    address public immutable registrar;
    address public immutable protocol;
    struct Policy { address quote; address creator; address rewards; uint16 reflectionBps; uint64 launchedAt; }
    mapping(PoolId => Policy) public policies;
    mapping(address => mapping(address => uint256)) public claimable;
    mapping(address => uint256) public totalReserved;

    error Unauthorized();
    error InvalidPool();
    error UnsupportedSwap();
    error InvalidAddressFlags();
    error PartialBuy();
    event PoolRegistered(PoolId indexed poolId, address quote, address creator, address rewards, uint16 reflectionBps);
    event FeeAccrued(PoolId indexed poolId, bool buy, uint256 quoteVolume, uint256 protocolFee, uint256 creatorFee, uint256 holderFee);
    event FeesClaimed(address indexed asset, address indexed recipient, uint256 amount);

    constructor(IPoolManager manager_, address registrar_, address protocol_) {
        if (address(manager_).code.length == 0 || registrar_ == address(0) || protocol_ == address(0)) revert InvalidPool();
        if ((uint160(address(this)) & ((1 << 14) - 1)) != REQUIRED_FLAGS) revert InvalidAddressFlags();
        manager = manager_; registrar = registrar_; protocol = protocol_;
    }

    modifier onlyManager() { if (msg.sender != address(manager)) revert Unauthorized(); _; }

    function register(PoolKey calldata key, address quote, address creator, address rewards, uint16 reflectionBps, uint64 launchedAt) external {
        if (msg.sender != registrar) revert Unauthorized();
        CensusFeeMath.validateReflection(reflectionBps);
        PoolId id = key.toId();
        if (policies[id].creator != address(0) || address(key.hooks) != address(this) || key.fee != 0 || creator == address(0)
            || launchedAt > block.timestamp || (reflectionBps != 0 && rewards == address(0))
            || Currency.unwrap(key.currency0) == address(0) || Currency.unwrap(key.currency1) == address(0)
            || (quote != Currency.unwrap(key.currency0) && quote != Currency.unwrap(key.currency1))) revert InvalidPool();
        policies[id] = Policy(quote, creator, rewards, reflectionBps, launchedAt);
        emit PoolRegistered(id, quote, creator, rewards, reflectionBps);
    }

    function beforeInitialize(address sender, PoolKey calldata key, uint160) external view onlyManager returns (bytes4) {
        if (sender != registrar || policies[key.toId()].creator == address(0)) revert Unauthorized();
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external onlyManager returns (bytes4, BeforeSwapDelta, uint24)
    {
        Policy memory p = policies[key.toId()];
        if (p.creator == address(0)) revert InvalidPool();
        if (params.amountSpecified >= 0 || params.amountSpecified == type(int256).min) revert UnsupportedSwap();
        // Liveness over purity: if Uniswap governance ever enables its protocol fee on this pool (at most
        // 0.1%), trading continues and that fee applies on top of the Census fee. Halting would brick
        // every Census pool forever, since neither the hook nor the pool can be replaced.
        bool buy = (params.zeroForOne ? Currency.unwrap(key.currency0) : Currency.unwrap(key.currency1)) == p.quote;
        uint256 fee;
        if (buy) fee = _accrue(key.toId(), p, uint256(-params.amountSpecified), true);
        if (fee > uint256(uint128(type(int128).max))) revert UnsupportedSwap();
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(int256(fee)), 0), 0);
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external onlyManager returns (bytes4, int128)
    {
        Policy memory p = policies[key.toId()];
        bool quote0 = Currency.unwrap(key.currency0) == p.quote;
        bool buy = params.zeroForOne == quote0;
        int128 quoteDelta = quote0 ? delta.amount0() : delta.amount1();
        if (buy) {
            uint256 gross = uint256(-params.amountSpecified);
            CensusFeeMath.Fees memory f = CensusFeeMath.calculate(gross, p.reflectionBps, block.timestamp - p.launchedAt, true, true);
            // Fee is charged on specified input: reject a price-limited partial fill instead of overcharging.
            if (quoteDelta >= 0 || uint256(-int256(quoteDelta)) != gross - f.total) revert PartialBuy();
            return (IHooks.afterSwap.selector, 0);
        }
        if (quoteDelta <= 0) revert UnsupportedSwap();
        uint256 fee = _accrue(key.toId(), p, uint256(uint128(quoteDelta)), false);
        return (IHooks.afterSwap.selector, int128(int256(fee)));
    }

    function _accrue(PoolId id, Policy memory p, uint256 gross, bool buy) private returns (uint256) {
        CensusFeeMath.Fees memory f = CensusFeeMath.calculate(gross, p.reflectionBps, block.timestamp - p.launchedAt, buy, true);
        claimable[p.quote][protocol] += f.protocol;
        claimable[p.quote][p.creator] += f.creator;
        claimable[p.quote][p.rewards] += f.holders;
        totalReserved[p.quote] += f.total;
        manager.take(Currency.wrap(p.quote), address(this), f.total);
        emit FeeAccrued(id, buy, gross, f.protocol, f.creator, f.holders);
        return f.total;
    }

    /// @notice Anyone can deliver accrued fees, but only to their recorded beneficiary.
    function claimFor(address asset, address recipient) external nonReentrant {
        uint256 amount = claimable[asset][recipient];
        claimable[asset][recipient] = 0;
        totalReserved[asset] -= amount;
        if (amount != 0) IERC20(asset).safeTransfer(recipient, amount);
        emit FeesClaimed(asset, recipient, amount);
    }
}
