// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

// Uncomment this line to use console.log
// import "hardhat/console.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/ClonesUpgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import "./GrinderyNexusDrone.sol";

using ECDSA for bytes32;

contract GrinderyNexusHub is
    Initializable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable
{
    bytes32 private constant SALT_GRINDERY_WALLET =
        keccak256("grindery.wallet");
    bytes32 private constant SALT_GRINDERY_TRANSACTION =
        keccak256("grindery.transaction");

    address private operator;
    address private droneImplementation;

    modifier onlyOperator() {
        require(operator == _msgSender(), "Caller is not the operator");
        _;
    }

    event OperatorChanged(
        address indexed oldOperator,
        address indexed newOperator
    );
    event DroneImplementationChanged(
        address indexed oldDroneImplementation,
        address indexed newDroneImplementation
    );
    event DeployedDrone(address indexed droneAddress);

    constructor(address owner) {
        initialize(owner);
    }

    function initialize(address owner) public initializer {
        __Ownable2Step_init();
        OwnableUpgradeable.transferOwnership(owner);
    }

    function _authorizeUpgrade(address) internal override onlyOwner onlyProxy {}

    function setOperator(address newOperator) public onlyOwner onlyProxy {
        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
    }

    function setDroneImplementation(address newDroneImplementation)
        public
        onlyOwner
        onlyProxy
    {
        emit DroneImplementationChanged(
            droneImplementation,
            newDroneImplementation
        );
        droneImplementation = newDroneImplementation;
    }

    function getUserDroneSalt(address user) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(user, SALT_GRINDERY_WALLET));
    }

    function getUserDroneAddress(address user)
        public
        view
        onlyProxy
        returns (address droneAddress)
    {
        require(
            droneImplementation != address(0x0),
            "Drone implementation address is not set"
        );
        return
            ClonesUpgradeable.predictDeterministicAddress(
                droneImplementation,
                getUserDroneSalt(user)
            );
    }

    function deployDrone(address user)
        public
        onlyOperator
        onlyProxy
        returns (address droneAddress)
    {
        require(
            droneImplementation != address(0x0),
            "Drone implementation address is not set"
        );
        droneAddress = ClonesUpgradeable.cloneDeterministic(
            droneImplementation,
            getUserDroneSalt(user)
        );
        emit DeployedDrone(droneAddress);
        return droneAddress;
    }

    function deployDroneAndSendTransaction(
        address user,
        address target,
        bytes memory data,
        bytes memory signature
    )
        public
        onlyOperator
        onlyProxy
        returns (bool success, bytes memory returnData)
    {
        address drone = deployDrone(user);
        (success, returnData) = GrinderyNexusDrone(drone).sendTransaction(
            target,
            0,
            data,
            signature
        );
        return (success, returnData);
    }

    function validateTransaction(
        address target,
        uint256 nonce,
        bytes memory data,
        bytes memory signature
    ) external view onlyProxy returns (address signer) {
        require(operator != address(0x0), "Operator address is not set");
        address sender = _msgSender();
        bytes32 hash = getTransactionHash(sender, target, nonce, data);
        signer = hash.toEthSignedMessageHash().recover(signature);
        require(signer == operator, "Invalid transaction signature");
        return signer;
    }

    function getTransactionHash(
        address drone,
        address target,
        uint256 nonce,
        bytes memory data
    ) public view onlyProxy returns (bytes32 hash) {
        return
            keccak256(
                abi.encodePacked(
                    block.chainid,
                    drone,
                    target,
                    nonce,
                    data,
                    SALT_GRINDERY_TRANSACTION
                )
            );
    }
}
