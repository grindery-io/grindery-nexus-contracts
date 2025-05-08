// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract AIGasTank is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    event Deposit(address indexed user, uint256 amount);
    event Withdrawal(address indexed user, uint256 amount);
    event FeeCharged(address[] users, uint256[] amounts);

    IERC20 public immutable gasToken;
    mapping(address => uint256) public balances; // User balances (pre-deposit)

    constructor(address _gasToken) {
        require(_gasToken != address(0), "Invalid gas token address");
        gasToken = IERC20(_gasToken);
    }

    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "Deposit amount must be greater than zero");
        gasToken.safeTransferFrom(msg.sender, address(this), amount);
        balances[msg.sender] += amount;
        emit Deposit(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "Withdraw amount must be greater than zero");
        require(balances[msg.sender] >= amount, "Insufficient balance");
        balances[msg.sender] -= amount;
        gasToken.safeTransfer(msg.sender, amount);
        emit Withdrawal(msg.sender, amount);
    }

    function chargeFee(address[] calldata users, uint256[] calldata fees) external onlyOwner nonReentrant {
        require(users.length == fees.length, "Mismatched input lengths");
        for (uint256 i = 0; i < users.length; i++) {
            require(balances[users[i]] >= fees[i], "Insufficient user balance");
            balances[users[i]] -= fees[i];
        }
        emit FeeCharged(users, fees);
    }

    function balanceOf(address user) external view returns (uint256) {
        return balances[user];
    }
}
