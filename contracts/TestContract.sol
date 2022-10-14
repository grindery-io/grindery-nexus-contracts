// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

// import "hardhat/console.sol";

import "@openzeppelin/contracts-upgradeable/proxy/ClonesUpgradeable.sol";

contract TestContract {
    uint256 lastValue;

    event Echo(address sender, uint256 lastValue, uint256 num);

    function echo(uint256 num) public returns (uint256) {
        emit Echo(msg.sender, lastValue, num);
        lastValue = num;
        return num;
    }

    function testRevert(uint256 num) public {
        lastValue = num;
        revert("testRevert");
    }

    function testDrainAllGas(uint256 input) public returns (uint256) {
        lastValue = input;
        return testDrainAllGas(input + 1);
    }

    function testLongReturnValue(uint256 n) public returns (bytes memory) {
        lastValue = n;
        if (n == 0) {
            return abi.encodePacked(keccak256(abi.encodePacked(n)));
        }
        return
            abi.encodePacked(
                keccak256(abi.encodePacked(n)),
                testLongReturnValue(n - 1),
                testLongReturnValue(n - 1)
            );
    }
}
