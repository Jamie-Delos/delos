// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IV3Router {
    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface ICurveForVault {
    function keeper() external view returns (address);
}

/// @title CensusRewardVault
/// @notice Holder reflections for one V4 launch. Receives the launch's reflection fee in the quote asset
///         (from the curve before graduation, from the Census hook after), converts it into an immutable
///         basket of up to three reward assets and credits holders pro-rata with reward-debt accounting
///         settled on every transfer, so a buyer never earns rewards distributed before they held.
///
///         Basket assets are the quote (pairing) asset itself (credited without conversion) and/or
///         tokenised stocks listed on the curve's reward-asset allowlist at launch time, reached through a
///         Uniswap V3 route or 0x. The launch token is NEVER a reward asset: rewards are always paid in
///         quoted assets. There is no routine that could sell or spend anything credited to holders.
///
///         Distribution is keeper-only (the curve's platform keeper). The launch creator is deliberately
///         NOT an operator: whoever calls distribute chooses the minimum output, and distributeVia0x hands
///         caller calldata to the 0x AllowanceHolder, so an operator can route the not-yet-credited quote
///         to themselves (security checklist 2026-09-23, F1). Census already runs the keeper and is the
///         only party that should hold that trust.
contract CensusRewardVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant PREC = 1e18;
    uint256 public constant MAX_BASKET = 3;

    address public immutable factory;
    address public immutable quote;
    address public immutable token;          // the launch token holders are measured in
    address public immutable census;         // the CensusCurveV4: keeper authority
    IV3Router public immutable router;       // V3 router for stock routes
    uint24 public immutable swapFee;
    address public immutable allowanceHolder; // 0x AllowanceHolder; address(0) => 0x path off

    address[] public basket;
    uint16[] public weights;
    bytes[] public paths;

    address[] public excludedList;
    mapping(address => bool) public excluded;

    mapping(address => uint256) public accPerShare;
    mapping(address => mapping(address => uint256)) public rewardDebt;
    mapping(address => mapping(address => uint256)) public settled;
    mapping(address => mapping(address => uint256)) public withdrawn;
    mapping(address => uint256) public reserved;
    mapping(address => mapping(address => uint256)) private debtFraction;
    mapping(address => mapping(address => uint256)) private earnedFraction;

    bool private inited;

    event Distributed(uint256 quoteSpent);
    event Claimed(address indexed holder, address indexed asset, uint256 amount);
    event ClaimDeferred(address indexed holder, address indexed asset, uint256 amount);

    error NotOperator();
    error MinOut();
    error Insolvent();
    error Excluded();
    error BadParams();
    error Unspent();
    error SwapFailed();
    error Allocation();

    constructor(
        address quote_, address router_, uint24 swapFee_,
        address[] memory basket_, uint16[] memory weights_, bytes[] memory paths_,
        address allowanceHolder_, address token_, address census_
    ) {
        require(quote_.code.length > 0 && router_.code.length > 0 && token_.code.length > 0 && census_.code.length > 0, "contracts");
        require(basket_.length >= 1 && basket_.length <= MAX_BASKET && basket_.length == weights_.length, "basket");
        require(paths_.length == basket_.length, "paths");
        uint256 sum;
        for (uint256 i; i < weights_.length; i++) {
            require(basket_[i].code.length > 0 && weights_[i] > 0, "asset");
            require(basket_[i] != token_, "coin is never a reward");
            for (uint256 j; j < i; j++) require(basket_[i] != basket_[j], "duplicate");
            bytes memory route = paths_[i];
            if (basket_[i] == quote_) {
                require(route.length == 0, "route"); // credited as-is, never routed
            } else if (route.length > 0) {
                require(route.length >= 43 && (route.length - 20) % 23 == 0, "route");
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
        token = token_;
        census = census_;
        router = IV3Router(router_);
        swapFee = swapFee_;
        basket = basket_;
        weights = weights_;
        paths = paths_;
        allowanceHolder = allowanceHolder_;
    }

    /// @notice Wired once by the factory: custody addresses that never earn.
    function init(address[] calldata excluded_) external {
        require(msg.sender == factory && !inited, "init");
        inited = true;
        _exclude(address(this));
        _exclude(DEAD);
        for (uint256 i; i < excluded_.length; i++) _exclude(excluded_[i]);
    }

    function _exclude(address a) internal {
        if (a != address(0) && !excluded[a]) { excluded[a] = true; excludedList.push(a); }
    }

    /// @notice The only address that may distribute: the curve's platform keeper (kept as a view named
    ///         `operator` for tooling that reads it; it follows CensusCurveV4.setKeeper).
    function operator() public view returns (address) {
        return ICurveForVault(census).keeper();
    }

    function _checkOperator() internal view {
        if (msg.sender != operator() || msg.sender == address(0)) revert NotOperator();
    }

    /// @notice Additional custody exclusion by the curve (additive only).
    function excludeAddress(address a) external {
        require(msg.sender == census, "not census");
        _exclude(a);
    }

    function basketLength() external view returns (uint256) { return basket.length; }
    function excludedLength() external view returns (uint256) { return excludedList.length; }

    /// @notice Circulating supply that earns rewards: total minus every custody/excluded balance
    ///         (PoolManager, curve, factory, vault, router, hook, graduator, dead).
    function eligibleSupply() public view returns (uint256 s) {
        s = IERC20(token).totalSupply();
        for (uint256 i; i < excludedList.length; i++) s -= IERC20(token).balanceOf(excludedList[i]);
    }

    // ---- transfer checkpoint: called by the launch token after every balance update ----
    function onTokenTransfer(address from, address to, uint256 value) external {
        require(msg.sender == token, "only token");
        if (from == to || value == 0) return;
        if (from != address(0) && !excluded[from]) _settle(from, IERC20(token).balanceOf(from) + value);
        if (to != address(0) && !excluded[to]) _settle(to, IERC20(token).balanceOf(to) - value);
    }

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

    /// @notice Quote that has arrived and is not yet reserved for holders (a quote basket entry reserves it).
    function availableQuote() public view returns (uint256) {
        return IERC20(quote).balanceOf(address(this)) - reserved[quote];
    }

    function _credit(address s, uint256 got, uint256 elig) internal {
        reserved[s] += got;
        accPerShare[s] += Math.mulDiv(got, PREC, elig);
    }

    /// @notice Convert every unreserved quote unit into the basket and credit holders per share.
    /// @param minOut per-asset minimum output from an off-chain fair price (mandatory for converted assets).
    function distribute(uint256[] calldata minOut) external nonReentrant returns (uint256 spent) {
        _checkOperator();
        if (minOut.length != basket.length) revert BadParams();
        uint256 amt = availableQuote();
        uint256 elig = eligibleSupply();
        if (amt == 0 || elig == 0) return 0;
        for (uint256 i; i < basket.length; i++) {
            uint256 portion = Math.mulDiv(amt, weights[i], 10_000);
            if (portion == 0) continue;
            address s = basket[i];
            uint256 got;
            if (s == quote) {
                got = portion;
                if (got < minOut[i]) revert MinOut();
            } else {
                if (minOut[i] == 0) revert MinOut();
                got = _sell(quote, s, swapFee, paths[i], portion, minOut[i]);
            }
            _credit(s, got, elig);
            spent += portion;
        }
        emit Distributed(spent);
    }

    function _sell(address tokenIn, address tokenOut, uint24 fee, bytes memory route, uint256 amountIn, uint256 minOut) internal returns (uint256 got) {
        uint256 beforeIn = IERC20(tokenIn).balanceOf(address(this));
        uint256 beforeOut = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(address(router), amountIn);
        if (route.length > 0) {
            router.exactInput(IV3Router.ExactInputParams({ path: route, recipient: address(this), amountIn: amountIn, amountOutMinimum: minOut }));
        } else {
            router.exactInputSingle(IV3Router.ExactInputSingleParams({ tokenIn: tokenIn, tokenOut: tokenOut, fee: fee, recipient: address(this), amountIn: amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0 }));
        }
        IERC20(tokenIn).forceApprove(address(router), 0);
        if (beforeIn - IERC20(tokenIn).balanceOf(address(this)) != amountIn) revert Unspent();
        got = IERC20(tokenOut).balanceOf(address(this)) - beforeOut;
        if (got < minOut) revert MinOut();
    }

    /// @notice 0x route for stock basket assets (the quote entry is credited as-is).
    function distributeVia0x(uint256[] calldata sellAmounts, bytes[] calldata swapData, uint256[] calldata minOut) external nonReentrant returns (uint256 spent) {
        _checkOperator();
        require(allowanceHolder != address(0), "no 0x");
        uint256 len = basket.length;
        if (sellAmounts.length != len || swapData.length != len || minOut.length != len) revert BadParams();
        uint256 elig = eligibleSupply();
        if (elig == 0) return 0;
        uint256 available = availableQuote();
        for (uint256 i; i < len; i++) {
            uint256 sellAmt = sellAmounts[i];
            if (sellAmt != Math.mulDiv(available, weights[i], 10_000)) revert Allocation();
            if (sellAmt == 0) continue;
            address s = basket[i];
            if (s == quote) {
                if (swapData[i].length != 0 || sellAmt < minOut[i]) revert MinOut();
                _credit(s, sellAmt, elig);
                spent += sellAmt;
                continue;
            }
            if (swapData[i].length == 0 || minOut[i] == 0) revert MinOut();
            uint256 pre = IERC20(s).balanceOf(address(this));
            uint256 preQuote = IERC20(quote).balanceOf(address(this));
            IERC20(quote).forceApprove(allowanceHolder, sellAmt);
            (bool ok, ) = allowanceHolder.call(swapData[i]);
            if (!ok) revert SwapFailed();
            IERC20(quote).forceApprove(allowanceHolder, 0);
            if (preQuote - IERC20(quote).balanceOf(address(this)) != sellAmt) revert Unspent();
            uint256 got = IERC20(s).balanceOf(address(this)) - pre;
            if (got < minOut[i]) revert MinOut();
            _credit(s, got, elig);
            spent += sellAmt;
        }
        emit Distributed(spent);
    }

    function withdrawableOf(address holder, address asset) public view returns (uint256) {
        if (excluded[holder]) return 0;
        (uint256 unsettled,) = _earned(holder, asset, IERC20(token).balanceOf(holder));
        uint256 total = settled[asset][holder] + unsettled;
        uint256 w = withdrawn[asset][holder];
        return total > w ? total - w : 0;
    }

    function claim() external nonReentrant { _claim(msg.sender); }

    /// @notice Push a holder's earned basket to the holder. Anyone may call; it moves only the holder's
    ///         own entitlement to the holder's own address.
    function claimFor(address holder) external nonReentrant { _claim(holder); }

    function _claim(address holder) internal {
        if (excluded[holder]) revert Excluded();
        uint256 len = basket.length;
        for (uint256 i; i < len; i++) {
            address s = basket[i];
            uint256 amt = withdrawableOf(holder, s);
            if (amt == 0) continue;
            if (IERC20(s).balanceOf(address(this)) < reserved[s]) revert Insolvent();
            if (!_tryTransfer(s, holder, amt)) { emit ClaimDeferred(holder, s, amt); continue; }
            reserved[s] -= amt;
            withdrawn[s][holder] += amt;
            emit Claimed(holder, s, amt);
        }
    }

    function _tryTransfer(address asset, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = asset.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }
}
