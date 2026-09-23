// Rewards are only ever paid in quoted assets (the pairing asset or allow-listed tokenised stocks); the launch
// token is never a reward and never in a basket. The stock list lives on-chain (curve allowlist) so new stocks
// can be added later without changing any contract.
const fs = require('fs');
function edit(file, pairs) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [a, b] of pairs) { const n = s.split(a).length - 1; if (n !== 1) throw new Error(`${file}: ${n} matches for ${a.slice(0, 70)}`); s = s.replace(a, b); }
  fs.writeFileSync(file, s);
}
edit('contracts/v4/CensusCurveV4.sol', [
  [`    mapping(address => bool) public allowedQuote;\n`,
   `    mapping(address => bool) public allowedQuote;\n    /// @notice Reward assets a launch may put in its basket (tokenised stocks). Deployer-managed and\n    ///         additive over time: new stocks are listed here, never by changing contracts. A launch's\n    ///         basket is validated against this list at launch and then frozen for that launch.\n    mapping(address => bool) public allowedRewardAsset;\n`],
  [`    event QuoteAllowed(address indexed quote, bool allowed);\n`, `    event QuoteAllowed(address indexed quote, bool allowed);\n    event RewardAssetAllowed(address indexed asset, bool allowed);\n`],
  [`    function setKeeper(address keeper_) external {`,
   `    /// @notice List (or delist, for NEW launches only) a tokenised stock as a basket asset.\n    function setRewardAssetAllowed(address asset, bool ok) external {\n        if (msg.sender != deployer) revert NotDeployer();\n        if (asset == address(0) || asset.code.length == 0) revert BadParams();\n        allowedRewardAsset[asset] = ok;\n        emit RewardAssetAllowed(asset, ok);\n    }\n\n    function setKeeper(address keeper_) external {`],
]);
edit('contracts/v4/CensusRewardVault.sol', [
  [`import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";\nimport {Currency} from "@uniswap/v4-core/src/types/Currency.sol";\nimport {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";\nimport {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";\nimport {CensusV4Router} from "./CensusV4Router.sol";\n`, ``],
  [`interface ICurveForVault {\n    function keeper() external view returns (address);\n    function isGraduated(address coin) external view returns (bool);\n    function buy(address coin, uint256 quoteIn, uint256 minTokensOut) external returns (uint256 tokensOut);\n}`,
   `interface ICurveForVault {\n    function keeper() external view returns (address);\n}`],
  [`///         Basket assets: the quote (pairing) asset itself (no conversion), the launch token (bought on\n///         the canonical venue: the curve before graduation, the hooked V4 pool after), or any other\n///         supported asset reachable through a Uniswap V3 route or 0x. Launch tokens credited to holders\n///         are reserved and can never be sold or spent by the vault: there is no conversion routine.`,
   `///         Basket assets are the quote (pairing) asset itself (credited without conversion) and/or\n///         tokenised stocks listed on the curve's reward-asset allowlist at launch time, reached through a\n///         Uniswap V3 route or 0x. The launch token is NEVER a reward asset: rewards are always paid in\n///         quoted assets. There is no routine that could sell or spend anything credited to holders.`],
  [`    address public immutable census;         // the CensusCurveV4: keeper authority, pre-graduation buys\n    CensusV4Router public immutable v4Router;\n`, `    address public immutable census;         // the CensusCurveV4: keeper authority\n`],
  [`        address allowanceHolder_, address token_, address census_, address v4Router_\n    ) {\n        require(quote_.code.length > 0 && router_.code.length > 0 && token_.code.length > 0 && census_.code.length > 0 && v4Router_.code.length > 0, "contracts");`,
   `        address allowanceHolder_, address token_, address census_\n    ) {\n        require(quote_.code.length > 0 && router_.code.length > 0 && token_.code.length > 0 && census_.code.length > 0, "contracts");`],
  [`            require(basket_[i].code.length > 0 && weights_[i] > 0, "asset");\n            for (uint256 j; j < i; j++) require(basket_[i] != basket_[j], "duplicate");\n            bytes memory route = paths_[i];\n            if (basket_[i] == quote_ || basket_[i] == token_) {\n                require(route.length == 0, "route"); // canonical venues, never an external route\n            } else if (route.length > 0) {`,
   `            require(basket_[i].code.length > 0 && weights_[i] > 0, "asset");\n            require(basket_[i] != token_, "coin is never a reward");\n            for (uint256 j; j < i; j++) require(basket_[i] != basket_[j], "duplicate");\n            bytes memory route = paths_[i];\n            if (basket_[i] == quote_) {\n                require(route.length == 0, "route"); // credited as-is, never routed\n            } else if (route.length > 0) {`],
  [`        census = census_;\n        v4Router = CensusV4Router(v4Router_);\n`, `        census = census_;\n`],
  [`            uint256 got;\n            uint256 used = portion;\n            if (s == quote) {`, `            uint256 got;\n            if (s == quote) {`],
  [`            } else if (s == token) {\n                if (minOut[i] == 0) revert MinOut();\n                (got, used) = _buyLaunchToken(portion, minOut[i]);\n            } else {`, `            } else {`],
  [`            _credit(s, got, elig);\n            spent += used;\n        }\n        emit Distributed(spent);\n    }\n\n    /// @dev Buy the launch token`, `            _credit(s, got, elig);\n            spent += portion;\n        }\n        emit Distributed(spent);\n    }\n\n    /// @dev Buy the launch token`],
  [`    /// @notice 0x route for external basket assets (quote and launch-token entries use their canonical paths).`, `    /// @notice 0x route for stock basket assets (the quote entry is credited as-is).`],
  [`            if (s == token) {\n                if (swapData[i].length != 0 || minOut[i] == 0) revert MinOut();\n                (uint256 bought, uint256 used) = _buyLaunchToken(sellAmt, minOut[i]);\n                _credit(s, bought, elig);\n                spent += used;\n                continue;\n            }\n`, ``],
]);
// Remove the whole _buyLaunchToken function.
{
  const f = 'contracts/v4/CensusRewardVault.sol';
  let s = fs.readFileSync(f, 'utf8');
  const start = s.indexOf('    /// @dev Buy the launch token');
  const end = s.indexOf('    function _sell(');
  if (start < 0 || end < 0 || end < start) throw new Error('buyLaunchToken block not found');
  s = s.slice(0, start) + s.slice(end);
  fs.writeFileSync(f, s);
}
edit('contracts/v4/CensusRewardVaultDeployer.sol', [
  [`        address allowanceHolder, address token, address census, address v4Router,\n        address[] calldata excluded_, address operator\n    ) external returns (address vault) {\n        if (msg.sender != launchFactory) revert NotLaunchFactory();\n        CensusRewardVault v = new CensusRewardVault(quote, router, swapFee, basket, weights, paths, allowanceHolder, token, census, v4Router);`,
   `        address allowanceHolder, address token, address census,\n        address[] calldata excluded_, address operator\n    ) external returns (address vault) {\n        if (msg.sender != launchFactory) revert NotLaunchFactory();\n        CensusRewardVault v = new CensusRewardVault(quote, router, swapFee, basket, weights, paths, allowanceHolder, token, census);`],
]);
edit('contracts/LaunchFactoryV4.sol', [
  [`    function graduator() external view returns (address);\n}`, `    function graduator() external view returns (address);\n    function allowedRewardAsset(address asset) external view returns (bool);\n}`],
  [`        address allowanceHolder, address token, address census, address v4Router,\n        address[] calldata excluded_, address operator\n    ) external returns (address vault);`, `        address allowanceHolder, address token, address census,\n        address[] calldata excluded_, address operator\n    ) external returns (address vault);`],
  [`///         the whole supply seeded into CensusCurveV4, optional 1-4% holder reflection paid into an\n///         immutable basket of up to three reward assets, and graduation into the hooked Uniswap V4 pool.`,
   `///         the whole supply seeded into CensusCurveV4, optional 1-4% holder reflection paid into an\n///         immutable basket of up to three reward assets (the pairing asset and/or tokenised stocks listed\n///         on the curve's reward-asset allowlist; never the coin itself), and graduation into the hooked\n///         Uniswap V4 pool.`],
  [`    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;\n    /// @notice Basket sentinel for "this launch's own token" (its address is not known before deployment).\n    address public constant LAUNCH_TOKEN = address(1);\n`, `    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;\n`],
  [`    error BadBasket();\n`, `    error BadBasket();\n    error AssetNotAllowed(address asset);\n`],
  [`    /// @param basket up to three reward assets (LAUNCH_TOKEN sentinel, the quote asset, or a routed asset);\n    ///        empty when reflectionBps is 0.`, `    /// @param basket up to three reward assets: the quote asset and/or stocks on the curve's allowlist;\n    ///        empty when reflectionBps is 0. The launch token itself is rejected.`],
  [`    /// @param paths per-asset Uniswap V3 route from the quote (empty for the quote, the launch token, or a direct hop).`, `    /// @param paths per-asset Uniswap V3 route from the quote (empty for the quote entry or a direct hop).`],
  [`        if (reflectionBps != 0) {\n            address[] memory resolved = new address[](basket.length);\n            for (uint256 i; i < basket.length; i++) resolved[i] = basket[i] == LAUNCH_TOKEN ? token : basket[i];\n            vault = _createVault(q, resolved, weights, paths, token, msg.sender);\n            t.setDividendVault(vault);\n        }`,
   `        if (reflectionBps != 0) {\n            for (uint256 i; i < basket.length; i++) {\n                if (basket[i] != q && !ICensusCurveV4(curve).allowedRewardAsset(basket[i])) revert AssetNotAllowed(basket[i]);\n            }\n            vault = _createVault(q, basket, weights, paths, token, msg.sender);\n            t.setDividendVault(vault);\n        }`],
  [`    function _createVault(address q, address[] memory resolved, uint16[] calldata weights, bytes[] calldata paths, address token, address creator) internal returns (address) {`,
   `    function _createVault(address q, address[] calldata basket, uint16[] calldata weights, bytes[] calldata paths, address token, address creator) internal returns (address) {`],
  [`        return IRewardVaultDeployer(vaultDeployer).create(q, router, stockSwapFee, resolved, weights, paths, allowanceHolder, token, curve, v4Router, ex, creator);`,
   `        return IRewardVaultDeployer(vaultDeployer).create(q, router, stockSwapFee, basket, weights, paths, allowanceHolder, token, curve, ex, creator);`],
]);
console.log('contracts edited');
