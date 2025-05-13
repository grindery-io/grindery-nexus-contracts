// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@prb/math/UD60x18.sol"; // Install PRBMath

contract AgentBondingCurve is ERC20, OwnableUpgradeable {
    using SafeERC20 for IERC20;
    using UD60x18 for uint256;
    using UD60x18 for int256;

    IERC20 public gxToken;
    address public treasury;

    uint256 public reserveBalance;

    // Curve parameters
    uint256 public P_max;
    uint256 public S_mid;
    uint256 public k;
    uint256 public C;
    uint256 public fee;

    uint256 public constant MIN_INITIAL_DEPOSIT = 25_000e18;
    uint256 public constant MAX_FEE = 500; // 5%

    bool public initialized;

    event TokensPurchased(
        address indexed buyer,
        uint256 amount,
        uint256 gxPaid
    );
    event TokensSold(
        address indexed seller,
        uint256 amount,
        uint256 gxRefunded
    );
    event Buyback(uint256 gxUsed, uint256 tokensBurned);

    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function initialize(
        address _gxToken,
        address _treasury,
        uint256 _P_max,
        uint256 _S_mid,
        uint256 _k,
        uint256 _C,
        uint256 _fee
    ) external initializer {
        require(!initialized, "Already initialized");
        __Ownable_init();
        gxToken = IERC20(_gxToken);
        treasury = _treasury;
        P_max = _P_max;
        S_mid = _S_mid;
        k = _k;
        C = _C;
        fee = _fee;
        initialized = true;

        // Enforce initial GX deposit
        require(
            gxToken.transferFrom(
                msg.sender,
                address(this),
                MIN_INITIAL_DEPOSIT
            ),
            "Initial GX transfer failed"
        );

        uint256 initialSupply = estimateMintAmount(MIN_INITIAL_DEPOSIT);
        _mint(msg.sender, initialSupply);
        reserveBalance += MIN_INITIAL_DEPOSIT;
    }

    // Logistic sigmoid price function
    function price(uint256 supply) public view returns (uint256) {
        int256 exponent = (-int256(k) * (int256(supply) - int256(S_mid))) /
            1e18;
        uint256 denom = uint256(
            (UD60x18.fromInt(1).add(UD60x18.exp(exponent))).unwrap()
        );
        return (P_max * 1e18) / denom + C;
    }

    // Estimate GX required to mint `amount` tokens
    function estimateMintAmount(
        uint256 gxAmount
    ) public view returns (uint256) {
        // Basic bisection method to invert integral
        uint256 low = 0;
        uint256 high = 1_000_000e18;
        while (high - low > 1e12) {
            uint256 mid = (low + high) / 2;
            uint256 cost = integralPrice(totalSupply(), totalSupply() + mid);
            if (cost > gxAmount) high = mid;
            else low = mid;
        }
        return low;
    }

    function buy(uint256 amount) external {
        uint256 supplyBefore = totalSupply();
        uint256 supplyAfter = supplyBefore + amount;

        uint256 cost = integralPrice(supplyBefore, supplyAfter);
        uint256 feeAmount = (cost * fee) / 10_000;
        uint256 totalCost = cost + feeAmount;

        gxToken.safeTransferFrom(msg.sender, address(this), cost);
        gxToken.safeTransferFrom(msg.sender, treasury, feeAmount);

        reserveBalance += cost;

        _mint(msg.sender, amount);
        emit TokensPurchased(msg.sender, amount, totalCost);
    }

    function sell(uint256 amount) external {
        require(balanceOf(msg.sender) >= amount, "Insufficient balance");

        uint256 supplyBefore = totalSupply();
        uint256 supplyAfter = supplyBefore - amount;

        uint256 refund = integralPrice(supplyAfter, supplyBefore);
        uint256 feeAmount = (refund * fee) / 10_000;
        uint256 netRefund = refund - feeAmount;

        _burn(msg.sender, amount);

        reserveBalance -= refund;

        gxToken.safeTransfer(msg.sender, netRefund);
        gxToken.safeTransfer(treasury, feeAmount);

        emit TokensSold(msg.sender, amount, netRefund);
    }

    // Midpoint rule for better integration
    function integralPrice(
        uint256 fromSupply,
        uint256 toSupply
    ) internal view returns (uint256) {
        uint256 steps = 50;
        if (toSupply <= fromSupply) return 0;
        uint256 stepSize = (toSupply - fromSupply) / steps;
        uint256 total = 0;
        for (uint256 i = 0; i < steps; i++) {
            uint256 mid = fromSupply + (i * stepSize) + (stepSize / 2);
            total += (price(mid) * stepSize) / 1e18;
        }
        return total;
    }

    function buybackAndBurn(uint256 gxAmount) external onlyOwner {
        require(
            gxToken.transferFrom(msg.sender, address(this), gxAmount),
            "GX transfer failed"
        );

        uint256 burnAmount = estimateMintAmount(gxAmount);
        _mint(address(this), burnAmount);
        _burn(address(this), burnAmount);

        reserveBalance += gxAmount;

        emit Buyback(gxAmount, burnAmount);
    }

    function setFee(uint256 _fee) external onlyOwner {
        require(_fee <= MAX_FEE, "Fee too high");
        fee = _fee;
    }

    function setCurveParams(
        uint256 _P_max,
        uint256 _S_mid,
        uint256 _k,
        uint256 _C
    ) external onlyOwner {
        P_max = _P_max;
        S_mid = _S_mid;
        k = _k;
        C = _C;
    }
}
