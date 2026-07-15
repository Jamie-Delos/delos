// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title LaunchToken
/// @notice Plain fixed-supply ERC-20. No tax, no mint after deploy, no owner privileges.
///         The entire supply is minted once to `mintTo` (the factory), which seeds the
///         single-sided Uniswap V3 position.
contract LaunchToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        uint8 decimals_,
        address mintTo
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
        _mint(mintTo, totalSupply_);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}
