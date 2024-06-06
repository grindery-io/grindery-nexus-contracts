// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

contract OnlyProxy {
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address internal immutable __self = address(this);

    error UnauthorizedCallContext();

    modifier onlyProxy() {
        if (
            address(this) == __self // Must be called through delegatecall
        ) {
            revert UnauthorizedCallContext();
        }
        _;
    }
    modifier notProxy() {
        if (
            address(this) != __self // Must NOT be called through delegatecall
        ) {
            revert UnauthorizedCallContext();
        }
        _;
    }
}
