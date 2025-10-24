// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title TestERC20_6Decimals
 * @notice An ERC20 token with 6 decimals (like USDC/USDT)
 * @dev This tests that the contract works correctly with tokens that have non-standard decimal values
 */
contract TestERC20_6Decimals is ERC20 {
    constructor(uint256 initialSupply) ERC20("USDC Mock", "USDC") {
        _mint(msg.sender, initialSupply);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
