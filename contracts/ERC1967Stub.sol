// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

// For deploying an ERC1967Proxy with no initialization code so that it can be used with deterministic deployment proxy

// DO NOT edit any code in this file, changing output of this contract will change final deployment address of the proxy

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract ERC1967Stub is UUPSUpgradeable {
    function _authorizeUpgrade(address) internal override onlyProxy {}
}
