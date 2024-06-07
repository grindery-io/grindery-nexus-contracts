// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

abstract contract OnlyProxy {
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address internal immutable __deploymentAddress;
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address internal immutable __implementation = address(this);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address proxy) {
        __deploymentAddress = proxy;
    }

    error UnauthorizedCallContext();

    modifier onlyProxy() {
        if (
            address(this) == __deploymentAddress || address(this) == __implementation // Must be called through delegatecall
        ) {
            revert UnauthorizedCallContext();
        }
        _;
    }
    modifier notProxy() {
        if (
            address(this) != __deploymentAddress // Must NOT be called through delegatecall
        ) {
            revert UnauthorizedCallContext();
        }
        _;
    }
}
