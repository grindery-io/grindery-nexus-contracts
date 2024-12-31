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

struct Call3Value {
    address target;
    bool allowFailure;
    uint256 value;
    bytes callData;
}

struct Result {
    bool success;
    bytes returnData;
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

    error Aggregate3ValueNotEnoughBalance(uint256 value, uint256 balance);
    error Aggregate3ValueValueMismatch(
        uint256 expectedValue,
        uint256 actualValue
    );

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

    /// @notice Aggregate calls with a msg value (modified from Multicall3)
    /// @notice Does not check sum of call value
    /// @param calls An array of Call3Value structs
    /// @return returnData An array of Result structs
    function aggregate3Value(
        Call3Value[] calldata calls
    ) public payable returns (Result[] memory returnData) {
        uint256 length = calls.length;
        returnData = new Result[](length);
        Call3Value calldata calli;
        for (uint256 i = 0; i < length; ) {
            Result memory result = returnData[i];
            calli = calls[i];
            uint256 val = calli.value;
            (result.success, result.returnData) = calli.target.call{value: val}(
                calli.callData
            );
            assembly {
                // Revert if the call fails and failure is not allowed
                // `allowFailure := calldataload(add(calli, 0x20))` and `success := mload(result)`
                if iszero(or(calldataload(add(calli, 0x20)), mload(result))) {
                    // set "Error(string)" signature: bytes32(bytes4(keccak256("Error(string)")))
                    mstore(
                        0x00,
                        0x08c379a000000000000000000000000000000000000000000000000000000000
                    )
                    // set data offset
                    mstore(
                        0x04,
                        0x0000000000000000000000000000000000000000000000000000000000000020
                    )
                    // set length of revert string
                    mstore(
                        0x24,
                        0x0000000000000000000000000000000000000000000000000000000000000017
                    )
                    // set revert string: bytes32(abi.encodePacked("Multicall3: call failed"))
                    mstore(
                        0x44,
                        0x4d756c746963616c6c333a2063616c6c206661696c6564000000000000000000
                    )
                    revert(0x00, 0x84)
                }
            }
            unchecked {
                ++i;
            }
        }
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
        if (
            target == 0xcA11bde05977b3631167028862bE2a173976CA11 && delegateCall
        ) {
            bytes4 sig = data[0] |
                (bytes4(data[1]) >> 8) |
                (bytes4(data[2]) >> 16) |
                (bytes4(data[3]) >> 24);

            // Selector of aggregate3Value
            if (sig == 0x174dea71) {
                // Use modified implementation, the original one fails with value mismatch error
                uint256 oldBalance = address(this).balance;
                if (value > oldBalance) {
                    revert Aggregate3ValueNotEnoughBalance(value, oldBalance);
                }
                result = Address.functionDelegateCall(
                    __deploymentAddress,
                    data
                );
                // New balance can be bigger as the wallet may receive token from the call
                uint256 newBalance = address(this).balance;
                if (newBalance < oldBalance - value) {
                    uint256 actualValue = oldBalance - newBalance;
                    revert Aggregate3ValueValueMismatch(value, actualValue);
                }
            }
        } else {
            if (delegateCall) {
                result = Address.functionDelegateCall(target, data);
            } else if (data.length == 0) {
                Address.sendValue(payable(target), value);
            } else {
                result = Address.functionCallWithValue(target, data, value);
            }
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
