// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {DividendVaultDeployer} from "./DividendVaultDeployer.sol";

interface ICensusCurve {
    function registerWithExemptions(
        address coin, address quote, address creator, address vault, uint16 holdersBps,
        uint24 poolFee, uint256 virtualQuote, uint256 tokenSupply, uint256 graduationQuote, address[] calldata exemptBuyers
    ) external;
}

/// @title LaunchFactoryV2 (Maxima / v2 — stock-dividend basket)
/// @notice Same curve launch as Prima, but each coin gets a DividendVault: the holders' share of the
///         2% fee is routed to the vault (pre-graduation from the curve, post-graduation from the locked
///         pool), swapped into a chosen 1–4 tokenised-stock basket, and paid to holders. "A memecoin
///         that pays a stock-dividend basket." The whole supply seeds the CensusCurve; no DEX pool at
///         launch; graduation migrates to a permanently-locked Uniswap V3 pool.
contract LaunchFactoryV2 {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable weth;           // default quote AND the vault's default fee asset
    address public immutable curve;          // CensusCurve — the trading venue
    address public immutable router;         // Uniswap SwapRouter02, for the vault's quote->stock swaps
    uint24 public immutable stockSwapFee;    // fallback tier for the vault's quote->stock swaps
    address public immutable allowanceHolder; // 0x AllowanceHolder, handed to each vault for its 0x path
    /// @notice Creates + wires each launch's DividendVault. Keeping the vault creation code out of this
    ///         contract's runtime keeps the factory far below the EIP-170 limit.
    DividendVaultDeployer public immutable vaultDeployer;

    struct LaunchParams {
        string name;
        string symbol;
        uint256 totalSupply;
        uint8 decimals;
        uint24 poolFee;           // graduated pool fee tier
        uint256 virtualQuote;     // V0 — curve virtual quote reserve ≈ start FDV
        uint256 graduationQuote;  // graduate once the curve raises this much quote
    }

    event LaunchedV2(address indexed token, address indexed creator, address curve, address vault, uint16 holdersBps);

    constructor(address weth_, address curve_, address router_, uint24 stockSwapFee_, address allowanceHolder_) {
        require(weth_ != address(0) && curve_ != address(0) && router_ != address(0), "zero");
        weth = weth_;
        curve = curve_;
        router = router_;
        stockSwapFee = stockSwapFee_;
        allowanceHolder = allowanceHolder_;
        vaultDeployer = new DividendVaultDeployer();
    }

    /// @dev Default entrypoint: ETH-quoted, 100% of the creator side to holders, no launch-bundle.
    function createLaunch(LaunchParams calldata p, address[] calldata basket, uint16[] calldata weights, bytes[] calldata paths, bytes32 salt)
        external
        returns (address token, address vault)
    {
        return createLaunch(p, basket, weights, paths, salt, weth, 10_000, new address[](0));
    }

    /// @param quote WETH (default) or e.g. HOOD — the pool quote AND the vault's fee/payout asset.
    /// @param holdersBps share of the 75% creator side that goes to holders via the vault (0 = creator
    ///        only, 10000 = holders only, in-between = both).
    /// @param exemptBuyers creator-authorised anti-snipe exemptions (a launch bundle).
    function createLaunch(
        LaunchParams calldata p,
        address[] calldata basket, uint16[] calldata weights, bytes[] calldata paths,
        bytes32 salt, address quote, uint16 holdersBps, address[] memory exemptBuyers
    ) public returns (address token, address vault) {
        address q = quote == address(0) ? weth : quote;

        // 1. Token: whole supply mints to this factory.
        LaunchToken t;
        if (salt == bytes32(0)) {
            t = new LaunchToken(p.name, p.symbol, p.totalSupply, p.decimals, address(this));
        } else {
            t = new LaunchToken{salt: salt}(p.name, p.symbol, p.totalSupply, p.decimals, address(this));
            require((uint160(address(t)) & 0xFFFF) == 0xC0DE, "not a census address");
        }
        token = address(t);

        // 2. Per-token dividend vault (fee asset = the quote), created and wired by the deployer:
        //    the curve/factory/dead addresses (and the vault itself) never earn; the creator is the default distribution
        //    operator (the Census keeper registered on the curve may also run distributions); the curve
        //    may exclude the graduated pool later.
        address[] memory ex = new address[](3);
        ex[0] = curve;
        ex[1] = address(this);
        ex[2] = DEAD;
        vault = _createVault(q, basket, weights, paths, token, ex, msg.sender);

        // 3. Seed supply before wiring dividends. No token-level wallet/buy/block restrictions.
        IERC20(token).transfer(curve, p.totalSupply);

        // 4. Wire the token's transfer hook to the vault.
        t.setDividendVault(vault);

        // 5. Register the 3-second buy tax and freeze creator/bundle exemptions.
        ICensusCurve(curve).registerWithExemptions(token, q, msg.sender, vault, holdersBps, p.poolFee, p.virtualQuote, p.totalSupply, p.graduationQuote, exemptBuyers);

        emit LaunchedV2(token, msg.sender, curve, vault, holdersBps);
    }

    function _createVault(
        address q, address[] calldata basket, uint16[] calldata weights, bytes[] calldata paths,
        address token, address[] memory ex, address creator
    ) internal returns (address) {
        return vaultDeployer.create(q, router, stockSwapFee, basket, weights, paths, allowanceHolder, token, ex, creator, curve);
    }
}
