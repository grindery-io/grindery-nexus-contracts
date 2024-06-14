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

contract KernelAccountOwnerUpdater is
    IAddressBook,
    OnlyProxy,
    OwnableUpgradeable
{
    address[] public owners;
    address[] public ownersToDisable;
    MultiECDSAValidatorNew immutable validator;

    constructor(
        address deploymentAddress,
        address _validator
    ) OnlyProxy(deploymentAddress) {
        validator = MultiECDSAValidatorNew(_validator);
    }

    function initialize(
        address[] calldata _owners,
        address[] calldata _ownersToDisable
    ) public initializer {
        __Context_init();
        __Ownable_init(msg.sender);
        setOwners(_owners, _ownersToDisable);
    }

    function setOwners(
        address[] calldata _owners,
        address[] calldata _ownersToDisable
    ) public onlyOwner {
        owners = _owners;
        ownersToDisable = _ownersToDisable;
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

    function getOwnersToDisable()
        external
        view
        notProxy
        returns (address[] memory)
    {
        return ownersToDisable;
    }

    function updateOwners() external onlyProxy {
        validator.enable(abi.encodePacked(__deploymentAddress));
        address[] memory _ownersToDisable = KernelAccountOwnerUpdater(
            __deploymentAddress
        ).getOwnersToDisable();
        if (_ownersToDisable.length > 0) {
            validator.disable(abi.encode(_ownersToDisable));
        }
    }

    function needUpdating(
        address account
    ) external view notProxy returns (bool) {
        for (uint i = 0; i < owners.length; i++) {
            if (!validator.isOwner(owners[i], account)) {
                return true;
            }
        }
        for (uint i = 0; i < ownersToDisable.length; i++) {
            if (validator.isOwner(ownersToDisable[i], account)) {
                return true;
            }
        }
        return false;
    }
}
