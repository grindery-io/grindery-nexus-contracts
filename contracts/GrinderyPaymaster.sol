// SPDX-License-Identifier: MIT

pragma solidity ^0.8.30;

import "accountabstraction/contracts/legacy/v06/IEntryPoint06.sol";
import "accountabstraction/contracts/legacy/v06/IPaymaster06.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "accountabstraction/contracts/core/Helpers.sol";

/**
 * @dev A simple ERC4337 paymaster implementation. This base implementation only includes the minimal logic to validate
 * and pay for user operations.
 *
 * Developers must implement the {PaymasterCore-_validatePaymasterUserOp} function to define the paymaster's validation
 * and payment logic. The `context` parameter is used to pass data between the validation and execution phases.
 *
 * The paymaster includes support to call the {IEntryPointStake} interface to manage the paymaster's deposits and stakes
 * through the internal functions {deposit}, {withdraw}, {addStake}, {unlockStake} and {withdrawStake}.
 *
 * * Deposits are used to pay for user operations.
 * * Stakes are used to guarantee the paymaster's reputation and obtain more flexibility in accessing storage.
 *
 * NOTE: See [Paymaster's unstaked reputation rules](https://eips.ethereum.org/EIPS/eip-7562#unstaked-paymasters-reputation-rules)
 * for more details on the paymaster's storage access limitations.
 */
