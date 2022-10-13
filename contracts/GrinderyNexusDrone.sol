// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

// Uncomment this line to use console.log
// import "hardhat/console.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import "./GrinderyNexusHub.sol";

using ECDSA for bytes32;

contract GrinderyNexusDrone is Initializable {
    // Use immutable here to ensure no storage is allocated
    // This contract is supposed to be used with a beacon, in the rare case when address of the hub contract changes,
    // we upgrade this contract with the new address.
    address private immutable hubAddress;
    uint256 private nonce;

    event TransactionResult(
        bytes32 indexed signatureHash,
        bool success,
        bytes returnData
    );

    address private immutable __self = address(this);
    modifier onlyProxy() {
        require(
            address(this) != __self,
            "Function must be called through delegatecall"
        );
        _;
    }

    constructor(address _hubAddress) {
        hubAddress = _hubAddress;
    }

    function getNextNonce() onlyProxy public view returns (uint256) {
        return nonce;
    }

    function sendTransaction(
        address _target,
        uint256 _nonce,
        bytes memory _data,
        bytes memory _signature
    ) public onlyProxy returns (bool success, bytes memory returnData) {
        require(hubAddress != address(0x0), "hubAddress is invalid");
        require(_nonce == nonce, "nonce is invalid");
        require(
            GrinderyNexusHub(hubAddress).validateTransaction(
                _target,
                _nonce,
                _data,
                _signature
            ) == msg.sender,
            "signature is invalid"
        );
        nonce += 1;
        (success, returnData) = _target.call(_data);
        emit TransactionResult(keccak256(_signature), success, returnData);
        return (success, returnData);
    }
}
