// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LaunchToken} from "./LaunchToken.sol";

interface ICensusCurveV4 {
    function registerWithExemptions(
        address coin, address quote, address creator, address vault, uint16 reflectionBps,
        uint256 virtualQuote, uint256 tokenSupply, uint256 graduationQuote, address[] calldata exemptBuyers
    ) external;
    function graduator() external view returns (address);
    function allowedRewardAsset(address asset) external view returns (bool);
}

interface ICensusV4RouterView {
    function manager() external view returns (address);
    function hook() external view returns (address);
}

interface IRewardVaultDeployer {
    function create(
        address quote, address router, uint24 swapFee,
        address[] calldata basket, uint16[] calldata weights, bytes[] calldata paths,
        address allowanceHolder, address token, address census,
        address[] calldata excluded_
    ) external returns (address vault);
    function launchFactory() external view returns (address);
}

/// @title LaunchFactoryV4
/// @notice One factory for meme and company launches with identical economics: a fixed 1B-supply token,
///         the whole supply seeded into CensusCurveV4, optional 1-4% holder reflection paid into an
///         immutable basket of up to three reward assets (the pairing asset and/or tokenised stocks listed
///         on the curve's reward-asset allowlist; never the coin itself), and graduation into the hooked
///         Uniswap V4 pool.
///         Compiled with the legacy settings so the embedded LaunchToken creation code (and therefore
///         every predicted `…c0de` address) is byte-identical to the audited artifact.
contract LaunchFactoryV4 {
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable weth;
    address public immutable curve;
    address public immutable router;          // Uniswap V3 SwapRouter02 for stock routes
    uint24 public immutable stockSwapFee;
    address public immutable allowanceHolder; // 0x AllowanceHolder
    address public immutable v4Router;
    address public immutable vaultDeployer;

    struct LaunchParams {
        string name;
        string symbol;
        uint256 totalSupply;
        uint8 decimals;
        uint256 virtualQuote;
        uint256 graduationQuote;
    }

    event LaunchedV4(address indexed token, address indexed creator, address curve, address vault, uint16 reflectionBps, address quote);

    error BadBasket();
    error AssetNotAllowed(address asset);

    constructor(address weth_, address curve_, address router_, uint24 stockSwapFee_, address allowanceHolder_, address v4Router_, address vaultDeployer_) {
        require(weth_ != address(0) && curve_ != address(0) && router_ != address(0) && v4Router_.code.length > 0 && vaultDeployer_.code.length > 0, "zero");
        weth = weth_;
        curve = curve_;
        router = router_;
        stockSwapFee = stockSwapFee_;
        allowanceHolder = allowanceHolder_;
        v4Router = v4Router_;
        vaultDeployer = vaultDeployer_;
    }

    /// @param basket up to three reward assets: the quote asset and/or stocks on the curve's allowlist;
    ///        empty when reflectionBps is 0. The launch token itself is rejected.
    /// @param weights bps per basket asset, summing to 10000.
    /// @param paths per-asset Uniswap V3 route from the quote (empty for the quote entry or a direct hop).
    /// @param salt CREATE2 salt bound to the creator (bytes32(0) = plain deploy).
    /// @param quote WETH (default) or another supported anchor.
    /// @param reflectionBps 0 (disabled) or 100..400, charged on top of the 2% base fee.
    /// @param exemptBuyers creator-authorised launch-bundle exemptions from the anti-snipe penalty.
    function createLaunch(
        LaunchParams calldata p,
        address[] calldata basket, uint16[] calldata weights, bytes[] calldata paths,
        bytes32 salt, address quote, uint16 reflectionBps, address[] calldata exemptBuyers
    ) external returns (address token, address vault) {
        address q = quote == address(0) ? weth : quote;
        if ((reflectionBps == 0) != (basket.length == 0)) revert BadBasket();

        LaunchToken t;
        if (salt == bytes32(0)) {
            t = new LaunchToken(p.name, p.symbol, p.totalSupply, p.decimals, address(this));
        } else {
            // Bind the vanity address to the creator (see LaunchFactory): keccak256(salt, creator).
            bytes32 s = keccak256(abi.encodePacked(salt, msg.sender));
            t = new LaunchToken{salt: s}(p.name, p.symbol, p.totalSupply, p.decimals, address(this));
            require((uint160(address(t)) & 0xFFFF) == 0xC0DE, "not a census address");
        }
        token = address(t);

        if (reflectionBps != 0) {
            for (uint256 i; i < basket.length; i++) {
                if (basket[i] != q && !ICensusCurveV4(curve).allowedRewardAsset(basket[i])) revert AssetNotAllowed(basket[i]);
            }
            vault = _createVault(q, basket, weights, paths, token);
            t.setDividendVault(vault);
        }

        IERC20(token).transfer(curve, p.totalSupply);
        ICensusCurveV4(curve).registerWithExemptions(token, q, msg.sender, vault, reflectionBps, p.virtualQuote, p.totalSupply, p.graduationQuote, exemptBuyers);
        emit LaunchedV4(token, msg.sender, curve, vault, reflectionBps, q);
    }

    // Distribution authority is the curve keeper only — the creator is never a vault operator (see
    // CensusRewardVault header).
    function _createVault(address q, address[] calldata basket, uint16[] calldata weights, bytes[] calldata paths, address token) internal returns (address) {
        // Custody that never earns: curve inventory, this factory, the PoolManager singleton, hook,
        // router, graduator and the dead address (the vault excludes itself).
        address[] memory ex = new address[](7);
        ex[0] = curve;
        ex[1] = address(this);
        ex[2] = ICensusV4RouterView(v4Router).manager();
        ex[3] = ICensusV4RouterView(v4Router).hook();
        ex[4] = v4Router;
        ex[5] = ICensusCurveV4(curve).graduator();
        ex[6] = DEAD;
        return IRewardVaultDeployer(vaultDeployer).create(q, router, stockSwapFee, basket, weights, paths, allowanceHolder, token, curve, ex);
    }
}
