// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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

    struct ExactInputParams {
        bytes path; // encoded multi-hop route, e.g. WETH -> USDG -> stock
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @title DividendVault (v2) — production dividend accounting
/// @notice One per launched v2 token. It receives that token's protocol fee share (in the quote asset,
///         e.g. WETH), swaps it across a 1–4 tokenized-stock basket, and pays it out to holders pro-rata.
///
///         ACCOUNTING (the production fix — "reward-debt" / settle-on-transfer, equivalent to the
///         magnified-dividend-corrections pattern): each holder's earned dividends are settled at
///         EVERY balance change via `onTokenTransfer`, which the launch token calls on every transfer.
///         Because a holder's `rewardDebt` is re-based to the current per-share accumulator whenever
///         their balance changes, **a holder can only ever earn dividends distributed WHILE they held
///         their tokens** — a buyer cannot claim distributions that happened before they bought (the
///         bug in the old `balance × accPerShare − claimed` model), and a seller keeps what they earned
///         up to the sale. The pool / locker / factory / vault / dead address are excluded (never earn),
///         so distributions are split only across circulating holders.
contract DividendVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant PREC = 1e18;

    address public immutable factory;
    address public immutable quote; // the fee asset the vault swaps FROM (e.g. WETH)
    ISwapRouter02 public immutable router;
    uint24 public immutable swapFee; // fee tier for quote->stock swaps
    address public immutable allowanceHolder; // 0x AllowanceHolder (approve + call target); address(0) => 0x path off

    address public token; // the dividend-bearing launch token
    address[] public basket; // 1–4 tokenized stocks
    uint16[] public weights; // bps, sum 10000
    // Per-stock swap route from `quote`. Empty entry => direct single-hop at `swapFee`; a non-empty
    // entry is an encoded V3 path (e.g. WETH -> USDG -> stock) for USDG-quoted stocks.
    bytes[] public paths;

    address[] public excludedList;
    mapping(address => bool) public excluded;

    // ---- dividend accounting (reward-debt, settled on every transfer) ----
    mapping(address => uint256) public accPerShare;                    // stock => accumulated dividend per eligible share (×PREC)
    mapping(address => mapping(address => uint256)) public rewardDebt; // stock => holder => acc "paid up to" (balance×accPerShare/PREC at last settle)
    mapping(address => mapping(address => uint256)) public settled;    // stock => holder => harvested, not-yet-withdrawn dividends
    mapping(address => mapping(address => uint256)) public withdrawn;  // stock => holder => total withdrawn

    bool private inited;
    address public operator; // only address allowed to run distribute() (supplies off-chain slippage bounds)

    event Distributed(uint256 quoteSpent);
    event Claimed(address indexed holder, address indexed stock, uint256 amount);

    constructor(
        address quote_,
        address router_,
        uint24 swapFee_,
        address[] memory basket_,
        uint16[] memory weights_,
        bytes[] memory paths_,
        address allowanceHolder_
    ) {
        require(basket_.length >= 1 && basket_.length <= 4 && basket_.length == weights_.length, "basket");
        require(paths_.length == basket_.length, "paths");
        uint256 sum;
        for (uint256 i; i < weights_.length; i++) sum += weights_[i];
        require(sum == 10_000, "weights");
        factory = msg.sender;
        quote = quote_;
        router = ISwapRouter02(router_);
        swapFee = swapFee_;
        basket = basket_;
        weights = weights_;
        paths = paths_;
        allowanceHolder = allowanceHolder_;
    }

    /// @notice Wired once by the factory: the token to distribute to, and the addresses to exclude.
    function init(address token_, address[] calldata excluded_, address operator_) external {
        require(msg.sender == factory && !inited, "init");
        inited = true;
        token = token_;
        operator = operator_;
        for (uint256 i; i < excluded_.length; i++) {
            if (!excluded[excluded_[i]]) {
                excluded[excluded_[i]] = true;
                excludedList.push(excluded_[i]);
            }
        }
    }

    /// @notice Hand distribution rights to a keeper (defaults to the creator). The operator supplies
    ///         off-chain-computed minimum outputs so the basket swaps can't be sandwiched.
    function setOperator(address newOperator) external {
        require(msg.sender == operator, "not operator");
        operator = newOperator;
    }

    address public census; // the CensusCurve, allowed to exclude the graduated pool once it exists

    /// @notice Wired once by the factory: the CensusCurve. It excludes the graduated Uniswap pool from
    ///         dividends at graduation (the pool holds a coin balance that must never accrue).
    function setCensus(address census_) external {
        require(msg.sender == factory && census == address(0), "census");
        census = census_;
    }

    /// @notice Exclude an address (the graduated pool) from dividends. Curve-only, additive.
    function excludeAddress(address a) external {
        require(msg.sender == census, "not census");
        if (!excluded[a]) {
            excluded[a] = true;
            excludedList.push(a);
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

    // ------------------------------------------------------------------------------------------------
    // Transfer hook — the heart of the fix. The launch token calls this AFTER every balance update.
    // ------------------------------------------------------------------------------------------------

    /// @notice Called by the launch token on every transfer (post balance update). Harvests each
    ///         side's dividends earned on the balance they held since their last settle, then re-bases
    ///         their rewardDebt to their NEW balance — so future distributions only credit tokens held
    ///         going forward. This is what stops "buy, then claim the past" draining. No external calls,
    ///         cannot revert under normal use (so it can never brick token transfers).
    function onTokenTransfer(address from, address to, uint256 value) external {
        require(msg.sender == token, "only token");
        if (from == to || value == 0) return;
        // `from` sent `value` away => its balance before the transfer was current + value.
        if (from != address(0) && !excluded[from]) _settle(from, IERC20(token).balanceOf(from) + value);
        // `to` received `value` => its balance before the transfer was current - value.
        if (to != address(0) && !excluded[to]) _settle(to, IERC20(token).balanceOf(to) - value);
    }

    /// @dev Harvest `account`'s earned dividends for the period since its last settle (its balance was
    ///      constant = `preBalance` over that period), then re-base rewardDebt to its current balance.
    function _settle(address account, uint256 preBalance) internal {
        uint256 len = basket.length;
        uint256 postBalance = IERC20(token).balanceOf(account);
        for (uint256 i; i < len; i++) {
            address s = basket[i];
            uint256 aps = accPerShare[s];
            uint256 accPre = (preBalance * aps) / PREC; // acc on the balance held since last settle
            uint256 debt = rewardDebt[s][account];      // acc paid up to at last settle (accPerShare is monotonic => accPre >= debt)
            if (accPre > debt) settled[s][account] += accPre - debt;
            rewardDebt[s][account] = (postBalance * aps) / PREC; // re-base to the NEW balance
        }
    }

    /// @notice Convert all accumulated quote fees into the stock basket and credit holders per-share.
    /// @param minOut per-stock minimum output (computed off-chain from a fair price) — the swap reverts
    ///        if the pool would give less, so the conversion can't be sandwiched.
    function distribute(uint256[] calldata minOut) external nonReentrant returns (uint256 spent) {
        require(msg.sender == operator, "not operator");
        require(minOut.length == basket.length, "minOut");
        uint256 amt = IERC20(quote).balanceOf(address(this));
        uint256 elig = eligibleSupply();
        if (amt == 0 || elig == 0) return 0;

        IERC20(quote).forceApprove(address(router), amt);
        for (uint256 i; i < basket.length; i++) {
            uint256 portion = (amt * weights[i]) / 10_000;
            if (portion == 0) continue;
            bytes memory route = paths[i];
            uint256 got;
            if (basket[i] == quote) {
                // Anchor-paid dividend: fees are already in the payout asset (e.g. a HOOD-paired coin
                // pays holders HOOD). No swap needed — credit the portion straight through.
                got = portion;
            } else if (route.length > 0) {
                got = router.exactInput(
                    ISwapRouter02.ExactInputParams({
                        path: route,
                        recipient: address(this),
                        amountIn: portion,
                        amountOutMinimum: minOut[i]
                    })
                );
            } else {
                got = router.exactInputSingle(
                    ISwapRouter02.ExactInputSingleParams({
                        tokenIn: quote,
                        tokenOut: basket[i],
                        fee: swapFee,
                        recipient: address(this),
                        amountIn: portion,
                        amountOutMinimum: minOut[i],
                        sqrtPriceLimitX96: 0
                    })
                );
            }
            accPerShare[basket[i]] += (got * PREC) / elig;
            spent += portion;
        }
        emit Distributed(spent);
    }

    /// @notice Convert accumulated quote fees into the stock basket via the 0x Swap API and credit
    ///         holders per-share. The keeper fetches a 0x quote per stock OFF-CHAIN (taker = this vault)
    ///         and passes the exact `sellAmounts`, the quote's returned `transaction.data` as `swapData`,
    ///         and its `minBuyAmount` as `minOut`. Security model:
    ///           - operator-gated (same trusted keeper as `distribute`), nonReentrant;
    ///           - the ONLY address ever approved or called is the pinned `allowanceHolder` (0x's stable
    ///             entry point), never an address the API hands back — so opaque calldata can't retarget us;
    ///           - the quote allowance is set to the EXACT sellAmount and reset to 0 right after the call;
    ///           - the stock credited is the measured balance delta, and the swap reverts unless it clears
    ///             `minOut` — so a bad or rogue quote can only grief (revert), never drain the vault.
    ///         The Uniswap `distribute()` above stays as the fallback if 0x is unavailable.
    function distributeVia0x(uint256[] calldata sellAmounts, bytes[] calldata swapData, uint256[] calldata minOut)
        external
        nonReentrant
        returns (uint256 spent)
    {
        require(msg.sender == operator, "not operator");
        require(allowanceHolder != address(0), "no 0x");
        uint256 len = basket.length;
        require(sellAmounts.length == len && swapData.length == len && minOut.length == len, "len");
        uint256 elig = eligibleSupply();
        if (elig == 0) return 0;

        uint256 total;
        for (uint256 i; i < len; i++) total += sellAmounts[i];
        require(total <= IERC20(quote).balanceOf(address(this)), "oversell");

        for (uint256 i; i < len; i++) {
            uint256 sell = sellAmounts[i];
            if (sell == 0 || swapData[i].length == 0) continue;
            address s = basket[i];
            uint256 pre = IERC20(s).balanceOf(address(this));

            IERC20(quote).forceApprove(allowanceHolder, sell);
            (bool ok, ) = allowanceHolder.call(swapData[i]);
            require(ok, "0x swap failed");
            IERC20(quote).forceApprove(allowanceHolder, 0); // never leave a standing allowance

            uint256 got = IERC20(s).balanceOf(address(this)) - pre;
            require(got >= minOut[i], "minOut");
            accPerShare[s] += (got * PREC) / elig;
            spent += sell;
        }
        emit Distributed(spent);
    }

    /// @notice Dividends of `stock` the holder can withdraw right now = (harvested + accrued-since-last-settle) − withdrawn.
    function withdrawableOf(address holder, address stock) public view returns (uint256) {
        if (excluded[holder]) return 0;
        uint256 aps = accPerShare[stock];
        uint256 acc = (IERC20(token).balanceOf(holder) * aps) / PREC; // acc on current balance
        uint256 debt = rewardDebt[stock][holder];
        uint256 unsettled = acc > debt ? acc - debt : 0;              // earned since the last settle
        uint256 total = settled[stock][holder] + unsettled;
        uint256 w = withdrawn[stock][holder];
        return total > w ? total - w : 0;
    }

    /// @notice Claim your whole basket in one call.
    function claim() external nonReentrant {
        require(!excluded[msg.sender], "excluded");
        uint256 len = basket.length;
        for (uint256 i; i < len; i++) {
            address s = basket[i];
            uint256 amt = withdrawableOf(msg.sender, s);
            if (amt == 0) continue;
            // Cap at the vault's live balance so per-share rounding dust can never make a claim
            // revert; any (sub-wei-scale) remainder stays owed and is paid from the next distribution.
            uint256 bal = IERC20(s).balanceOf(address(this));
            if (amt > bal) amt = bal;
            if (amt == 0) continue;
            withdrawn[s][msg.sender] += amt;
            IERC20(s).safeTransfer(msg.sender, amt);
            emit Claimed(msg.sender, s, amt);
        }
    }
}
