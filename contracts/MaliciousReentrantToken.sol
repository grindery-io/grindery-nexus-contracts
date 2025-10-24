// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MaliciousReentrantToken is ERC20 {
    address public reentrancyTarget;
    bytes public reentrancyCalldata;
    bool public shouldAttack = false;

    constructor(uint256 initialSupply) ERC20("Malicious Token", "MAL") {
        _mint(msg.sender, initialSupply);
    }

    function setReentrancyTarget(address target, bytes memory callData) external {
        reentrancyTarget = target;
        reentrancyCalldata = callData;
        shouldAttack = true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public virtual override returns (bool) {
        // Perform the normal transfer first
        bool success = super.transferFrom(from, to, amount);

        // Attempt reentrancy attack
        if (shouldAttack && reentrancyTarget != address(0)) {
            shouldAttack = false; // Prevent infinite recursion
            (bool callSuccess, ) = reentrancyTarget.call(reentrancyCalldata);
            require(callSuccess, "Reentrancy call failed");
        }

        return success;
    }
}
