// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Shared fee policy for new curve and canonical V4 trades. Rates use basis points.
library CensusFeeMath {
    uint16 internal constant BASE_BPS = 200;
    uint16 internal constant BPS = 10_000;
    uint16 internal constant MAX_TOTAL_BPS = 9_900;
    uint256 internal constant WINDOW = 3;

    struct Fees { uint256 total; uint256 protocol; uint256 creator; uint256 holders; uint256 penalty; }
    error InvalidReflection();

    function validateReflection(uint16 reflectionBps) internal pure {
        if (reflectionBps != 0 && (reflectionBps < 100 || reflectionBps > 400)) revert InvalidReflection();
    }

    function rates(uint16 reflectionBps, uint256 elapsed, bool penalizedBuy)
        internal pure returns (uint256 totalBps, uint256 penaltyBps)
    {
        validateReflection(reflectionBps);
        if (penalizedBuy && elapsed < WINDOW) {
            uint256 raw = uint256(9_900) >> ((elapsed * 14) / WINDOW);
            penaltyBps = Math.min(raw, MAX_TOTAL_BPS - BASE_BPS - reflectionBps);
        }
        totalBps = BASE_BPS + reflectionBps + penaltyBps;
    }

    function calculate(uint256 grossQuote, uint16 reflectionBps, uint256 elapsed, bool penalizedBuy, bool graduated)
        internal pure returns (Fees memory f)
    {
        (uint256 rate, uint256 penaltyRate) = rates(reflectionBps, elapsed, penalizedBuy);
        f.total = Math.mulDiv(grossQuote, rate, BPS);
        f.holders = Math.mulDiv(grossQuote, reflectionBps, BPS);
        f.penalty = Math.mulDiv(grossQuote, penaltyRate, BPS);
        // Penalty follows the phase's base-fee split. Independent holders allocation is never diluted.
        uint256 shared = f.total - f.holders;
        f.protocol = Math.mulDiv(shared, graduated ? 3_000 : 9_000, BPS);
        f.creator = shared - f.protocol;
    }
}
