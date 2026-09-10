// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MockSwapRouter — test-only SwapRouter02 stand-in.
/// @notice Implements exactInputSingle: pulls amountIn of tokenIn from the caller and pays out
///         (amountIn * rateNum / rateDen) of tokenOut from its own pre-funded inventory (default 1:1).
contract MockSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    uint256 public rateNum = 1;
    uint256 public rateDen = 1;
    function setRate(uint256 n, uint256 d) external { rateNum = n; rateDen = d; }

    function exactInputSingle(ExactInputSingleParams calldata p) external returns (uint256 amountOut) {
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        amountOut = (p.amountIn * rateNum) / rateDen;
        require(amountOut >= p.amountOutMinimum, "minOut");
        IERC20(p.tokenOut).transfer(p.recipient, amountOut);
    }

    // Multi-hop shape used by the CensusCurve ETH zap. The mock ignores the intermediate hops and just
    // swaps the path's first token for its last token at `rate` — enough to prove the curve's wiring.
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata p) external returns (uint256 amountOut) {
        address tokenIn = address(bytes20(p.path[0:20]));
        address tokenOut = address(bytes20(p.path[p.path.length - 20:]));
        IERC20(tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        amountOut = (p.amountIn * rateNum) / rateDen;
        require(amountOut >= p.amountOutMinimum, "minOut");
        IERC20(tokenOut).transfer(p.recipient, amountOut);
    }
}
