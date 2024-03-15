// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./Escrow.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract EscrowFactory {
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
        Escrow escrow = Escrow(Clones.cloneDeterministic(_escrowImpl, salt));
        escrow.initialize(
            tokenAddress,
            sender,
            beneficiary,
            admin,
            holdDeadline
        );
        return escrow;
    }

    function getEscrowAddress(bytes32 salt) public view returns (address) {
        return Clones.predictDeterministicAddress(_escrowImpl, salt);
    }

    function createEscrowByDelegateCall(
        address tokenAddress,
        uint256 amount,
        address beneficiary,
        address admin,
        uint256 holdDeadline
    ) external returns (Escrow) {
        address sender = address(this);
        bytes32 salt = keccak256(
            abi.encode(
                block.timestamp,
                blockhash(block.number - 1),
                block.prevrandao,
                block.coinbase,
                tokenAddress,
                amount,
                sender,
                beneficiary,
                admin,
                holdDeadline
            )
        );
        address escrowAddress = getEscrowAddress(salt);
        IERC20(tokenAddress).approve(escrowAddress, amount);
        return
            createEscrow(
                salt,
                tokenAddress,
                sender,
                beneficiary,
                admin,
                holdDeadline
            );
    }
}
