// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import "./OnlyProxy.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

interface MultiECDSAValidatorNew {
    function isOwner(
        address owner,
        address kernel
    ) external view returns (bool);

    function enable(bytes calldata _data) external payable;

    function disable(bytes calldata _data) external payable;
}

interface IAddressBook {
    function getOwners() external view returns (address[] memory);
}

contract KernelAccountOwnerUpdater2 is IAddressBook, OnlyProxy {
    address[] public owners;
    MultiECDSAValidatorNew immutable validator;

    constructor(
        address _validator
    ) OnlyProxy(address(this)) {
        validator = MultiECDSAValidatorNew(_validator);
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
        address[] calldata _ownersToAdd,
        address[] calldata _ownersToDisable
    ) external onlyProxy {
        KernelAccountOwnerUpdater2(__deploymentAddress).setOwners(_ownersToAdd);
        validator.enable(abi.encodePacked(__deploymentAddress));
        KernelAccountOwnerUpdater2(__deploymentAddress).setOwners(new address[](0));
        if (_ownersToDisable.length > 0) {
            validator.disable(abi.encode(_ownersToDisable));
        }
    }

    function needUpdating(
        address account,
        address[] calldata _ownersToAdd,
        address[] calldata _ownersToDisable
    ) external view notProxy returns (bool) {
        for (uint i = 0; i < _ownersToAdd.length; i++) {
            if (!validator.isOwner(_ownersToAdd[i], account)) {
                return true;
            }
        }
        for (uint i = 0; i < _ownersToDisable.length; i++) {
            if (validator.isOwner(_ownersToDisable[i], account)) {
                return true;
            }
        }
        return false;
    }
}
