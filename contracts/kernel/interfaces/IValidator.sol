// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {UserOperation06} from "accountabstraction/contracts/legacy/v06/UserOperation06.sol";
import "contracts/kernel/common/Types.sol";

interface IKernelValidator {
    function enable(bytes calldata _data) external payable;

    function disable(bytes calldata _data) external payable;

    function validateUserOp(
        UserOperation06 calldata userOp,
        bytes32 userOpHash,
        uint256 missingFunds
    ) external payable returns (ValidationData);

    function validateSignature(
        bytes32 hash,
        bytes calldata signature
    ) external view returns (ValidationData);

    function validCaller(
        address caller,
        bytes calldata data
    ) external view returns (bool);
}

// 3 modes
// 1. default mode, use preset validator for the kernel
// 2. enable mode, enable a new validator for given action and use it for current userOp
// 3. sudo mode, use default plugin for current userOp
