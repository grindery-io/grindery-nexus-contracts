// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./Escrow.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./OnlyProxy.sol";

contract EscrowFactory is OnlyProxy {
    address private immutable _escrowImpl;

    constructor(address escrowImpl) {
        _escrowImpl = escrowImpl;
    }

    function createEscrow(
        bytes32 salt,
        address tokenAddress,
        address sender,
        address beneficiary,
        address admin,
        uint256 holdDeadline
    ) public returns (Escrow) {
        Escrow escrow = Escrow(
            Clones.cloneDeterministic(
                _escrowImpl,
                getFinalSalt(salt, sender, beneficiary)
            )
        );
        escrow.initialize(
            tokenAddress,
            sender,
            beneficiary,
            admin,
            holdDeadline
        );
        return escrow;
    }

    function getFinalSalt(
        bytes32 salt,
        address sender,
        address beneficiary
    ) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(salt, sender, beneficiary));
    }

    function getEscrowAddress(
        bytes32 salt,
        address sender,
        address beneficiary
    ) public view returns (address) {
        return
            Clones.predictDeterministicAddress(
                _escrowImpl,
                getFinalSalt(salt, sender, beneficiary),
                __self
            );
    }

    function createEscrowByDelegateCall(
        bytes32 salt,
        address tokenAddress,
        uint256 amount,
        address beneficiary,
        address admin,
        uint256 holdDeadline
    ) external onlyProxy returns (Escrow) {
        address sender = address(this);
        address escrowAddress = getEscrowAddress(salt, sender, beneficiary);
        IERC20(tokenAddress).approve(escrowAddress, amount);
        return
            EscrowFactory(__self).createEscrow(
                salt,
                tokenAddress,
                sender,
                beneficiary,
                admin,
                holdDeadline
            );
    }
}
