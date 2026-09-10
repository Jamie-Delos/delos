// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal WETH9-style mock for tests: deposit wraps native ETH, withdraw unwraps it.
///         `mint` is a test convenience for seeding balances that don't need ETH backing.
contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped ETH", "WETH") {}

    function deposit() external payable { _mint(msg.sender, msg.value); }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "eth transfer failed");
    }

    function mint(address to, uint256 amount) external { _mint(to, amount); }

    receive() external payable { _mint(msg.sender, msg.value); }
}
