// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LaunchToken} from "./LaunchToken.sol";

interface ICensusCurve {
    function registerWithExemptions(
        address coin, address quote, address creator, address vault, uint16 holdersBps,
        uint24 poolFee, uint256 virtualQuote, uint256 tokenSupply, uint256 graduationQuote, address[] calldata exemptBuyers
    ) external;
}

/// @title LaunchFactory (Prima / v1)
/// @notice Deploys a fixed-supply ERC-20 and seeds the WHOLE supply into the CensusCurve bonding curve
///         in one transaction. There is no DEX pool at launch — trading happens on the curve (an
///         un-dodgeable 2% fee, because there is nowhere else to trade) until the curve fills its
///         graduation reserve, at which point the curve migrates the tokens + raised quote into a
///         permanently-locked Uniswap V3 pool. Every Census token address ends in `…c0de`.
contract LaunchFactory {
    address public immutable weth;  // default quote asset
    address public immutable curve; // CensusCurve — the trading venue

    struct LaunchParams {
        string name;
        string symbol;
        uint256 totalSupply;      // base units (e.g. 1_000_000_000 * 10**18)
        uint8 decimals;           // 18
        uint24 poolFee;           // Uniswap V3 fee tier for the graduated pool
        uint256 virtualQuote;     // V0 — the curve's virtual quote reserve ≈ starting FDV (in quote)
        uint256 graduationQuote;  // graduate once the curve has raised this much quote (e.g. 4 ETH)
    }

    event Launched(address indexed token, address indexed creator, address curve, uint256 virtualQuote, uint256 graduationQuote);

    constructor(address weth_, address curve_) {
        require(weth_ != address(0) && curve_ != address(0), "zero");
        weth = weth_;
        curve = curve_;
    }

    /// @dev Default entrypoint: ETH-quoted, no launch-bundle exemptions. Back-compatible arity.
    function createLaunch(LaunchParams calldata p, bytes32 salt) external returns (address token) {
        return createLaunch(p, salt, weth, new address[](0));
    }

    /// @notice Launch quoted in `quote` (WETH default, or e.g. HOOD).
    /// @param salt CREATE2 salt; bytes32(0) for a plain deploy, or a grinded salt for a `…c0de` address.
    /// @param exemptBuyers addresses exempt from the anti-snipe (a creator-authorised launch bundle, e.g.
    ///        Sumo's block-0 wallets) — the Pons-V2-style "factory exemption list".
    function createLaunch(LaunchParams calldata p, bytes32 salt, address quote, address[] memory exemptBuyers)
        public
        returns (address token)
    {
        address q = quote == address(0) ? weth : quote;

        // 1. Deploy the token; whole supply mints to this factory. A grinded salt enforces `…c0de`.
        LaunchToken t;
        if (salt == bytes32(0)) {
            t = new LaunchToken(p.name, p.symbol, p.totalSupply, p.decimals, address(this));
        } else {
            // Bind the vanity address to the creator: the CREATE2 salt is keccak256(salt, creator), so
            // the deployed address depends on msg.sender. A mempool watcher who copies (params, salt)
            // deploys to a DIFFERENT address under their own key and cannot hijack this launch's
            // …c0de address. The off-chain grinder (scripts/lib/grindSalt.js, frontend/src/lib/c0de.ts)
            // mirrors this derivation, grinding `salt` for the connected creator.
            bytes32 s = keccak256(abi.encodePacked(salt, msg.sender));
            t = new LaunchToken{salt: s}(p.name, p.symbol, p.totalSupply, p.decimals, address(this));
            require((uint160(address(t)) & 0xFFFF) == 0xC0DE, "not a census address");
        }
        token = address(t);

        // 2. Seed the whole supply. Token-level wallet/buy/block restrictions are never armed.
        IERC20(token).transfer(curve, p.totalSupply);

        // 3. Register the 3-second buy tax. Creator and declared bundle wallets are exempt.
        ICensusCurve(curve).registerWithExemptions(token, q, msg.sender, address(0), 0, p.poolFee, p.virtualQuote, p.totalSupply, p.graduationQuote, exemptBuyers);

        emit Launched(token, msg.sender, curve, p.virtualQuote, p.graduationQuote);
    }
}
