// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
// Audit-only adversarial quote asset. Never deploy as a supported production asset.
contract AuditQuote is ERC20 {
    uint256 public taxBps;
    address public blocked;
    constructor() ERC20("Audit quote", "AQ") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setTax(uint256 bps) external { taxBps = bps; }
    function setBlocked(address to) external { blocked = to; }
    function _update(address from, address to, uint256 value) internal override {
        require(to != blocked || to == address(0), "blocked recipient");
        uint256 tax = from != address(0) && to != address(0) ? value * taxBps / 10000 : 0;
        if (tax > 0) super._update(from, address(0), tax);
        super._update(from, to, value - tax);
    }
}
