// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
interface IWindowCurve {
    function buyWithETH(address coin, uint256 minimum) external payable returns (uint256);
    function sellForETH(address coin, uint256 amount, uint256 minimum) external returns (uint256);
}
// Local test helper: a buyer distinct from the creator, both acting in the launch transaction.
contract WindowBuyer {
    function buy(address curve, address coin) external payable { IWindowCurve(curve).buyWithETH{value:msg.value}(coin,0); }
    function sell(address curve, address coin) external {
        uint256 amount=IERC20(coin).balanceOf(address(this));
        IERC20(coin).approve(curve,amount); IWindowCurve(curve).sellForETH(coin,amount,0);
    }
    receive() external payable {}
}
contract LaunchWindowHarness {
    WindowBuyer public immutable buyer = new WindowBuyer();
    function launchAndBuy(address factory, bytes calldata data, address curve) external payable {
        (bool ok, bytes memory result)=factory.call(data); require(ok);
        address coin=abi.decode(result,(address));
        buyer.buy{value:msg.value}(curve,coin);
    }
    function sell(address curve,address coin) external { buyer.sell(curve,coin); }
}
