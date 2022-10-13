// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "hardhat/console.sol";

contract TestContract {
    uint256 lastValue;

    event Echo(address sender, uint256 lastValue, uint256 num);

    function echo(uint256 num) public returns (uint256) {
        console.log("echo called from %s: %s, %s", msg.sender, lastValue, num);
        emit Echo(msg.sender, lastValue, num);
        lastValue = num;
        return num;
    }

    function raiseError(uint256 num) public {
        console.log(
            "raiseError called from %s: %s, %s",
            msg.sender,
            lastValue,
            num
        );
        lastValue = num;
        revert("raiseError");
    }
}
