// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SignedMath.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "./BaseGasTank.sol";
import "./FeeAccountantPrimary.sol";

contract LocalGasTank is BaseGasTank {
    bytes32 public constant ROLE_WITHDRAW = keccak256("ROLE_WITHDRAW");

    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IERC20 private immutable gasToken;
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    FeeAccountantPrimary private immutable feeAccountant;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(
        address _deploymentAddress,
        address _gasToken,
        address _feeAccountant
    ) OnlyProxy(_deploymentAddress) {
        gasToken = IERC20(_gasToken);
        feeAccountant = FeeAccountantPrimary(_feeAccountant);
    }

    function getGasToken() public view returns (address) {
        return address(gasToken);
    }

    function getFeeAccountant() public view returns (address) {
        return address(feeAccountant);
    }

    function _reportGasFee(
        bytes32 transaction,
        uint feeTokenAmount
    ) internal override notProxy {
        (, uint256 nonce) = feeAccountant.getWalletRecord(
            msg.sender,
            block.chainid
        );
        FeeRecord[] memory records = new FeeRecord[](1);
        records[0] = FeeRecord(
            transaction,
            msg.sender,
            block.chainid,
            feeTokenAmount,
            nonce
        );
        feeAccountant.commitFees(records);
    }

    function getNonce(address wallet) public view override returns (uint) {
        (, uint nonce) = feeAccountant.getWalletRecord(wallet, block.chainid);
        return nonce;
    }

    function approvePayment(uint feeTokenAmount) internal override onlyProxy {
        address wallet = address(this);
        (int256 accBalance, ) = feeAccountant.getWalletRecord(
            wallet,
            block.chainid
        );
        uint balance = gasToken.balanceOf(wallet);
        uint payAmount = Math.min(
            balance,
            SafeCast.toUint256(
                SignedMath.max(
                    0,
                    SafeCast.toInt256(feeTokenAmount) + accBalance
                )
            )
        );
        if (payAmount > 0) {
            Address.functionDelegateCall(
                address(feeAccountant),
                abi.encodeWithSelector(
                    FeeAccountantPrimary.approveAndPayFee.selector,
                    payAmount,
                    0
                )
            );
        }
    }

    function withdraw(address to) external notProxy onlyRole(ROLE_WITHDRAW) {
        gasToken.transfer(to, gasToken.balanceOf(address(this)));
    }
}
