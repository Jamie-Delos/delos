// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {INonfungiblePositionManager, IUniswapV3Pool} from "./interfaces/IUniswap.sol";

/// @title LaunchLocker
/// @notice Permanent home for launch LP NFTs. Positions can NEVER be withdrawn — there is no
///         unlock and no transfer-out path. Only accrued swap fees can be collected.
///
///         Fee split depends on graduation. Before a token graduates (price has not yet crossed
///         its graduation tick) the creator keeps 100% of fees. Once it graduates — latched, one
///         way — the protocol takes `protocolFeeBps` (destined for $TOKEN buyback & burn) and the
///         creator keeps the rest. Graduation is read live from the pool's current tick.
contract LaunchLocker is IERC721Receiver {
    using SafeERC20 for IERC20;

    struct Lock {
        address creator; // receives the creator share of fees
        address token0;
        address token1;
        address pool; // the Uniswap V3 pool, read for the current tick
        int24 graduationTick; // tick (pool orientation) at which the token graduates
        bool tokenIsToken0; // true if the launch token sorts below WETH
        bool graduated; // latched once the graduation tick is crossed
        bool exists;
    }

    INonfungiblePositionManager public immutable npm;
    address public immutable feeVault;
    address public immutable deployer;
    address public factory; // set once, right after the factory is deployed

    /// @notice Protocol fee (bps) applied to fee collections AFTER graduation. Pre-graduation is 0.
    uint16 public immutable protocolFeeBps;
    uint16 public constant BPS_DENOM = 10_000;

    mapping(uint256 => Lock) public locks; // tokenId => Lock

    event Registered(uint256 indexed tokenId, address indexed creator, address token0, address token1);
    event Graduated(uint256 indexed tokenId);
    event FeesCollected(
        uint256 indexed tokenId,
        address indexed creator,
        bool graduated,
        uint256 creatorAmount0,
        uint256 creatorAmount1,
        uint256 protocolAmount0,
        uint256 protocolAmount1
    );

    error NotFactory();
    error UnknownPosition();
    error FactoryAlreadySet();
    error NotDeployer();

    constructor(address npm_, address feeVault_, uint16 protocolFeeBps_) {
        require(protocolFeeBps_ <= BPS_DENOM, "fee too high");
        npm = INonfungiblePositionManager(npm_);
        feeVault = feeVault_;
        deployer = msg.sender;
        protocolFeeBps = protocolFeeBps_;
    }

    /// @notice Wire up the factory once, after it has been deployed against this locker.
    function initFactory(address factory_) external {
        if (msg.sender != deployer) revert NotDeployer();
        if (factory != address(0)) revert FactoryAlreadySet();
        factory = factory_;
    }

    /// @notice Called by the factory right after it mints the position to this locker.
    function register(
        uint256 tokenId,
        address creator,
        address token0,
        address token1,
        address pool,
        int24 graduationTick,
        bool tokenIsToken0
    ) external {
        if (msg.sender != factory) revert NotFactory();
        locks[tokenId] = Lock({
            creator: creator,
            token0: token0,
            token1: token1,
            pool: pool,
            graduationTick: graduationTick,
            tokenIsToken0: tokenIsToken0,
            graduated: false,
            exists: true
        });
        emit Registered(tokenId, creator, token0, token1);
    }

    /// @notice True once the pool price has crossed the token's graduation tick.
    function isGraduated(uint256 tokenId) public view returns (bool) {
        Lock memory lock = locks[tokenId];
        if (!lock.exists) return false;
        if (lock.graduated) return true;
        return _crossedGraduation(lock);
    }

    /// @notice Sweep accumulated V3 swap fees. Callable by anyone (the split is fixed on-chain).
    function collectFees(uint256 tokenId) external returns (uint256 amount0, uint256 amount1) {
        Lock storage lock = locks[tokenId];
        if (!lock.exists) revert UnknownPosition();

        // Latch graduation the first time price crosses the threshold.
        if (!lock.graduated && _crossedGraduation(lock)) {
            lock.graduated = true;
            emit Graduated(tokenId);
        }
        uint16 bps = lock.graduated ? protocolFeeBps : 0;

        (amount0, amount1) = npm.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        (uint256 c0, uint256 p0) = _split(amount0, bps);
        (uint256 c1, uint256 p1) = _split(amount1, bps);

        if (p0 > 0) IERC20(lock.token0).safeTransfer(feeVault, p0);
        if (p1 > 0) IERC20(lock.token1).safeTransfer(feeVault, p1);
        if (c0 > 0) IERC20(lock.token0).safeTransfer(lock.creator, c0);
        if (c1 > 0) IERC20(lock.token1).safeTransfer(lock.creator, c1);

        emit FeesCollected(tokenId, lock.creator, lock.graduated, c0, c1, p0, p1);
    }

    /// @dev Price rises with buys. If the token is token0, that means the tick rises; if it's
    ///      token1, the tick falls. Graduation = tick has moved past the graduation tick.
    function _crossedGraduation(Lock memory lock) internal view returns (bool) {
        (, int24 tick, , , , , ) = IUniswapV3Pool(lock.pool).slot0();
        return lock.tokenIsToken0 ? tick >= lock.graduationTick : tick <= lock.graduationTick;
    }

    function _split(uint256 amount, uint16 bps)
        internal
        pure
        returns (uint256 creatorAmount, uint256 protocolAmount)
    {
        protocolAmount = (amount * bps) / BPS_DENOM;
        creatorAmount = amount - protocolAmount;
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }
}
