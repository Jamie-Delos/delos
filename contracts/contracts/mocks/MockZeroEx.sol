// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MockZeroEx — test-only stand-in for the 0x AllowanceHolder + Settler
/// @notice Simulates a 0x swap so the devnet can exercise `DividendVault.distributeVia0x` without a
///         live 0x deployment. `swap` pulls `amountIn` of `tokenIn` from the caller (the vault, via the
///         ERC20 allowance it granted this contract) and sends a pre-agreed `amountOut` of `tokenOut`
///         to `recipient` from its own pre-funded inventory — the same shape as approving the real
///         AllowanceHolder and calling it with the quote's `transaction.data`.
contract MockZeroEx {
    function swap(address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut, address recipient) external {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(recipient, amountOut);
    }
}
