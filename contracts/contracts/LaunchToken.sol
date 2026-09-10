// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev The v2 DividendVault's transfer hook — called on every transfer to keep dividend accounting
///      settled at each balance change (so buyers can't claim distributions paid before they held).
interface IDividendHook {
    function onTokenTransfer(address from, address to, uint256 value) external;
}

/// @title LaunchToken
/// @notice Fixed-supply ERC-20. No tax, no mint after deploy, no owner privileges. The whole supply
///         is minted once to `mintTo` (the factory), which seeds the single-sided Uniswap position.
///
///         Optional anti-snipe: the factory arms a short, auto-expiring window right after the pool is
///         created. During the window, buys (pool -> wallet) are (a) blocked entirely in the launch
///         block — killing same-block sniper bundles — and (b) capped per wallet (max wallet) and per
///         wallet cumulatively (max buy). After `restrictionEndBlock` the token is a plain ERC-20 with
///         zero restrictions. Only pool->wallet transfers are ever touched, so P2P transfers, LP
///         provisioning and fee collection are unaffected.
contract LaunchToken is ERC20 {
    uint8 private immutable _decimals;
    address public immutable factory; // = mintTo; the only address allowed to arm anti-snipe
    address public dividendVault;     // set once by the factory for v2 tokens; 0 for v1 (no dividends)

    address public pool;
    uint256 public launchBlock;
    uint256 public restrictionEndBlock; // inclusive; 0 => anti-snipe not armed
    uint256 public maxWallet;           // absolute cap during window (0 => no cap)
    uint256 public maxBuy;              // cumulative per-wallet buy cap during window (0 => no cap)
    mapping(address => bool) public antiSnipeExempt;
    mapping(address => uint256) private _bought;
    bool private _armed;

    error NotFactory();
    error AlreadyArmed();
    error LaunchBlockBuyBlocked();
    error MaxBuyExceeded();
    error MaxWalletExceeded();

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        uint8 decimals_,
        address mintTo
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
        factory = mintTo;
        _mint(mintTo, totalSupply_);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Arm the anti-snipe window. Called once by the factory, after the pool exists.
    /// @param pool_ the Uniswap pool; a "buy" is a pool -> wallet transfer
    /// @param windowBlocks how many blocks the restriction lasts (0 => only the launch-block guard)
    /// @param maxWalletBps max wallet holdings during the window, in bps of supply (0 => no cap)
    /// @param maxBuyBps max cumulative buys per wallet during the window, in bps of supply (0 => no cap)
    /// @param launchBuyer optional address allowed to buy in the launch block (0 => nobody)
    /// @param exempt addresses never subject to anti-snipe (locker, creator, vault, ...)
    function initAntiSnipe(
        address pool_,
        uint256 windowBlocks,
        uint16 maxWalletBps,
        uint16 maxBuyBps,
        address launchBuyer,
        address[] calldata exempt
    ) external {
        if (msg.sender != factory) revert NotFactory();
        if (_armed) revert AlreadyArmed();
        _armed = true;
        pool = pool_;
        launchBlock = block.number;
        restrictionEndBlock = block.number + windowBlocks;
        uint256 supply = totalSupply();
        maxWallet = maxWalletBps == 0 ? 0 : (supply * maxWalletBps) / 10_000;
        maxBuy = maxBuyBps == 0 ? 0 : (supply * maxBuyBps) / 10_000;
        antiSnipeExempt[factory] = true;
        antiSnipeExempt[pool_] = true;
        if (launchBuyer != address(0)) antiSnipeExempt[launchBuyer] = true;
        for (uint256 i; i < exempt.length; i++) antiSnipeExempt[exempt[i]] = true;
    }

    /// @notice Wire this token to its v2 DividendVault (once, by the factory). After this, every
    ///         transfer notifies the vault so dividend accounting settles at each balance change.
    function setDividendVault(address vault) external {
        if (msg.sender != factory) revert NotFactory();
        require(dividendVault == address(0), "vault set");
        dividendVault = vault;
    }

    function _update(address from, address to, uint256 value) internal override {
        // Only touch buys (pool -> wallet), only during the window, and never exempt recipients.
        if (block.number <= restrictionEndBlock && from == pool && !antiSnipeExempt[to]) {
            if (block.number == launchBlock) revert LaunchBlockBuyBlocked(); // kill same-block snipes
            if (maxBuy != 0) {
                uint256 bought = _bought[to] + value;
                if (bought > maxBuy) revert MaxBuyExceeded();
                _bought[to] = bought;
            }
            if (maxWallet != 0 && balanceOf(to) + value > maxWallet) revert MaxWalletExceeded();
        }
        super._update(from, to, value);

        // v2: settle dividend accounting on every balance change (dividendVault == 0 for v1 => skipped).
        address dv = dividendVault;
        if (dv != address(0)) IDividendHook(dv).onTokenTransfer(from, to, value);
    }
}
