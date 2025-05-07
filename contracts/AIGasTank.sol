// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

contract AIGasTank is ReentrancyGuard, Ownable, AccessControl {
    using SafeERC20 for IERC20;

    event Deposit(address indexed user, uint256 amount);
    event Withdrawal(address indexed user, uint256 amount);
    event FeeCharged(address indexed user, address indexed agent, uint256 amount);
    
    bytes32 public constant ROLE_AGENT = keccak256("ROLE_AGENT");

    IERC20 public immutable gasToken;
    mapping(address => uint256) public balances; // User balances (pre-deposit)
    mapping(address => uint256) public agentEarnings; // Agent earnings

    constructor(address _gasToken) {
        require(_gasToken != address(0), "Invalid gas token address");
        gasToken = IERC20(_gasToken);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
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

    function chargeFee(address user, uint256 amount) external onlyRole(ROLE_AGENT) nonReentrant {
        require(amount > 0, "Fee must be greater than zero");
        require(balances[user] >= amount, "Insufficient user balance");
        balances[user] -= amount;
        agentEarnings[msg.sender] += amount;
        emit FeeCharged(user, msg.sender, amount);
    }

    function withdrawEarnings(uint256 amount) external nonReentrant {
        require(agentEarnings[msg.sender] >= amount, "Insufficient earnings");
        agentEarnings[msg.sender] -= amount;
        gasToken.safeTransfer(msg.sender, amount);
    }

    function addAgent(address agent) external onlyOwner {
        grantRole(ROLE_AGENT, agent);
    }

    function removeAgent(address agent) external onlyOwner {
        revokeRole(ROLE_AGENT, agent);
    }

    function getBalance(address user) external view returns (uint256) {
        return balances[user];
    }

    function getAgentEarnings(address agent) external view returns (uint256) {
        return agentEarnings[agent];
    }
}
