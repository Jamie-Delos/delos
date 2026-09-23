// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Production CREATE2 deployer for the Census hook: its address must carry the flag bits the
///         PoolManager reads (CensusV4Hook.REQUIRED_FLAGS), so the deploy script mines a salt off-chain
///         and deploys through this fixed-address factory. Owner-only, so nobody can squat a mined address.
contract CensusHookDeployer {
    address public immutable owner;
    event Deployed(address indexed at, bytes32 salt);
    error NotOwner();
    error Failed();

    constructor() { owner = msg.sender; }

    function deploy(bytes32 salt, bytes memory code) external returns (address result) {
        if (msg.sender != owner) revert NotOwner();
        assembly ("memory-safe") { result := create2(0, add(code, 32), mload(code), salt) }
        if (result == address(0)) revert Failed();
        emit Deployed(result, salt);
    }

    function predict(bytes32 salt, bytes32 initCodeHash) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }
}
