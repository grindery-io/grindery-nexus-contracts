// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title MockERC1271Wallet
 * @dev A mock smart contract wallet that implements ERC-1271 signature validation
 * Used for testing smart contract wallet signature verification
 */
contract MockERC1271Wallet is IERC1271 {
    address public owner;

    // ERC-1271 magic value to return on successful signature verification
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;

    constructor(address _owner) {
        owner = _owner;
    }

    /**
     * @dev ERC-1271 signature validation function
     * @param hash Hash of the data signed
     * @param signature Signature byte array
     * @return magicValue Magic value if signature is valid, otherwise reverts or returns different value
     */
    function isValidSignature(
        bytes32 hash,
        bytes memory signature
    ) external view override returns (bytes4 magicValue) {
        // Recover the signer from the signature
        address recoveredSigner = ECDSA.recover(hash, signature);

        // Check if the recovered signer is the owner
        if (recoveredSigner == owner) {
            return MAGICVALUE;
        } else {
            return 0xffffffff;
        }
    }

    /**
     * @dev Execute a call from this wallet
     * @param target Target contract address
     * @param data Calldata to send
     */
    function executeCall(
        address target,
        bytes memory data
    ) external returns (bytes memory) {
        require(msg.sender == owner, "Only owner can execute calls");
        (bool success, bytes memory result) = target.call(data);
        require(success, "Call failed");
        return result;
    }

    /**
     * @dev Receive function to accept ETH
     */
    receive() external payable {}
}
