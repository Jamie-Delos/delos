// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

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

interface ICensusKeeper {
    function keeper() external view returns (address);
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
    // Reserved payouts include rounding dust. They can never fund another distribution.
    mapping(address => uint256) public reserved;
    mapping(address => mapping(address => uint256)) private debtFraction;
    mapping(address => mapping(address => uint256)) private earnedFraction;

    bool private inited;
    /// @notice Distribution operator (defaults to the creator; may delegate). The Census keeper
    ///         registered on the curve (`CensusCurve.keeper()`) is ALSO authorized, so rewards are
    ///         converted and distributed automatically without every creator delegating first.
    address public operator;

    event Distributed(uint256 quoteSpent);
    event Claimed(address indexed holder, address indexed stock, uint256 amount);
    /// @notice A basket asset refused the transfer (issuer pause/blacklist). The entitlement stays
    ///         reserved for the holder; the other assets in the same claim were still paid.
    event ClaimDeferred(address indexed holder, address indexed stock, uint256 amount);
    event LaunchFeesConverted(uint256 tokenIn, uint256 quoteOut);

    // Custom errors survive the global revertStrings=strip build, so wallets/UIs can decode reasons.
    error NotOperator();
    error MinOut();
    error Insolvent();
    error Excluded();
    error BadParams();
    error NotEnoughFees();
    error Unspent();
    error SwapFailed();
    error Allocation();

    constructor(
        address quote_,
        address router_,
        uint24 swapFee_,
        address[] memory basket_,
        uint16[] memory weights_,
        bytes[] memory paths_,
        address allowanceHolder_
    ) {
        require(quote_.code.length > 0 && router_.code.length > 0, "contracts");
        require(basket_.length >= 1 && basket_.length <= 4 && basket_.length == weights_.length, "basket");
        require(paths_.length == basket_.length, "paths");
        uint256 sum;
        for (uint256 i; i < weights_.length; i++) {
            require(basket_[i].code.length > 0 && weights_[i] > 0, "asset");
            for (uint256 j; j < i; j++) require(basket_[i] != basket_[j], "duplicate");
            bytes memory route = paths_[i];
            if (route.length > 0) {
                require(basket_[i] != quote_ && route.length >= 43 && (route.length - 20) % 23 == 0, "route");
                address first;
                address last;
                assembly ("memory-safe") {
                    first := shr(96, mload(add(route, 32)))
                    last := shr(96, mload(add(add(route, 32), sub(mload(route), 20))))
                }
                require(first == quote_ && last == basket_[i], "endpoints");
            }
            sum += weights_[i];
        }
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
        require(token_.code.length > 0 && operator_ != address(0), "zero");
        inited = true;
        token = token_;
        operator = operator_;
        excluded[address(this)] = true; // the vault's own launch-token balance (LP fees) never earns
        excludedList.push(address(this));
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
        if (msg.sender != operator) revert NotOperator();
        require(newOperator != address(0), "zero");
        operator = newOperator;
    }

