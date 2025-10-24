// SPDX-License-Identifier: CC0-1.0

pragma solidity ^0.8.25;

// Copied from https://github.com/AmbireTech/signature-validator/blob/main/contracts/EIP6492Full.sol

// As per ERC-1271
interface IERC1271Wallet {
    function isValidSignature(
        bytes32 hash,
        bytes calldata signature
    ) external view returns (bytes4 magicValue);
}

error ERC1271Revert(bytes error);
error ERC6492CallFailed(bytes error);
error ERC6492DeploySilentlyFailed();

contract UniversalSigValidator {
    bytes32 private constant ERC6492_DETECTION_SUFFIX =
        0x6492649264926492649264926492649264926492649264926492649264926492;
    bytes4 private constant ERC1271_SUCCESS = 0x1626ba7e;

    function isCounterfactualSignature(
        bytes calldata _signature
    ) public pure returns (bool isCounterfactual) {
        isCounterfactual =
            _signature.length >= 32 &&
            bytes32(_signature[_signature.length - 32:_signature.length]) ==
            ERC6492_DETECTION_SUFFIX;
    }

    function prepareCounterfactualSignature(
        address _signer,
        bytes calldata _signature,
        bool makingACall
    )
        public
        returns (
            bytes memory callErr,
            bool callSuccess,
            bytes memory sigToValidate
        )
    {
        address create2Factory;
        bytes memory factoryCalldata;
        (create2Factory, factoryCalldata, sigToValidate) = abi.decode(
            _signature[0:_signature.length - 32],
            (address, bytes, bytes)
        );

        if (makingACall) {
            (callSuccess, callErr) = create2Factory.call(factoryCalldata);
        }

        if (_signer.code.length == 0) {
            if (!callSuccess) revert ERC6492CallFailed(callErr);
            else revert ERC6492DeploySilentlyFailed();
        }
    }

    uint256 private constant FLAG_ALLOW_SIDE_EFFECTS = 1 << 0;
    uint256 private constant FLAG_TRY_PREPARE = 1 << 1;
    uint256 private constant FLAG_IS_COUNTERFACTUAL = 1 << 2;
    uint256 private constant FLAG_SHOULD_TRY_PREPARE_NEXT = 1 << 3;
    uint256 private constant FLAG_MAKING_A_CALL = 1 << 4;

    function isValidSigImpl(
        address _signer,
        bytes32 _hash,
        bytes calldata _signature,
        uint256 flags
    ) public returns (bool) {
        {
            uint contractCodeLen = _signer.code.length;
            bytes memory sigToValidate;
            // The order here is strictly defined in https://eips.ethereum.org/EIPS/eip-6492
            // - ERC-6492 suffix check and verification first, while being permissive in case the contract is already deployed; if the contract is deployed we will check the sig against the deployed version, this allows 6492 signatures to still be validated while taking into account potential key rotation
            // - ERC-1271 verification if there's contract code
            // - finally, ecrecover
            if (isCounterfactualSignature(_signature)) {
                flags |= FLAG_IS_COUNTERFACTUAL;
            }
            if (
                (flags & FLAG_IS_COUNTERFACTUAL) > 0 &&
                (flags & FLAG_TRY_PREPARE) == 0 &&
                contractCodeLen > 0
            ) {
                flags |= FLAG_SHOULD_TRY_PREPARE_NEXT;
            }
            if (
                (flags & FLAG_IS_COUNTERFACTUAL) > 0 &&
                (contractCodeLen == 0 || (flags & FLAG_TRY_PREPARE) > 0)
            ) {
                flags |= FLAG_MAKING_A_CALL;
            }

            // Store these for error reporting later
            bytes memory callErr;
            bool callSuccess;

            if ((flags & FLAG_TRY_PREPARE) > 0) {
                require(
                    (flags & FLAG_IS_COUNTERFACTUAL) > 0,
                    "SignatureValidator: tryPrepare should be used with counterfactual wrapped sigs"
                );
            }
            if ((flags & FLAG_IS_COUNTERFACTUAL) > 0) {
                (
                    callErr,
                    callSuccess,
                    sigToValidate
                ) = prepareCounterfactualSignature(
                    _signer,
                    _signature,
                    (flags & FLAG_MAKING_A_CALL) > 0
                );
            } else {
                sigToValidate = _signature;
            }

            // Try ERC-1271 verification
            if ((flags & FLAG_IS_COUNTERFACTUAL) > 0 || contractCodeLen > 0) {
                try
                    IERC1271Wallet(_signer).isValidSignature(
                        _hash,
                        sigToValidate
                    )
                returns (bytes4 magicValue) {
                    bool isValid = magicValue == ERC1271_SUCCESS;

                    if (!isValid) {
                        // retry, but this time assume the prefix is a prepare call
                        if ((flags & FLAG_SHOULD_TRY_PREPARE_NEXT) > 0) {
                            return
                                isValidSigImpl(
                                    _signer,
                                    _hash,
                                    _signature,
                                    (flags & FLAG_ALLOW_SIDE_EFFECTS) |
                                        FLAG_TRY_PREPARE
                                );
                        }
                        // we already tried prepare but we have an actual callErr while doing it
                        if ((flags & FLAG_TRY_PREPARE) > 0 && !callSuccess)
                            revert ERC6492CallFailed(callErr);
                    }

                    // only reverting in case a call was made and we DONT want side effects
                    if (
                        (flags & FLAG_MAKING_A_CALL) > 0 &&
                        (flags & FLAG_ALLOW_SIDE_EFFECTS) == 0
                    ) {
                        // if the call had side effects we need to return the
                        // result using a `revert` (to undo the state changes)
                        assembly {
                            mstore(0, isValid)
                            revert(31, 1)
                        }
                    }

                    return isValid;
                } catch (bytes memory err) {
                    // retry, but this time assume the prefix is a prepare call
                    if ((flags & FLAG_SHOULD_TRY_PREPARE_NEXT) > 0) {
                        return
                            isValidSigImpl(
                                _signer,
                                _hash,
                                _signature,
                                (flags & FLAG_ALLOW_SIDE_EFFECTS) |
                                    FLAG_TRY_PREPARE
                            );
                    }
                    if ((flags & FLAG_TRY_PREPARE) > 0 && !callSuccess)
                        revert ERC6492CallFailed(callErr);
                    revert ERC1271Revert(err);
                }
            }
        }
        {
            // ecrecover verification
            require(
                _signature.length == 65,
                "SignatureValidator#recoverSigner: invalid signature length"
            );
            bytes32 r = bytes32(_signature[0:32]);
            bytes32 s = bytes32(_signature[32:64]);
            uint8 v = uint8(_signature[64]);
            if (v != 27 && v != 28) {
                revert("SignatureValidator: invalid signature v value");
            }
            return ecrecover(_hash, v, r, s) == _signer;
        }
    }

    function isValidSig(
        address _signer,
        bytes32 _hash,
        bytes calldata _signature
    ) public returns (bool) {
        try
            this.isValidSigImpl(_signer, _hash, _signature, 0)
        returns (bool isValid) {
            return isValid;
        } catch (bytes memory error) {
            // in order to avoid side effects from the contract getting deployed, the entire call will revert with a single byte result
            uint len = error.length;
            if (len == 1) return error[0] == 0x01;
            // all other errors are simply forwarded, but in custom formats so that nothing else can revert with a single byte in the call
            else
                assembly {
                    revert(add(error, 0x20), len)
                }
        }
    }
}
