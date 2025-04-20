// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SignedMath.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "./OnlyProxy.sol";

struct FeeRecord {
    bytes32 transaction;
    address wallet;
    uint chainId;
    uint256 fee;
    uint nonce;
}

contract FeeAccountantPrimary is
    ReentrancyGuard,
    OnlyProxy,
    OwnableUpgradeable,
    AccessControlUpgradeable
{
    event TransferError(
        uint indexed chainId,
        bytes32 indexed transaction,
        address indexed wallet,
        uint256 fee,
        uint nonce,
        uint256 feeToTransfer,
        bytes error
    );
    event BalanceUpdated(
        uint indexed chainId,
        bytes32 indexed transaction,
        address indexed wallet,
        uint256 fee,
        uint nonce,
        uint256 convertedFee,
        int256 newBalance
    );
    event Stage2ScaleUpdated(uint256 numerator, uint256 denominator);

    error UnsupportedChain(uint chainId);
    error InvalidNonce(
        uint chainId,
        address wallet,
        uint nonce,
        uint expectedNonce
    );
    error OutOfGas();
    error InsaneFee(
        uint chainId,
        bytes32 transaction,
        address wallet,
        uint256 fee,
        uint256 convertedFee
    );

    bytes32 public constant ROLE_OPERATOR = keccak256("ROLE_OPERATOR");

    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IERC20 private immutable gasToken;
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address private immutable gasTank;

    mapping(uint => AggregatorV3Interface) private priceFeeds;

    mapping(address => int256) private balances;
    mapping(bytes32 => uint256) private nonces;

    uint256 stage2FixedFee = 0;
    uint256 stage2ScaleNumerator = 0;
    uint256 stage2ScaleDenominator = 0;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(
        address deploymentAddress,
        address _gasToken,
        address _gasTank
    ) OnlyProxy(deploymentAddress) {
        gasToken = IERC20(_gasToken);
        gasTank = _gasTank;
    }

    function initialize() public initializer {
        __Context_init();
        __Ownable_init(msg.sender);
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ROLE_OPERATOR, gasTank);
    }

    function setPriceFeed(uint chainId, address feed) external onlyOwner {
        AggregatorV3Interface instance = AggregatorV3Interface(feed);
        if (feed != address(0)) {
            require(instance.decimals() == 8, "Invalid price feed");
            (, int256 price, , , ) = instance.latestRoundData();
            require(price > 0, "Invalid price feed");
        }
        priceFeeds[chainId] = instance;
    }

    function setStage2Fee(
        uint256 fixedFee,
        uint256 feeNumerator,
        uint256 feeDenominator
    ) external onlyOwner {
        stage2FixedFee = fixedFee;
        _updateStage2Scale(feeNumerator, feeDenominator);
    }

    function _updateStage2Scale(
        uint256 feeNumerator,
        uint256 feeDenominator
    ) private {
        require(feeDenominator > 0, "Invalid fee denominator");
        stage2ScaleNumerator = feeNumerator;
        stage2ScaleDenominator = feeDenominator;
        emit Stage2ScaleUpdated(feeNumerator, feeDenominator);
    }

    function getStage2Fee()
        external
        view
        returns (uint256 fixedFee, uint256 feeNumerator, uint256 feeDenominator)
    {
        return (stage2FixedFee, stage2ScaleNumerator, stage2ScaleDenominator);
    }

    function getPriceFeed(uint chainId) external view returns (address) {
        return address(priceFeeds[chainId]);
    }

    function foreignFeeToLocalFee(
        uint256 fee,
        uint chainId
    ) public view returns (uint256 convertedFee) {
        AggregatorV3Interface foreign = priceFeeds[chainId];
        AggregatorV3Interface local = priceFeeds[0];
        if (address(foreign) == address(0)) {
            revert UnsupportedChain(chainId);
        }
        if (address(local) == address(0)) {
            revert UnsupportedChain(0);
        }
        (, int256 foreignPrice, , , ) = foreign.latestRoundData();
        (, int256 localPrice, , , ) = local.latestRoundData();
        convertedFee = Math.mulDiv(
            fee,
            SafeCast.toUint256(foreignPrice),
            SafeCast.toUint256(localPrice),
            Math.Rounding.Trunc
        );
        if (stage2ScaleDenominator > 0) {
            convertedFee = Math.mulDiv(
                convertedFee + stage2FixedFee,
                stage2ScaleNumerator,
                stage2ScaleDenominator,
                Math.Rounding.Trunc
            );
        }
        return convertedFee;
    }

    function getNonceKey(
        address wallet,
        uint chainId
    ) public pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    keccak256("FEE_ACCOUNTANT_NONCE_KEY"),
                    wallet,
                    chainId
                )
            );
    }

    function getWalletRecord(
        address wallet,
        uint chainId
    ) public view returns (int256 balance, uint256 nonce) {
        return (balances[wallet], nonces[getNonceKey(wallet, chainId)]);
    }

    function payFee(uint256 amount) public nonReentrant notProxy {
        gasToken.transferFrom(msg.sender, gasTank, amount);
        balances[msg.sender] -= SafeCast.toInt256(amount);
        emit BalanceUpdated(
            ~uint(0),
            bytes32(0),
            msg.sender,
            0,
            0,
            0,
            balances[msg.sender]
        );
    }

    // Called via delegatecall
    function approveAndPayFee(
        uint256 amount,
        uint256 extraAllowance
    ) public onlyProxy {
        uint256 targetAllowance = amount + extraAllowance;
        if (gasToken.allowance(msg.sender, gasTank) < targetAllowance) {
            gasToken.approve(__deploymentAddress, targetAllowance);
        }
        if (amount > 0) {
            FeeAccountantPrimary(__deploymentAddress).payFee(amount);
        }
    }

    function updateStage2ScaleAndCommitFees(
        FeeRecord[] calldata records,
        uint256 feeNumerator,
        uint256 feeDenominator
    ) public onlyRole(ROLE_OPERATOR) {
        _updateStage2Scale(feeNumerator, feeDenominator);
        commitFees(records);
    }

    function commitFees(
        FeeRecord[] calldata records
    ) public onlyRole(ROLE_OPERATOR) nonReentrant {
        for (uint i = 0; i < records.length; i++) {
            FeeRecord calldata record = records[i];
            bytes32 nonceKey = getNonceKey(record.wallet, record.chainId);
            if (record.nonce == nonces[nonceKey]) {
                nonces[nonceKey] = record.nonce + 1;
            } else {
                revert InvalidNonce(
                    record.chainId,
                    record.wallet,
                    record.nonce,
                    nonces[nonceKey]
                );
            }
            uint256 convertedFee = foreignFeeToLocalFee(
                record.fee,
                record.chainId
            );
            if (convertedFee > 1000 ether) {
                revert InsaneFee(
                    record.chainId,
                    record.transaction,
                    record.wallet,
                    record.fee,
                    convertedFee
                );
            }
            int256 balance = balances[record.wallet] +
                SafeCast.toInt256(convertedFee);
            if (balance > 0) {
                int256 feeToTransfer = SignedMath.min(
                    balance,
                    SignedMath.min(
                        SafeCast.toInt256(gasToken.balanceOf(record.wallet)),
                        SafeCast.toInt256(
                            gasToken.allowance(record.wallet, address(this))
                        )
                    )
                );
                if (feeToTransfer > 0) {
                    uint256 gasBefore = gasleft();
                    try
                        gasToken.transferFrom(
                            record.wallet,
                            gasTank,
                            SafeCast.toUint256(feeToTransfer)
                        )
                    {
                        balance = balance - feeToTransfer;
                    } catch (bytes memory error) {
                        if (gasleft() < gasBefore / 8) {
                            revert OutOfGas();
                        }
                        emit TransferError(
                            record.chainId,
                            record.transaction,
                            record.wallet,
                            record.fee,
                            record.nonce,
                            SafeCast.toUint256(feeToTransfer),
                            error
                        );
                    }
                }
            }
            balances[record.wallet] = balance;
            emit BalanceUpdated(
                record.chainId,
                record.transaction,
                record.wallet,
                record.fee,
                record.nonce,
                convertedFee,
                balance
            );
        }
    }
}
