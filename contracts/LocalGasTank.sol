// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SignedMath.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "./BaseGasTank.sol";

contract LocalGasTank is BaseGasTank {
    bytes32 public constant ROLE_WITHDRAW = keccak256("ROLE_WITHDRAW");

    IERC20 gasToken;
    FeeAccountantPrimary feeAccountant;

    constructor(
        address _gasToken,
        uint _feeNumerator,
        uint _feeDenominator,
        uint _baseGas
    ) BaseGasTank(_feeNumerator, _feeDenominator, _baseGas) {
        gasToken = IERC20(_gasToken);
    }

    function setFeeAccountant(address _feeAccountant) external onlyOwner {
        feeAccountant = FeeAccountantPrimary(_feeAccountant);
    }

    // Returns deployed implementation
    function implementationChild() private view returns (LocalGasTank) {
        return LocalGasTank(address(implementation()));
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

    function getInternalVars()
        external
        view
        returns (IERC20, FeeAccountantPrimary)
    {
        return (gasToken, feeAccountant);
    }

    function getNonce(address wallet) public view override returns (uint) {
        (, uint nonce) = feeAccountant.getWalletRecord(wallet, block.chainid);
        return nonce;
    }

    function approvePayment(uint feeTokenAmount) internal override onlyProxy {
        address wallet = address(this);
        (
            IERC20 _gasToken,
            FeeAccountantPrimary _feeAccountant
        ) = implementationChild().getInternalVars();
        (int256 accBalance, ) = _feeAccountant.getWalletRecord(
            wallet,
            block.chainid
        );
        uint balance = _gasToken.balanceOf(wallet);
        uint targetAllowance = Math.min(
            balance,
            SafeCast.toUint256(
                SignedMath.max(
                    0,
                    SafeCast.toInt256(feeTokenAmount) + accBalance
                )
            )
        );
        if (
            targetAllowance > 0 &&
            _gasToken.allowance(wallet, address(_feeAccountant)) <
            targetAllowance
        ) {
            _gasToken.approve(address(_feeAccountant), targetAllowance);
        }
    }

    function withdraw(address to) external onlyRole(ROLE_WITHDRAW) {
        gasToken.transfer(
            to,
            gasToken.balanceOf(address(implementationChild()))
        );
    }
}
