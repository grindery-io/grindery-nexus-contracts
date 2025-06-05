// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "./OnlyProxy.sol";
struct FeeReport {
    address user;
    address agent;
    uint256 amount;
}

contract AIGasTank is
    ReentrancyGuardUpgradeable,
    OwnableUpgradeable,
    AccessControlUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant ROLE_OPERATOR = keccak256("ROLE_OPERATOR");

    event Deposit(address indexed user, uint256 amount);
    event Withdrawal(address indexed user, uint256 amount);
    event FeeCharged(
        bytes32 indexed batchId,
        address indexed user,
        address indexed agent,
        uint256 index,
        uint256 amount
    );
    event FeeChargeFailed(
        bytes32 indexed batchId,
        address indexed user,
        address indexed agent,
        uint256 index,
        uint256 amount
    );

    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IERC20 public immutable gasToken;

    mapping(address => uint256) public balances; // User balances (pre-deposit)

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address _gasToken) {
        require(_gasToken != address(0), "Invalid gas token address");
        gasToken = IERC20(_gasToken);
        _disableInitializers();
    }

    function initialize() public virtual initializer {
        __ReentrancyGuard_init();
        __Ownable_init(msg.sender);
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function deposit(uint256 amount, address user) public nonReentrant {
        if (user != msg.sender) {
            _checkRole(ROLE_OPERATOR);
        }
        require(amount > 0, "Deposit amount must be greater than zero");
        gasToken.safeTransferFrom(user, address(this), amount);
        balances[user] += amount;
        emit Deposit(user, amount);
    }

    function depositTo(uint256 amount, address user, address tokenSource) public nonReentrant onlyRole(ROLE_OPERATOR) {
        require(amount > 0, "Deposit amount must be greater than zero");
        gasToken.safeTransferFrom(tokenSource, address(this), amount);
        balances[user] += amount;
        emit Deposit(user, amount);
    }

    function depositInternal(uint256 amount, address user) external nonReentrant onlyRole(ROLE_OPERATOR) {
        require(amount > 0, "Deposit amount must be greater than zero");
        gasToken.safeTransferFrom(msg.sender, address(this), amount);
        balances[user] += amount;
        emit Deposit(user, amount);
    }

    function withdraw(uint256 amount, address user) external nonReentrant {
        if (user != msg.sender) {
            _checkRole(ROLE_OPERATOR);
        }
        require(amount > 0, "Withdraw amount must be greater than zero");
        require(balances[user] >= amount, "Insufficient balance");
        balances[user] -= amount;
        gasToken.safeTransfer(user, amount);
        emit Withdrawal(user, amount);
    }

    function reportFees(
        bytes32 batchId,
        FeeReport[] calldata reports
    ) external onlyRole(ROLE_OPERATOR) nonReentrant {
        for (uint256 i = 0; i < reports.length; i++) {
            FeeReport calldata r = reports[i];
            uint256 amount = r.amount;
            if (balances[r.user] < amount) {
                emit FeeChargeFailed(batchId, r.user, r.agent, i, r.amount);
                continue;
            }
            balances[r.user] -= amount;
            balances[r.agent] += amount;
            emit FeeCharged(batchId, r.user, r.agent, i, r.amount);
        }
    }

    function balanceOf(address user) external view returns (uint256) {
        return balances[user];
    }
}
