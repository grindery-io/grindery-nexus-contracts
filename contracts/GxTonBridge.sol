// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./OnlyProxy.sol";

contract GxTonBridge is ReentrancyGuard, Ownable, AccessControl, OnlyProxy {
    event BridgeToTon(
        address indexed sender,
        uint256 amount,
        int32 indexed tonWorkchainId,
        bytes32 indexed tonAccountId
    );
    event BridgeFromTon(
        bytes32 indexed transactionHash,
        int32 tonWorkchainId,
        bytes32 indexed tonAccountId,
        uint256 amount,
        address indexed destination,
        uint256 nonce
    );

    error TransactionAlreadyClaimed(bytes32 transactionHash);
    error InvalidSender();
    error InvalidSignature();
    error InvalidNonce(uint nonce, uint expectedNonce);

    bytes32 public constant ROLE_OPERATOR = keccak256("ROLE_OPERATOR");

    IERC20 private immutable gxToken;

    mapping(bytes32 => bool) private claimedTransactions;
    uint256 public nextNonce;

    constructor(address _gxToken, address operator) Ownable(msg.sender) OnlyProxy(address(this)) {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        gxToken = IERC20(_gxToken);
        if (operator != address(0)) {
            _grantRole(ROLE_OPERATOR, operator);
        }
    }

    function bridgeToTon(
        uint256 amount,
        int32 tonWorkchainId,
        bytes32 tonAccountId
    ) external {
        if (msg.sender == address(this)) {
            revert InvalidSender();
        }
        SafeERC20.safeTransferFrom(gxToken, msg.sender, address(this), amount);
        emit BridgeToTon(msg.sender, amount, tonWorkchainId, tonAccountId);
    }

    function onBridgeFromTon(
        bytes32 transactionHash,
        int32 tonWorkchainId,
        bytes32 tonAccountId,
        uint256 amount,
        address destination,
        uint256 nonce,
        bytes memory signature
    ) external {
        if (claimedTransactions[transactionHash]) {
            revert TransactionAlreadyClaimed(transactionHash);
        }
        claimedTransactions[transactionHash] = true;
        if (nonce != nextNonce) {
            revert InvalidNonce(nonce, nextNonce);
        }
        nextNonce += 1;
        address signer = ECDSA.recover(
            MessageHashUtils.toEthSignedMessageHash(
                keccak256(
                    abi.encodePacked(
                        keccak256("GX_TON_BRIDGE_IN"),
                        transactionHash,
                        tonWorkchainId,
                        tonAccountId,
                        amount,
                        destination,
                        nonce
                    )
                )
            ),
            signature
        );
        if (!hasRole(ROLE_OPERATOR, signer)) {
            revert InvalidSignature();
        }
        SafeERC20.safeTransfer(gxToken, destination, amount);
        emit BridgeFromTon(
            transactionHash,
            tonWorkchainId,
            tonAccountId,
            amount,
            destination,
            nonce
        );
    }
}
