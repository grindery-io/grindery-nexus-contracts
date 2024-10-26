// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import "./OnlyProxy.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./kernel/validator/MultiECDSAValidatorNew.sol";

contract KernelAccountOwnerUpdater3 is IAddressBook, OnlyProxy {
    address[] public owners;

    constructor() OnlyProxy(address(this)) {
    }

    function setOwners(address[] calldata _owners) external notProxy {
        owners = _owners;
    }

    function getOwners()
        external
        view
        override
        notProxy
        returns (address[] memory)
    {
        return owners;
    }

    function updateOwners(
        MultiECDSAValidatorNew validator,
        address[] calldata _ownersToAdd,
        address[] calldata _ownersToDisable
    ) external onlyProxy {
        KernelAccountOwnerUpdater3(__deploymentAddress).setOwners(_ownersToAdd);
        validator.enable(abi.encodePacked(__deploymentAddress));
        KernelAccountOwnerUpdater3(__deploymentAddress).setOwners(
            new address[](0)
        );
        if (_ownersToDisable.length > 0) {
            validator.disable(abi.encode(_ownersToDisable));
        }
    }
}
