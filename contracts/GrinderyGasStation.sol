//SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "hardhat/console.sol";


contract GrinderyGasStation is Ownable {

    receive() external payable {}

    function transfer(address _addrToken, uint256 _amount) external payable returns (bool) {
        if (_addrToken == address(0)) {
            return sendNative(payable(msg.sender), _amount);
        }
        return transferToken(_addrToken, msg.sender, _amount);
    }

    function getContractBalanceToken(address _addrToken) external view returns (uint256) {
        return IERC20(_addrToken).balanceOf(address(this));
    }

    function transferToken(address _addrToken, address _to, uint256 _amount) internal returns (bool) {
        return IERC20(_addrToken).transfer(_to, _amount);
    }

    function getBalance() public view returns (uint256) {
        return address(this).balance;
    }

    function sendNative(address payable _to, uint256 _amount) internal returns (bool) {
        require(getBalance() > _amount, "GasStation: Transfer amount exceeds balance");
        (bool sent, ) = _to.call{value: _amount}("");
        require(sent, "GasStation: Failed to send Ether");
        return sent;
    }

}