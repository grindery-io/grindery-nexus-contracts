// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SignedMath.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import "@openzeppelin/contracts/utils/StorageSlot.sol";
import "./OnlyProxy.sol";
import "./FeeAccountantPrimary.sol";

interface IGasTank {
    function reportGasFee(
        bytes32 transaction,
        uint feeTokenAmount,
        bytes calldata signature
    ) external;

    function calcGasFee(uint gasBefore) external view returns (uint);
}

abstract contract BaseGasTank is
    IGasTank,
    ReentrancyGuard,
    OnlyProxy,
    OwnableUpgradeable,
    AccessControlUpgradeable
{
    bytes32 public constant ROLE_SIGNER = keccak256("ROLE_SIGNER");

    event FeeRateUpdated(uint feeNumerator, uint feeDenominator, uint baseGas);

    error InvalidSignature();
    error OutOfGas();

    uint feeNumerator;
    uint feeDenominator;
    uint baseGas;

    function initialize(
        uint _feeNumerator,
        uint _feeDenominator,
        uint _baseGas
    ) public virtual initializer {
        __Context_init();
        __Ownable_init(msg.sender);
        __AccessControl_init();
        feeNumerator = _feeNumerator;
        feeDenominator = _feeDenominator;
        baseGas = _baseGas;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function setFeeRate(
        uint _feeNumerator,
        uint _feeDenominator,
        uint _baseGas
    ) external notProxy onlyOwner {
        feeNumerator = _feeNumerator;
        feeDenominator = _feeDenominator;
        baseGas = _baseGas;
        emit FeeRateUpdated(_feeNumerator, _feeDenominator, _baseGas);
    }

    function getFeeRate()
        external
        view
        notProxy
        returns (uint _feeNumerator, uint _feeDenominator, uint _baseGas)
    {
        return (feeNumerator, feeDenominator, baseGas);
    }

    function calcGasFee(uint gasBefore) external view notProxy returns (uint) {
        uint nonce = getNonce(msg.sender);
        uint gasused = gasBefore - gasleft() + baseGas;
        if (nonce == 0) {
            gasused += 500000; // Wallet creation fee
        }
        uint txfee = tx.gasprice * gasused;
        uint feeTokenAmount = Math.mulDiv(txfee, feeNumerator, feeDenominator);
        return feeTokenAmount;
    }

    function _reportGasFee(
        bytes32 transaction,
        uint feeTokenAmount,
        uint nonce
    ) internal virtual;

    function reportGasFee(
        bytes32 transaction,
        uint feeTokenAmount,
        bytes calldata signature
    ) external notProxy {
        uint nonce = getNonce(msg.sender);
        if (
            transaction &
                0xffffffff_ffffffff_ffffffff_ffffffff_00000000_00000000_00000000_00000000 ==
            0
        ) {
            transaction = getSynthesizedTransactionId2(
                msg.sender,
                transaction,
                nonce
            );
        }
        address signer = ECDSA.recover(
            MessageHashUtils.toEthSignedMessageHash(
                getSigningHash(msg.sender, transaction)
            ),
            signature
        );
        if (!hasRole(ROLE_SIGNER, signer)) {
            revert InvalidSignature();
        }
        _reportGasFee(transaction, feeTokenAmount, nonce);
    }

    function getNonce(address wallet) public view virtual returns (uint);

    function getSigningHash(
        address wallet,
        bytes32 transaction
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    keccak256("GAS_TANK_SIGNING_HASH"),
                    wallet,
                    getNonce(wallet),
                    transaction
                )
            );
    }

    function getSynthesizedTransactionId1(
        address wallet,
        address target,
        bytes calldata data,
        uint256 value,
        bool delegateCall
    ) public pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(wallet, target, data, value, delegateCall)
            ) &
            0x00000000_00000000_00000000_00000000_ffffffff_ffffffff_ffffffff_ffffffff;
    }

    function getSynthesizedTransactionId2(
        address wallet,
        bytes32 id1,
        uint nonce
    ) public view returns (bytes32) {
        // This allows determining if transaction hash in event data is real
        return
            (keccak256(abi.encodePacked(id1, wallet, nonce, block.chainid)) &
                0xffffffff_ffffffff_ffffffff_ffffffff_00000000_00000000_00000000_00000000) |
            id1;
    }

    function getSynthesizedTransactionId(
        address wallet,
        address target,
        bytes calldata data,
        uint256 value,
        bool delegateCall
    ) public view notProxy returns (bytes32) {
        return
            getSynthesizedTransactionId2(
                wallet,
                getSynthesizedTransactionId1(
                    wallet,
                    target,
                    data,
                    value,
                    delegateCall
                ),
                getNonce(wallet)
            );
    }

    function getSigningHashFromCallData(
        address wallet,
        address target,
        bytes calldata data,
        uint256 value,
        bool delegateCall
    ) public view notProxy returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    keccak256("GAS_TANK_SIGNING_HASH"),
                    wallet,
                    getNonce(wallet),
                    getSynthesizedTransactionId(
                        wallet,
                        target,
                        data,
                        value,
                        delegateCall
                    )
                )
            );
    }

    function approvePayment(uint feeTokenAmount) internal virtual;

    function reportGasFeeAndApprovePayment(
        bytes32 transaction,
        uint feeTokenAmount,
        bytes calldata signature
    ) private onlyProxy {
        approvePayment(feeTokenAmount);
        deployment().reportGasFee(transaction, feeTokenAmount, signature);
    }

    // Returns deployed implementation
    function deployment() internal view returns (IGasTank) {
        return IGasTank(__deploymentAddress);
    }

    // Called by delegatecall
    function execute(
        address target,
        bytes calldata data,
        uint256 value,
        bool delegateCall,
        bytes calldata signature
    ) public onlyProxy returns (bytes memory) {
        uint gasBefore = gasleft();
        bytes32 transaction = getSynthesizedTransactionId1(
            address(this),
            target,
            data,
            value,
            delegateCall
        );
        bytes memory result = "";
        if (delegateCall) {
            result = Address.functionDelegateCall(target, data);
        } else if (data.length == 0) {
            Address.sendValue(payable(target), value);
        } else {
            result = Address.functionCallWithValue(target, data, value);
        }
        uint feeTokenAmount = deployment().calcGasFee(gasBefore);
        reportGasFeeAndApprovePayment(transaction, feeTokenAmount, signature);
        return result;
    }

    // Called by delegatecall
    function reportFailedTx(
        bytes32 transaction,
        uint gasUsed,
        bytes calldata signature
    ) public onlyProxy {
        uint gasBefore = gasleft();
        uint feeTokenAmount = deployment().calcGasFee(gasBefore + gasUsed * 2);
        reportGasFeeAndApprovePayment(transaction, feeTokenAmount, signature);
    }
}
