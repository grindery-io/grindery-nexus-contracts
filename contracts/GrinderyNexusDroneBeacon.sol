// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

contract GrinderyNexusDroneBeacon is UpgradeableBeacon {
    constructor(address implementation_, address owner)
        UpgradeableBeacon(implementation_)
    {
        _transferOwnership(owner);
    }
}
