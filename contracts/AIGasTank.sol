// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
struct FeeReport {
    address user;
    address agent;
    uint256 amount;
}
contract AIGasTank is
    Initializable,
    OwnableUpgradeable,
    AccessControlUpgradeable,
    ReentrancyGuarde
{
    using SafeERC20 for IERC20;

    bytes32 public constant ROLE_OPERATOR = keccak256("ROLE_OPERATOR");

    event Deposit(address indexed user, uint256 amount);
    event Withdrawal(address indexed user, uint256 amount);
    event FeeCharged(address[] users, uint256[] amounts);

    IERC20 public immutable gasToken;

    mapping(address => uint256) public balances; // User balances (pre-deposit)

    constructor(address _gasToken, address _gasTank) {
        require(_gasToken != address(0), "Invalid gas token address");
        gasToken = IERC20(_gasToken);
    }

    function initialize() external initializer {
        __Ownable_init(msg.sender);
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ROLE_OPERATOR, msg.sender);
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

    function reportFees(
        FeeReport[] calldata reports
    ) external onlyRole(ROLE_OPERATOR) nonReentrant {
        for (uint256 i = 0; i < reports.length; i++) {
            FeeReport calldata r = reports[i];
            require(balances[r.user] >= r.amount, "Insufficient user balance");
            balances[r.user] -= r.amount;
            balances[r.agent] += r.amount;
            emit FeeCharged(r.user, r.agent, r.amount);
        }
    }

    function balanceOf(address user) external view returns (uint256) {
        return balances[user];
    }

    function grantOperator(
        address operator
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(ROLE_OPERATOR, operator);
    }

    function revokeOperator(
        address operator
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(ROLE_OPERATOR, operator);
    }
}
