// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

/**
 * @title FalseReturningERC20
 * @notice An ERC20 token that returns false on transfer failure instead of reverting
 * @dev This tests SafeERC20 protection for tokens that return false
 */
contract FalseReturningERC20 {
    string public name = "FalseReturning";
    string public symbol = "FRT";
    uint8 public decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    bool public shouldFailTransfer = false;

    constructor(uint256 initialSupply) {
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
    }

    function setFailTransfer(bool _shouldFail) external {
        shouldFailTransfer = _shouldFail;
    }

    function transfer(address to, uint256 value) public returns (bool) {
        if (shouldFailTransfer) {
            return false;
        }
        require(balanceOf[msg.sender] >= value, "Insufficient balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public returns (bool) {
        if (shouldFailTransfer) {
            return false;
        }
        require(balanceOf[from] >= value, "Insufficient balance");
        require(allowance[from][msg.sender] >= value, "Insufficient allowance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        allowance[from][msg.sender] -= value;
        emit Transfer(from, to, value);
        return true;
    }

    function approve(address spender, uint256 value) public returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }
}
