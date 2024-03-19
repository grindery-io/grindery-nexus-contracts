// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

contract OnlyProxy {
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address internal immutable __self = address(this);

    error UnauthorizedCallContext();

    /**
     * @dev Check that the execution is being performed through a delegatecall call and that the execution context is
     * a proxy contract with an implementation (as defined in ERC1967) pointing to self. This should only be the case
     * for UUPS and transparent proxies that are using the current contract as their implementation. Execution of a
     * function through ERC1167 minimal proxies (clones) would not normally pass this test, but is not guaranteed to
     * fail.
     */
    modifier onlyProxy() {
        if (
            address(this) == __self // Must be called through delegatecall
        ) {
            revert UnauthorizedCallContext();
        }
        _;
    }
}
