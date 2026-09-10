// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {DividendVault} from "./DividendVault.sol";

interface ICensusCurve {
    function register(
        address coin, address quote, address creator, address vault, uint16 holdersBps,
        uint24 poolFee, uint256 virtualQuote, uint256 tokenSupply, uint256 graduationQuote
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

    uint256 private constant ANTISNIPE_WINDOW = 100;
    uint16 private constant ANTISNIPE_MAX_WALLET_BPS = 200; // 2%
    uint16 private constant ANTISNIPE_MAX_BUY_BPS = 100;    // 1%

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

        // 1. Per-token dividend vault (fee asset = the quote).
        DividendVault dv = new DividendVault(q, router, stockSwapFee, basket, weights, paths, allowanceHolder);
        vault = address(dv);

        // 2. Token: whole supply mints to this factory.
        LaunchToken t;
        if (salt == bytes32(0)) {
            t = new LaunchToken(p.name, p.symbol, p.totalSupply, p.decimals, address(this));
        } else {
            t = new LaunchToken{salt: salt}(p.name, p.symbol, p.totalSupply, p.decimals, address(this));
            require((uint160(address(t)) & 0xFFFF) == 0xC0DE, "not a census address");
        }
        token = address(t);

        // 3. Seed the whole supply into the curve (before the dividend hook is wired + before anti-snipe).
        IERC20(token).transfer(curve, p.totalSupply);

        // 4. Arm anti-snipe: curve is the "pool". Creator, vault and any bundle wallets are exempt.
        address[] memory exempt = new address[](2 + exemptBuyers.length);
        exempt[0] = msg.sender;
        exempt[1] = vault;
        for (uint256 i; i < exemptBuyers.length; i++) exempt[i + 2] = exemptBuyers[i];
        t.initAntiSnipe(curve, ANTISNIPE_WINDOW, ANTISNIPE_MAX_WALLET_BPS, ANTISNIPE_MAX_BUY_BPS, address(0), exempt);

        // 5. Wire the vault: exclude the curve/factory/vault/dead from dividends; grant the curve the
        //    right to also exclude the graduated pool later; wire the token's transfer hook.
        address[] memory ex = new address[](4);
        ex[0] = curve;
        ex[1] = address(this);
        ex[2] = vault;
        ex[3] = DEAD;
        dv.init(token, ex, msg.sender); // creator is the default distribution operator
        dv.setCensus(curve);
        t.setDividendVault(vault);

        // 6. Register the curve with the vault + split.
        ICensusCurve(curve).register(token, q, msg.sender, vault, holdersBps, p.poolFee, p.virtualQuote, p.totalSupply, p.graduationQuote);

        emit LaunchedV2(token, msg.sender, curve, vault, holdersBps);
    }
}
