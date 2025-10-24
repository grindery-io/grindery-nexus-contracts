// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title RevertingERC20
 * @notice An ERC20 token that can be configured to revert on transfer
 * @dev This tests SafeERC20 protection for reverting tokens
 */
contract RevertingERC20 is ERC20 {
    bool public shouldRevert = false;

    constructor(uint256 initialSupply) ERC20("Reverting", "RVT") {
        _mint(msg.sender, initialSupply);
    }

    function setRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        require(!shouldRevert, "Transfer reverted");
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        require(!shouldRevert, "TransferFrom reverted");
        return super.transferFrom(from, to, value);
    }
}
