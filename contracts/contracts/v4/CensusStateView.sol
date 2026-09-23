// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

/// @notice Minimal read-only view over a PoolManager with the same `getSlot0`/`getLiquidity` shape as
///         Uniswap's official StateView. Deployed only on networks without the official one (testnets);
///         mainnet uses the Uniswap StateView address.
contract CensusStateView {
    using StateLibrary for IPoolManager;
    IPoolManager public immutable poolManager;

    constructor(IPoolManager manager_) { poolManager = manager_; }

    function getSlot0(PoolId poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee) {
        return poolManager.getSlot0(poolId);
    }

    function getLiquidity(PoolId poolId) external view returns (uint128 liquidity) {
        return poolManager.getLiquidity(poolId);
    }
}
