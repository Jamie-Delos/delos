// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CensusRewardVault} from "./CensusRewardVault.sol";

/// @title CensusRewardVaultDeployer
/// @notice Holds the reward-vault creation code so LaunchFactoryV4 stays small and keeps its legacy
///         compiler settings. Bound once to the factory that may use it.
contract CensusRewardVaultDeployer {
    address public immutable owner;
    address public launchFactory;

    error NotLaunchFactory();
    error NotOwner();
    error AlreadyBound();

    constructor() { owner = msg.sender; }

    function setLaunchFactory(address f) external {
        if (msg.sender != owner) revert NotOwner();
        if (launchFactory != address(0) || f == address(0)) revert AlreadyBound();
        launchFactory = f;
    }

    function create(
        address quote, address router, uint24 swapFee,
        address[] calldata basket, uint16[] calldata weights, bytes[] calldata paths,
        address allowanceHolder, address token, address census,
        address[] calldata excluded_
    ) external returns (address vault) {
        if (msg.sender != launchFactory) revert NotLaunchFactory();
        CensusRewardVault v = new CensusRewardVault(quote, router, swapFee, basket, weights, paths, allowanceHolder, token, census);
        v.init(excluded_);
        vault = address(v);
    }
}
