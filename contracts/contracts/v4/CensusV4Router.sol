// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

/// @notice Single-hop ERC20 exact-input swaps through the canonical Census hook.
/// @dev Native ETH must be wrapped separately. No arbitrary calls or payer supplied by callers.
contract CensusV4Router is ReentrancyGuard {
    using SafeERC20 for IERC20;
    IPoolManager public immutable manager;
    address public immutable hook;
    bytes32 private activeCallback;

    struct Request {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        uint256 minOut;
        uint160 sqrtPriceLimitX96;
        address recipient;
        uint256 deadline;
    }

    error InvalidRequest();
    error UnauthorizedCallback();
    error IncompleteFill();
    error Slippage();
    error UnsupportedToken();
    event Swap(address indexed payer, address indexed recipient, address input, address output, uint256 amountIn, uint256 amountOut);

    constructor(IPoolManager manager_, address hook_) {
        if (address(manager_).code.length == 0 || hook_.code.length == 0) revert InvalidRequest();
        manager = manager_;
        hook = hook_;
    }

    function swapExactInput(Request calldata request) external nonReentrant returns (uint256 amountOut) {
        if (request.deadline < block.timestamp || request.recipient == address(0)
            || request.recipient == address(this) || request.recipient == address(manager)
            || request.amountIn == 0 || request.amountIn > uint256(uint128(type(int128).max))
            || request.minOut == 0 || address(request.key.hooks) != hook || request.key.fee != 0
            || Currency.unwrap(request.key.currency0) == address(0)
            || Currency.unwrap(request.key.currency1) == address(0)) revert InvalidRequest();
        bytes memory data = abi.encode(msg.sender, request);
        activeCallback = keccak256(data);
        amountOut = abi.decode(manager.unlock(data), (uint256));
        // The manager must have consumed exactly the callback this call authorized.
        if (activeCallback != bytes32(0)) revert UnauthorizedCallback();
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager) || activeCallback == bytes32(0)
            || keccak256(data) != activeCallback) revert UnauthorizedCallback();
        activeCallback = bytes32(0);
        (address payer, Request memory r) = abi.decode(data, (address, Request));
        BalanceDelta delta = manager.swap(r.key, SwapParams(r.zeroForOne, -int256(r.amountIn), r.sqrtPriceLimitX96), "");
        int128 inputDelta = r.zeroForOne ? delta.amount0() : delta.amount1();
        int128 outputDelta = r.zeroForOne ? delta.amount1() : delta.amount0();
        if (inputDelta >= 0 || uint256(-int256(inputDelta)) != r.amountIn) revert IncompleteFill();
        if (outputDelta <= 0 || uint256(uint128(outputDelta)) < r.minOut) revert Slippage();
        uint256 amountOut = uint256(uint128(outputDelta));
        Currency input = r.zeroForOne ? r.key.currency0 : r.key.currency1;
        Currency output = r.zeroForOne ? r.key.currency1 : r.key.currency0;
        manager.sync(input);
        IERC20(Currency.unwrap(input)).safeTransferFrom(payer, address(manager), r.amountIn);
        if (manager.settle() != r.amountIn) revert UnsupportedToken();
        // Check the actual receiver balance: an ERC20 transfer tax must not bypass minOut.
        IERC20 out = IERC20(Currency.unwrap(output));
        uint256 beforeBalance = out.balanceOf(r.recipient);
        manager.take(output, r.recipient, amountOut);
        if (out.balanceOf(r.recipient) - beforeBalance != amountOut) revert UnsupportedToken();
        emit Swap(payer, r.recipient, Currency.unwrap(input), Currency.unwrap(output), r.amountIn, amountOut);
        return abi.encode(amountOut);
    }
}
