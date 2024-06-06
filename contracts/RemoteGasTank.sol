// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SignedMath.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "./BaseGasTank.sol";

contract RemoteGasTank is BaseGasTank {
    mapping(address => uint) nonces;

    event ReportGasFee(
        bytes32 indexed transaction,
        address indexed wallet,
        uint indexed nonce,
        uint256 fee
    );

    constructor(
        uint _feeNumerator,
        uint _feeDenominator,
        uint _baseGas
    ) BaseGasTank(_feeNumerator, _feeDenominator, _baseGas) {}

    function _reportGasFee(
        bytes32 transaction,
        uint feeTokenAmount
    ) internal override notProxy {
        emit ReportGasFee(
            transaction,
            msg.sender,
            nonces[msg.sender],
            feeTokenAmount
        );
        nonces[msg.sender]++;
    }

    function getNonce(address wallet) public view override returns (uint) {
        return nonces[wallet];
    }

    function approvePayment(uint feeTokenAmount) internal override onlyProxy {}
}
