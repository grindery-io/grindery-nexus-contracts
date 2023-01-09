//SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "hardhat/console.sol";

contract GRTUpgradeable is Initializable, ERC20Upgradeable, OwnableUpgradeable {

    function initialize() external initializer {
        __ERC20_init("GRTToken", "GRT");
        __Ownable_init();
    }

    function mint(address to, uint amount) external {
        _mint(to, amount);
    }

    function burn(address to, uint amount) external {
        _burn(to, amount);
    }
}