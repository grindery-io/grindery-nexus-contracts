// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
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

    function depositTo(
        uint256 amount,
        address user,
        address tokenSource
    ) public nonReentrant onlyRole(ROLE_OPERATOR) {
        require(amount > 0, "Deposit amount must be greater than zero");
        require(tokenSource != address(this), "Invalid token source");
        gasToken.safeTransferFrom(tokenSource, address(this), amount);
        balances[user] += amount;
        emit Deposit(user, amount);
    }

    function depositInternal(
        uint256 amount,
        address user
    ) external nonReentrant onlyRole(ROLE_OPERATOR) {
        require(amount > 0, "Deposit amount must be greater than zero");
        gasToken.safeTransferFrom(msg.sender, address(this), amount);
        balances[user] += amount;
        emit Deposit(user, amount);
    }

    function depositWithExternalToken(
        uint256 amountOfExternalToken,
        address user,
        IERC20 token,
        uint256 rateNumerator,
        uint256 rateDenominator,
        address baseTokenSource
    ) external nonReentrant onlyRole(ROLE_OPERATOR) {
        require(address(token) != address(0), "Invalid token address");
        require(address(token) != address(gasToken), "Cannot use gas token");
        require(
            amountOfExternalToken > 0,
            "Deposit amount must be greater than zero"
        );
        require(rateNumerator > 0, "Rate numerator must be greater than zero");
        require(
            rateDenominator > 0,
            "Rate denominator must be greater than zero"
        );
        require(baseTokenSource != address(this), "Invalid base token source");
        uint256 amount = Math.mulDiv(
            amountOfExternalToken,
            rateNumerator,
            rateDenominator
        );
        require(amount > 0, "Deposit amount must be greater than zero");
        SafeERC20.safeTransferFrom(
            token,
            user,
            address(this),
            amountOfExternalToken
        );
        gasToken.safeTransferFrom(baseTokenSource, address(this), amount);
        balances[user] += amount;
        emit Deposit(user, amount);
    }

    /*
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
    */

    function withdrawTo(
        uint256 amount,
        address user,
        address tokenDestination
    ) external nonReentrant onlyRole(ROLE_OPERATOR) {
        require(amount > 0, "Withdraw amount must be greater than zero");
        require(balances[user] >= amount, "Insufficient balance");
        balances[user] -= amount;
        gasToken.safeTransfer(tokenDestination, amount);
        emit Withdrawal(user, amount);
    }

    function withdrawWithExternalTokenTo(
        uint256 amountOfBaseToken,
        address user,
        IERC20 token,
        uint256 rateNumerator,
        uint256 rateDenominator,
        address tokenDestination
    ) external nonReentrant onlyRole(ROLE_OPERATOR) {
        require(address(token) != address(0), "Invalid token address");
        require(address(token) != address(gasToken), "Cannot use gas token");
        require(
            amountOfBaseToken > 0,
            "Withdraw amount must be greater than zero"
        );
        require(balances[user] >= amountOfBaseToken, "Insufficient balance");
        // Note: rateNumerator and rateDenominator are reversed here, so that we can use same rate as depositWithExternalToken
        uint256 amount = Math.mulDiv(
            amountOfBaseToken,
            rateDenominator,
            rateNumerator
        );
        balances[user] -= amountOfBaseToken;
        SafeERC20.safeTransfer(token, tokenDestination, amount);
        emit Withdrawal(user, amountOfBaseToken);
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
