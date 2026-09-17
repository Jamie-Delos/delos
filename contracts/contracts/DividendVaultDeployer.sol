// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DividendVault} from "./DividendVault.sol";

/// @title DividendVaultDeployer
/// @notice Creates and wires one DividendVault per Maxima launch on behalf of LaunchFactoryV2.
///         Holding the vault creation code here (instead of inside the factory's runtime) keeps
///         LaunchFactoryV2 well under the EIP-170 runtime limit, so vault fixes no longer compete
///         with the factory for bytecode headroom. Only the factory that deployed this contract may
///         use it; the vault's `factory` (init/setCensus authority) is this deployer, which performs
///         the whole wiring in the same call.
contract DividendVaultDeployer {
    address public immutable launchFactory;

    error NotLaunchFactory();

    constructor() {
        launchFactory = msg.sender;
    }

    function create(
        address quote, address router, uint24 swapFee,
        address[] calldata basket, uint16[] calldata weights, bytes[] calldata paths,
        address allowanceHolder, address token, address[] calldata excluded_, address operator, address census
    ) external returns (address vault) {
        if (msg.sender != launchFactory) revert NotLaunchFactory();
        DividendVault dv = new DividendVault(quote, router, swapFee, basket, weights, paths, allowanceHolder);
        dv.init(token, excluded_, operator);
        dv.setCensus(census);
        vault = address(dv);
    }
}
