// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {CensusFeeMath} from "../v4/CensusFeeMath.sol";

contract CensusFeeMathHarness {
    function calculate(uint256 amount, uint16 reflection, uint256 elapsed, bool buy, bool graduated)
        external pure returns (CensusFeeMath.Fees memory) {
        return CensusFeeMath.calculate(amount, reflection, elapsed, buy, graduated);
    }
}

contract CensusCreate2Deployer {
    function deploy(bytes32 salt, bytes memory code) external returns (address result) {
        assembly ("memory-safe") { result := create2(0, add(code, 32), mload(code), salt) }
        require(result != address(0), "deployment failed");
    }
}
