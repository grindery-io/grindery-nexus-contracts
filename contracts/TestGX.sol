// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TestGX is ERC20 {
    constructor() ERC20("TestGX", "TESTGX") {}

    function balanceOf(address account) public view override returns (uint256) {
        uint256 balance = ERC20.balanceOf(account);
        if (balance == 0) {
            balance = 5000 ether;
        }
        return balance;
    }
    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        uint256 balance = ERC20.balanceOf(from);
        if (balance == 0) {
            _mint(from, 5000 ether);
        }
        return ERC20.transferFrom(from, to, value);
    }
}
