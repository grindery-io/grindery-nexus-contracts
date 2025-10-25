// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../ZeroLC.sol";

/**
 * @title SettlementCaller
 * @dev Helper contract to test ChargesSettledFromContract event emission
 *      when settleCharges is called from a contract (tx.origin != msg.sender)
 */
contract SettlementCaller {
    function settleChargesViaContract(
        ZeroLC zeroLC,
        ChargeBatch[] calldata chargeBatches
    ) external {
        zeroLC.settleCharges(chargeBatches);
    }
}