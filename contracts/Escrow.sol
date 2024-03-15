// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Escrow is ReentrancyGuard, Initializable {
    enum State {
        Open,
        Closed,
        Dispute
    }
    enum CloseReason {
        Release,
        ReleaseExpired,
        Refund,
        AdminRelease,
        AdminRefund
    }

    event Open(
        address indexed tokenAddress,
        address indexed sender,
        address indexed beneficiary,
        uint256 amount,
        uint256 holdDeadline
    );
    event Dispute(address indexed sender, address indexed beneficiary);
    event Close(
        address indexed sender,
        address indexed beneficiary,
        uint256 amount,
        CloseReason indexed reason
    );

    error HoldDeadlineMustBeInFuture();
    error NoApprovedFundFromSender();
    error InvalidState();
    error OnlySenderCanReleaseWithinHoldingPeriod();
    error OnlyBeneficiaryCanTriggerRefund();
    error OnlySenderCanDispute();
    error OnlyAdminCanResolveDispute();
    error OnlyPossibleToTransferToSenderOrBeneficiary();
    error UnauthorizedCallContext();

    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address private immutable __self = address(this);

    IERC20 private _token;
    address public _sender;
    address public _beneficiary;
    address private _admin;
    uint256 private _holdDeadline;
    State private _state;

    function initialize(
        address tokenAddress,
        address sender,
        address beneficiary,
        address admin,
        uint256 holdDeadline
    ) public initializer onlyProxy nonReentrant {
        if (holdDeadline <= block.timestamp)
            revert HoldDeadlineMustBeInFuture();
        _token = IERC20(tokenAddress);
        uint256 allowance = _token.allowance(sender, address(this));
        if (allowance <= 0) revert NoApprovedFundFromSender();
        _token.transferFrom(sender, address(this), allowance);

        _sender = sender;
        _beneficiary = beneficiary;
        _admin = admin;
        _holdDeadline = holdDeadline;
        _state = State.Open;
        emit Open(
            tokenAddress,
            _sender,
            _beneficiary,
            allowance,
            _holdDeadline
        );
    }

    function _transferFund(address to, CloseReason reason) private {
        uint256 balance = _token.balanceOf(address(this));
        require(balance > 0, "Unexpected error: Balance is zero");

        _token.transfer(to, balance);
        _state = State.Closed;
        emit Close(_sender, _beneficiary, balance, reason);
    }

    function release() external onlyProxy nonReentrant {
        if (_state != State.Open) revert InvalidState();
        CloseReason reason = CloseReason.Release;
        if (block.timestamp > _holdDeadline) {
            reason = CloseReason.ReleaseExpired;
        } else {
            if (msg.sender != _sender)
                revert OnlySenderCanReleaseWithinHoldingPeriod();
        }

        _transferFund(_beneficiary, reason);
    }

    function refund() external onlyProxy nonReentrant {
        if (_state != State.Open) revert InvalidState();
        if (msg.sender != _beneficiary)
            revert OnlyBeneficiaryCanTriggerRefund();

        _transferFund(_sender, CloseReason.Refund);
    }

    function dispute() external onlyProxy {
        if (_state != State.Open) revert InvalidState();
        if (msg.sender != _sender) revert OnlySenderCanDispute();

        _state = State.Dispute;
        emit Dispute(_sender, _beneficiary);
    }

    function resolveDispute(address to) external onlyProxy nonReentrant {
        if (_state != State.Dispute) revert InvalidState();
        if (msg.sender != _admin) revert OnlyAdminCanResolveDispute();
        if (!(to == _beneficiary || to == _sender))
            revert OnlyPossibleToTransferToSenderOrBeneficiary();

        _transferFund(
            to,
            to == _beneficiary
                ? CloseReason.AdminRelease
                : CloseReason.AdminRefund
        );
    }

    /**
     * @dev Check that the execution is being performed through a delegatecall call and that the execution context is
     * a proxy contract with an implementation (as defined in ERC1967) pointing to self. This should only be the case
     * for UUPS and transparent proxies that are using the current contract as their implementation. Execution of a
     * function through ERC1167 minimal proxies (clones) would not normally pass this test, but is not guaranteed to
     * fail.
     */
    modifier onlyProxy() {
        if (
            address(this) == __self // Must be called through delegatecall
        ) {
            revert UnauthorizedCallContext();
        }
        _;
    }
}
