// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "contracts/kernel/factory/KernelFactory.sol";
import "contracts/kernel/interfaces/IAddressBook.sol";
import "contracts/kernel/abstract/KernelStorage.sol";
import "contracts/kernel/interfaces/IValidator.sol";

contract MultiECDSAFactoryGrindery is KernelFactory, IAddressBook {
    address[] owners;

    address public kernel;
    IKernelValidator public immutable multiECDSAValidatorNew;

    constructor(
        address _owner,
        IEntryPoint _entryPoint,
        address _kernel,
        IKernelValidator _multiECDSAValidatorNew
    ) KernelFactory(_owner, _entryPoint) {
        KernelFactory._setImplementation(_kernel, true);
        kernel = _kernel;
        multiECDSAValidatorNew = _multiECDSAValidatorNew;
    }

    function getOwners() external view override returns (address[] memory) {
        return owners;
    }

    function setOwners(address[] memory _owners) external onlyOwner {
        owners = _owners;
    }

    function setKernel(address _kernel) external onlyOwner {
        KernelFactory._setImplementation(kernel, false);
        kernel = _kernel;
        KernelFactory._setImplementation(_kernel, true);
    }

    function createAccount(
        uint256 _index
    ) external payable returns (address proxy) {
        bytes memory data = abi.encodeWithSelector(
            KernelStorage.initialize.selector,
            multiECDSAValidatorNew,
            abi.encodePacked(address(this))
        );
        proxy = this.createAccount(kernel, data, _index);
    }

    function getAccountAddress(uint256 _index) public view returns (address) {
        bytes memory _data = abi.encodeWithSelector(
            KernelStorage.initialize.selector,
            multiECDSAValidatorNew,
            abi.encodePacked(address(this))
        );
        return this.getAccountAddress(_data, _index);
    }
}