    /// @dev The per-coin operator OR the platform keeper registered on the curve may run conversions
    ///      and distributions (both supply off-chain minimum outputs and are trusted for price bounds).
    function _checkOperator() internal view {
        if (msg.sender == operator) return;
        if (census != address(0) && msg.sender == ICensusKeeper(census).keeper()) return;
        revert NotOperator();
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
    ///         going forward. Fractional debt is retained so repeated dust transfers cannot manufacture
    ///         whole-unit rewards. The token's balanceOf is read here; arithmetic failures revert.
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
            (uint256 units, uint256 fraction) = _earned(account, s, preBalance);
            settled[s][account] += units;
            earnedFraction[s][account] = fraction;
            rewardDebt[s][account] = Math.mulDiv(postBalance, aps, PREC);
            debtFraction[s][account] = mulmod(postBalance, aps, PREC);
        }
    }

    function _earned(address account, address s, uint256 balance) internal view returns (uint256 units, uint256 fraction) {
        uint256 aps = accPerShare[s];
        units = Math.mulDiv(balance, aps, PREC) - rewardDebt[s][account];
        uint256 rem = mulmod(balance, aps, PREC);
        uint256 debt = debtFraction[s][account];
        if (rem < debt) { units -= 1; rem += PREC; }
        fraction = rem - debt + earnedFraction[s][account];
        units += fraction / PREC;
        fraction %= PREC;
    }

    function availableQuote() public view returns (uint256) {
        return IERC20(quote).balanceOf(address(this)) - reserved[quote];
    }

    function _credit(address s, uint256 got, uint256 elig) internal {
        reserved[s] += got;
        accPerShare[s] += Math.mulDiv(got, PREC, elig);
    }

    /// @notice Convert all accumulated quote fees into the stock basket and credit holders per-share.
    /// @param minOut per-stock minimum output (computed off-chain from a fair price) — the swap reverts
    ///        if the pool would give less. A minimum output bounds loss; it does not eliminate MEV.
    function distribute(uint256[] calldata minOut) external nonReentrant returns (uint256 spent) {
        _checkOperator();
        if (minOut.length != basket.length) revert BadParams();
        uint256 amt = availableQuote();
        uint256 elig = eligibleSupply();
        if (amt == 0 || elig == 0) return 0;

        for (uint256 i; i < basket.length; i++) {
            uint256 portion = Math.mulDiv(amt, weights[i], 10_000);
            if (portion == 0) continue;
            uint256 got;
            if (basket[i] == quote) {
                // Anchor-paid dividend: fees are already in the payout asset (e.g. a HOOD-paired coin
                // pays holders HOOD). No swap needed — credit the portion straight through.
                got = portion;
                if (got < minOut[i]) revert MinOut();
            } else {
                if (minOut[i] == 0) revert MinOut();
                got = _sell(quote, basket[i], swapFee, paths[i], portion, minOut[i]);
            }
            _credit(basket[i], got, elig);
            spent += portion;
        }
        emit Distributed(spent);
    }

    /// @dev Sell exactly `amountIn` of `tokenIn` through the router — the multi-hop `route` if given,
    ///      else single-hop at `fee` — measuring actual balance deltas: reverts unless the full input
    ///      was spent and at least `minOut` of `tokenOut` was received.
    function _sell(address tokenIn, address tokenOut, uint24 fee, bytes memory route, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 got)
    {
        uint256 beforeIn = IERC20(tokenIn).balanceOf(address(this));
        uint256 beforeOut = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(address(router), amountIn);
        if (route.length > 0) {
            router.exactInput(
                ISwapRouter02.ExactInputParams({
                    path: route,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: minOut
                })
            );
        } else {
            router.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0
                })
            );
        }
        IERC20(tokenIn).forceApprove(address(router), 0);
        if (beforeIn - IERC20(tokenIn).balanceOf(address(this)) != amountIn) revert Unspent();
        got = IERC20(tokenOut).balanceOf(address(this)) - beforeOut;
        if (got < minOut) revert MinOut();
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
    ///             positive `minOut`. The operator still chooses price bounds and must be trusted.
    ///         The Uniswap `distribute()` above stays as the fallback if 0x is unavailable.
    function distributeVia0x(uint256[] calldata sellAmounts, bytes[] calldata swapData, uint256[] calldata minOut)
        external
        nonReentrant
        returns (uint256 spent)
    {
        _checkOperator();
        require(allowanceHolder != address(0), "no 0x");
        uint256 len = basket.length;
        if (sellAmounts.length != len || swapData.length != len || minOut.length != len) revert BadParams();
        uint256 elig = eligibleSupply();
        if (elig == 0) return 0;

        uint256 available = availableQuote();

        for (uint256 i; i < len; i++) {
            uint256 sell = sellAmounts[i];
            if (sell != Math.mulDiv(available, weights[i], 10_000)) revert Allocation();
            if (sell == 0) continue;
            address s = basket[i];
            if (s == quote) {
                if (swapData[i].length != 0 || sell < minOut[i]) revert MinOut();
                _credit(s, sell, elig);
                spent += sell;
                continue;
            }
            if (swapData[i].length == 0 || minOut[i] == 0) revert MinOut();
            uint256 pre = IERC20(s).balanceOf(address(this));
            uint256 preQuote = IERC20(quote).balanceOf(address(this));

            IERC20(quote).forceApprove(allowanceHolder, sell);
            (bool ok, ) = allowanceHolder.call(swapData[i]);
            if (!ok) revert SwapFailed();
            IERC20(quote).forceApprove(allowanceHolder, 0); // never leave a standing allowance
            if (preQuote - IERC20(quote).balanceOf(address(this)) != sell) revert Unspent();

            uint256 got = IERC20(s).balanceOf(address(this)) - pre;
            if (got < minOut[i]) revert MinOut();
            _credit(s, got, elig);
            spent += sell;
        }
        emit Distributed(spent);
    }

    /// @notice Convert launch-token LP fees into the quote asset so they fund the next distribution.
    ///         After graduation the LaunchLocker forwards the holders' share of BOTH pool fee assets
    ///         here; the launch-token side cannot be paid out directly (this vault distributes `quote`),
    ///         so the operator sells it into the canonical pool. Operator-gated with a mandatory
    ///         positive minimum output — the same slippage model as distribute(). The proceeds are
    ///         unreserved quote, so availableQuote() (and the next distribute) includes them.
    /// @param amountIn   launch tokens to sell (≤ this vault's balance).
    /// @param poolFee    fee tier of the canonical launch-token/quote pool.
    /// @param minQuoteOut off-chain-computed minimum quote output; the swap reverts below it.
    function convertLaunchFees(uint256 amountIn, uint24 poolFee, uint256 minQuoteOut)
        external
        nonReentrant
        returns (uint256 quoteOut)
    {
        _checkOperator();
        require(token != address(0), "uninitialized");
        if (amountIn == 0 || minQuoteOut == 0) revert BadParams();
        if (amountIn > IERC20(token).balanceOf(address(this))) revert NotEnoughFees();
        quoteOut = _sell(token, quote, poolFee, bytes(""), amountIn, minQuoteOut);
        emit LaunchFeesConverted(amountIn, quoteOut);
    }

    /// @notice Dividends of `stock` the holder can withdraw right now = (harvested + accrued-since-last-settle) − withdrawn.
    function withdrawableOf(address holder, address stock) public view returns (uint256) {
        if (excluded[holder]) return 0;
        (uint256 unsettled,) = _earned(holder, stock, IERC20(token).balanceOf(holder));
        uint256 total = settled[stock][holder] + unsettled;
        uint256 w = withdrawn[stock][holder];
        return total > w ? total - w : 0;
    }

    /// @notice Claim your whole basket in one call.
    function claim() external nonReentrant {
        _claim(msg.sender);
    }

    /// @notice Push a holder's earned basket to them. Callable by anyone (the keeper uses this to
    ///         deliver rewards automatically): it can only move the holder's own entitlement to the
    ///         holder's own address, so it grants the caller nothing.
    function claimFor(address holder) external nonReentrant {
        _claim(holder);
    }

    /// @dev Each basket asset is paid independently: if one issuer refuses the transfer (pause or
    ///      blacklist), that asset stays reserved for the holder and the remaining assets are still
    ///      paid, so a single frozen stock cannot brick a holder's whole basket or the keeper's push.
    function _claim(address holder) internal {
        if (excluded[holder]) revert Excluded();
        uint256 len = basket.length;
        for (uint256 i; i < len; i++) {
            address s = basket[i];
            uint256 amt = withdrawableOf(holder, s);
            if (amt == 0) continue;
            // Never hide a reserve deficit by paying the first claimant preferentially.
            if (IERC20(s).balanceOf(address(this)) < reserved[s]) revert Insolvent();
            if (!_tryTransfer(s, holder, amt)) {
                emit ClaimDeferred(holder, s, amt);
                continue;
            }
            reserved[s] -= amt;
            withdrawn[s][holder] += amt;
            emit Claimed(holder, s, amt);
        }
    }

    /// @dev ERC20 transfer that reports failure instead of reverting (tolerates missing return data).
    function _tryTransfer(address asset, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = asset.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }
}
