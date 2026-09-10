// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title FeeSplitter
/// @notice Immutable, trustless split of protocol fees between two recipients. The shares are fixed at
///         deploy and can never be changed by anyone. Each recipient can only ever pull its own
///         cumulative share of every token that has arrived; neither party can touch the other's share.
///         Releases are permissionless: anyone can trigger a release to a recipient, so neither side
///         depends on the other to get paid. Protocol fees arrive as ERC-20 (the coin's quote asset,
///         e.g. WETH or HOOD), so this splits ERC-20 balances.
contract FeeSplitter {
    using SafeERC20 for IERC20;

    address public immutable recipientA;
    address public immutable recipientB;
    uint256 public immutable sharesA;
    uint256 public immutable sharesB;
    uint256 public immutable totalShares;

    // token => recipient => amount already released
    mapping(address => mapping(address => uint256)) public released;

    event Released(address indexed token, address indexed to, uint256 amount);

    constructor(address a, uint256 sharesA_, address b, uint256 sharesB_) {
        require(a != address(0) && b != address(0) && a != b, "recipients");
        require(sharesA_ > 0 && sharesB_ > 0, "shares");
        recipientA = a;
        recipientB = b;
        sharesA = sharesA_;
        sharesB = sharesB_;
        totalShares = sharesA_ + sharesB_;
    }

    function _sharesOf(address who) internal view returns (uint256) {
        if (who == recipientA) return sharesA;
        if (who == recipientB) return sharesB;
        return 0;
    }

    function _totalReleased(address token) internal view returns (uint256) {
        return released[token][recipientA] + released[token][recipientB];
    }

    /// @notice How much `account` can release of `token` right now.
    function releasable(address token, address account) public view returns (uint256) {
        uint256 sh = _sharesOf(account);
        if (sh == 0) return 0;
        uint256 totalReceived = IERC20(token).balanceOf(address(this)) + _totalReleased(token);
        uint256 entitled = (totalReceived * sh) / totalShares;
        uint256 already = released[token][account];
        return entitled > already ? entitled - already : 0;
    }

    /// @notice Release `account`'s outstanding share of `token`. Callable by anyone.
    function release(address token, address account) external returns (uint256 amount) {
        require(_sharesOf(account) > 0, "not a recipient");
        amount = releasable(token, account);
        require(amount > 0, "nothing due");
        released[token][account] += amount;
        IERC20(token).safeTransfer(account, amount);
        emit Released(token, account, amount);
    }
}
