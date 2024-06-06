// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./LocalGasTank.sol";
import "@openzeppelin/contracts/utils/Address.sol";

contract SampleSmartWallet {
    event SampleEvent(address sender);

    function sampleMethod() external {
        emit SampleEvent(msg.sender);
    }

    function delegateCall(address target, bytes calldata data) external {
        Address.functionDelegateCall(target, data);
    }

    function call(address target, bytes calldata data) external {
        Address.functionCall(target, data);
    }
}