contract GrinderyPaymaster is IPaymaster06 {
    /// @dev Unauthorized call to the paymaster.
    error PaymasterUnauthorized(address sender);

    /// @notice The paymaster data length is invalid.
    error PaymasterAndDataLengthInvalid();

    /// @notice The paymaster data length is invalid for the selected mode.
    error PaymasterConfigLengthInvalid();

    /// @notice The paymaster signature length is invalid.
    error PaymasterSignatureLengthInvalid();

    /// @notice Error for bundler not allowed
    ///
    /// @param bundler address of the bundler that was not allowlisted
    error BundlerNotAllowed(address bundler);

    error WithdrawalUnauthorized(address sender);

    address private immutable _authorizedSigner;
    address private immutable _owner;

    /// @dev Revert if the caller is not the entry point.
    modifier onlyEntryPoint() {
        _checkEntryPoint();
        _;
    }

    modifier onlyWithdrawer() {
        _authorizeWithdraw();
        _;
    }

    constructor(address authorizedSigner) {
        _authorizedSigner = authorizedSigner;
        _owner = msg.sender;
    }

    /// @dev Canonical entry point for the account that forwards and validates user operations.
    function entryPoint() private pure returns (IEntryPoint) {
        return IEntryPoint(0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789);
    }

    /// @inheritdoc IPaymaster06
    function validatePaymasterUserOp(
        UserOperation06 calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    )
        public
        view
        onlyEntryPoint
        returns (bytes memory context, uint256 validationData)
    {
        return _validatePaymasterUserOp(userOp, userOpHash, maxCost);
    }

    function postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost
    ) external onlyEntryPoint {
        _postOp(mode, context, actualGasCost);
    }

    /**
     * @notice Parses the userOperation's paymasterAndData field and returns the paymaster mode and encoded paymaster
     * configuration bytes.
     * @dev _paymasterDataOffset should have value 20 for V6 and 52 for V7.
     * @param _paymasterAndData The paymasterAndData to parse.
     * @return paymasterConfig The paymaster config bytes.
     */
    function _parsePaymasterAndData(
        bytes calldata _paymasterAndData
    ) internal pure returns (bytes calldata) {
        uint256 _paymasterDataOffset = 20; // V6
        if (_paymasterAndData.length < _paymasterDataOffset) {
            revert PaymasterAndDataLengthInvalid();
        }

        bytes
            calldata paymasterConfig = _paymasterAndData[_paymasterDataOffset:];

        return paymasterConfig;
    }

    /**
     * @notice Parses the paymaster configuration when used in verifying mode.
     * @param _paymasterConfig The paymaster configuration in bytes.
     * @return validUntil The timestamp until which the sponsorship is valid.
     * @return validAfter The timestamp after which the sponsorship is valid.
     * @return signature The signature over the hashed sponsorship fields.
     * @dev The function reverts if the configuration length is invalid or if the signature length is not 64 or 65
     * bytes.
     */
    function _parseVerifyingConfig(
        bytes calldata _paymasterConfig
    ) internal pure returns (uint48, uint48, address, bytes calldata) {
        if (_paymasterConfig.length < 96) {
            revert PaymasterConfigLengthInvalid();
        }

        uint48 validUntil = uint48(bytes6(_paymasterConfig[0:6]));
        uint48 validAfter = uint48(bytes6(_paymasterConfig[6:12]));
        address authorizedBundler = address(bytes20(_paymasterConfig[12:32]));
        bytes calldata signature = _paymasterConfig[32:];

        if (signature.length != 64 && signature.length != 65) {
            revert PaymasterSignatureLengthInvalid();
        }

        return (validUntil, validAfter, authorizedBundler, signature);
    }

    /**
     * @dev Internal validation of whether the paymaster is willing to pay for the user operation.
     * Returns the context to be passed to postOp and the validation data.
     *
     * The `requiredPreFund` is the amount the paymaster has to pay (in native tokens). It's calculated
     * as `requiredGas * userOp.maxFeePerGas`, where `required` gas can be calculated from the user operation
     * as `verificationGasLimit + callGasLimit + paymasterVerificationGasLimit + paymasterPostOpGasLimit + preVerificationGas`
     */
    function _validatePaymasterUserOp(
        UserOperation06 calldata userOp,
        bytes32 /*userOpHash*/,
        uint256 /*requiredPreFund*/
    ) internal view returns (bytes memory context, uint256 validationData) {
        bytes calldata paymasterConfig = _parsePaymasterAndData(
            userOp.paymasterAndData
        );
        (
            uint48 validUntil,
            uint48 validAfter,
            address authorizedBundler,
            bytes calldata signature
        ) = _parseVerifyingConfig(paymasterConfig);
        if (authorizedBundler != address(0) && authorizedBundler != tx.origin) {
            revert BundlerNotAllowed(tx.origin);
        }
        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(
            abi.encode(
                validUntil,
                validAfter,
                authorizedBundler,
                userOp.sender,
                userOp.nonce,
                userOp.initCode,
                userOp.callData,
                userOp.callGasLimit,
                userOp.verificationGasLimit,
                userOp.preVerificationGas,
                userOp.maxFeePerGas,
                userOp.maxPriorityFeePerGas
            )
        );
        address recoveredSigner = ECDSA.recover(hash, signature);

        bool isSignatureValid = recoveredSigner == _authorizedSigner;
        validationData = _packValidationData(
            !isSignatureValid,
            validUntil,
            validAfter
        );

        return ("", validationData);
    }

    /**
     * @dev Handles post user operation execution logic. The caller must be the entry point.
     *
     * It receives the `context` returned by `_validatePaymasterUserOp`. Function is not called if no context
     * is returned by {validatePaymasterUserOp}.
     *
     * NOTE: The `actualUserOpFeePerGas` is not `tx.gasprice`. A user operation can be bundled with other transactions
     * making the gas price of the user operation to differ.
     */
    function _postOp(
        PostOpMode /* mode */,
        bytes calldata /* context */,
        uint256 /* actualGasCost */
    ) internal {}

    /// @dev Calls {IEntryPointStake-depositTo}.
    function deposit() public payable {
        entryPoint().depositTo{value: msg.value}(address(this));
    }

    /// @dev Calls {IEntryPointStake-withdrawTo}.
    function withdraw(address payable to, uint256 value) public onlyWithdrawer {
        entryPoint().withdrawTo(to, value);
    }

    /// @dev Calls {IEntryPointStake-addStake}.
    function addStake(uint32 unstakeDelaySec) public payable {
        entryPoint().addStake{value: msg.value}(unstakeDelaySec);
    }

    /// @dev Calls {IEntryPointStake-unlockStake}.
    function unlockStake() public onlyWithdrawer {
        entryPoint().unlockStake();
    }

    /// @dev Calls {IEntryPointStake-withdrawStake}.
    function withdrawStake(address payable to) public onlyWithdrawer {
        entryPoint().withdrawStake(to);
    }

    /// @dev Ensures the caller is the {entrypoint}.
    function _checkEntryPoint() internal view {
        address sender = msg.sender;
        if (sender != address(entryPoint())) {
            revert PaymasterUnauthorized(sender);
        }
    }

    /**
     * @dev Checks whether `msg.sender` withdraw funds stake or deposit from the entrypoint on paymaster's behalf.
     *
     * Use of an https://docs.openzeppelin.com/contracts/5.x/access-control[access control]
     * modifier such as {Ownable-onlyOwner} is recommended.
     *
     * ```solidity
     * function _authorizeUpgrade() internal onlyOwner {}
     * ```
     */
    function _authorizeWithdraw() internal view {
        if (msg.sender != _owner) {
            revert WithdrawalUnauthorized(msg.sender);
        }
    }
}
