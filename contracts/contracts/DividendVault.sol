// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title DividendVault (v2)
/// @notice One per launched token. It receives that token's protocol fee share (in the quote asset,
///         e.g. WETH), swaps it across a 1–4 stock basket, and pays it out to holders pro-rata.
///
///         Distribution is pull-based (holders claim, paying their own gas) using a per-share
///         accumulator over the ELIGIBLE supply — the pool, locker, factory, vault and dead address
///         are excluded, so only circulating holders earn. `distribute()` is permissionless
///         ("anyone can press run", or a keeper does it).
///
///         NOTE: this uses the simple `balance × accPerShare − claimed` model, correct for the normal
///         buy→earn→claim path. Production hardens it with transfer-time settlement (magnified
///         dividend corrections) to stop buy-right-before-distribute gaming.
contract DividendVault {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant PREC = 1e18;

    address public immutable factory;
    address public immutable quote; // the fee asset the vault swaps FROM (e.g. WETH)
    ISwapRouter02 public immutable router;
    uint24 public immutable swapFee; // fee tier for quote->stock swaps

    address public token; // the dividend-bearing launch token
    address[] public basket; // 1–4 tokenized stocks
    uint16[] public weights; // bps, sum 10000

    address[] public excludedList;
    mapping(address => bool) public excluded;
    mapping(address => uint256) public accPerShare; // stock => accumulated per eligible share
    mapping(address => mapping(address => uint256)) public claimedOf; // holder => stock => claimed
    bool private inited;

    event Distributed(uint256 quoteSpent);
    event Claimed(address indexed holder, address indexed stock, uint256 amount);

    constructor(address quote_, address router_, uint24 swapFee_, address[] memory basket_, uint16[] memory weights_) {
        require(basket_.length >= 1 && basket_.length <= 4 && basket_.length == weights_.length, "basket");
        uint256 sum;
        for (uint256 i; i < weights_.length; i++) sum += weights_[i];
        require(sum == 10_000, "weights");
        factory = msg.sender;
        quote = quote_;
        router = ISwapRouter02(router_);
        swapFee = swapFee_;
        basket = basket_;
        weights = weights_;
    }

    /// @notice Wired once by the factory: the token to distribute to, and the addresses to exclude.
    function init(address token_, address[] calldata excluded_) external {
        require(msg.sender == factory && !inited, "init");
        inited = true;
        token = token_;
        for (uint256 i; i < excluded_.length; i++) {
            if (!excluded[excluded_[i]]) {
                excluded[excluded_[i]] = true;
                excludedList.push(excluded_[i]);
            }
        }
    }

    function basketLength() external view returns (uint256) {
        return basket.length;
    }

    /// @notice Circulating supply that actually earns dividends (total minus excluded holders).
    function eligibleSupply() public view returns (uint256 s) {
        s = IERC20(token).totalSupply();
        for (uint256 i; i < excludedList.length; i++) s -= IERC20(token).balanceOf(excludedList[i]);
    }

    /// @notice Convert all accumulated quote fees into the stock basket and credit holders.
    function distribute() external returns (uint256 spent) {
        uint256 amt = IERC20(quote).balanceOf(address(this));
        uint256 elig = eligibleSupply();
        if (amt == 0 || elig == 0) return 0;

        IERC20(quote).forceApprove(address(router), amt);
        for (uint256 i; i < basket.length; i++) {
            uint256 portion = (amt * weights[i]) / 10_000;
            if (portion == 0) continue;
            uint256 got = router.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: quote,
                    tokenOut: basket[i],
                    fee: swapFee,
                    recipient: address(this),
                    amountIn: portion,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
            accPerShare[basket[i]] += (got * PREC) / elig;
            spent += portion;
        }
        emit Distributed(spent);
    }

    function claimable(address holder, address stock) public view returns (uint256) {
        if (excluded[holder]) return 0;
        uint256 gross = (IERC20(token).balanceOf(holder) * accPerShare[stock]) / PREC;
        uint256 c = claimedOf[holder][stock];
        return gross > c ? gross - c : 0;
    }

    /// @notice Claim your whole basket in one call.
    function claim() external {
        require(!excluded[msg.sender], "excluded");
        for (uint256 i; i < basket.length; i++) {
            address s = basket[i];
            uint256 amt = claimable(msg.sender, s);
            if (amt > 0) {
                claimedOf[msg.sender][s] += amt;
                IERC20(s).safeTransfer(msg.sender, amt);
                emit Claimed(msg.sender, s, amt);
            }
        }
    }
}
