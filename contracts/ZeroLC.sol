// SPDX-License-Identifier: MIT

pragma solidity 0.8.30;

// Revert String to Typed Error Mapping
// Use this table to update tests after converting to typed errors
//
// "Invalid gas token address" -> InvalidGasTokenAddress
// "Invalid universal sig validator address" -> InvalidUniversalSigValidatorAddress
// "Invalid scope signature" -> InvalidScopeSignature
// "Authorization scope expired" -> AuthorizationScopeExpired
// "Authorization scope not yet active" -> AuthorizationScopeNotYetActive
// "Authorization scope total amount must be greater than 0" -> InvalidTotalAmount
// "Authorization scope dispute window must be greater than 0" -> InvalidDisputeWindow
// "Authorization scope agent address must be non-zero" -> InvalidAgentAddress
// "User cannot be their own agent" -> UserCannotBeOwnAgent
// "Insufficient balance" -> InsufficientBalance
// "Authorization scope already registered" -> ScopeAlreadyRegistered
// "Authorization scope is not active" -> ScopeNotActive
// "Authorization scope is already exhausted" -> ScopeAlreadyExhausted
// "No charges in batch" -> EmptyChargeBatch
// "Invalid signature" -> InvalidAgentSignature
// "Invalid batch length" -> InvalidBatchLength
// "Invalid batch timestamp (must be within 1 minute)" -> BatchTimestampOutOfRange
// "Invalid batch timestamp (must be greater than last charge timestamp)" -> BatchTimestampNotIncreasing
// "Invalid nonce" -> InvalidNonce
// "Charge entry expired" -> ChargeEntryExpired
// "Charge amount must be greater than 0" -> InvalidChargeAmount
// "Dispute window expired" -> DisputeWindowExpired
// "Future charge batch" -> FutureChargeBatch
// "Invalid dispute signature" -> InvalidDisputeSignature
// "Invalid amount to clawback" -> InvalidClawbackAmount
// "amountToClawback must be less than total charged amount in the batch" -> ClawbackExceedsBatchTotal
// "Dispute already exists" -> DisputeAlreadyExists
// "UNEXPECTED: No balance to clawback" -> InsufficientPendingBalance
// "Invalid user address" -> InvalidUserAddress
// "Deposit amount must be greater than zero" -> InvalidDepositAmount
// "Invalid deposit signature" -> InvalidDepositSignature
// "Cannot deposit to self" -> CannotDepositToSelf
// "Caller is not the agent" -> CallerNotAgent
// "Invalid withdrawal signature" -> InvalidWithdrawalSignature
// "Scope mismatch" -> ScopeMismatch
// "Charge batch still in dispute window" -> BatchStillInDisputeWindow
// "Non-continuous nonce sequence" -> NonContinuousNonceSequence
// "Provided charges exceed pending amount" -> ChargesExceedPendingAmount
// "No withdrawable balance" -> NoWithdrawableBalance

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "./UniversalSigValidator.sol";

// Timestamp Range Semantics:
// - notBefore: INCLUSIVE - valid starting at exactly this timestamp (notBefore <= block.timestamp)
// - notAfter: EXCLUSIVE - NOT valid at exactly this timestamp (block.timestamp < notAfter)
// - Valid time range: [notBefore, notAfter)

struct AuthorizationScope {
    address user;
    uint40 disputeWindow; // in seconds
    address agent;
    uint40 notBefore;
    uint40 notAfter;
    uint128 totalAmount;
    // Used to calculate minimum chargable amount
    // totalAmount / 10 ^ amountGranularity must fit in uint32
    uint8 amountGranularity;
}

uint24 constant FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED = 1 << 23;
uint24 constant FLAG_SCOPE_STATUS_DEACTIVATED = 1 << 22;

// NOTE: Keep size of the struct under 256 bits
struct AuthorizationScopeState {
    // Amounts in this struct are scaled down by 10 ^ amountGranularity
    uint32 remainingAmount;
    uint32 chargedAmountWithdrawable;
    // When finalizationTimestamp is out of dispute window:
    // * Move chargedAmountFinalizing to chargedAmountWithdrawable
    // * Move chargedAmountPending to chargedAmountWithdrawable
    // * Set finalizationTimestamp to lastChargeTimestamp
    // (Optimize and skip steps when possible)
    uint32 chargedAmountFinalizing;
    // New charges are added to chargedAmountPending
    uint32 chargedAmountPending;
    uint40 notAfter;
    // Timestamps are negative offset from notAfter, e.g. realFinalizationTimestamp = notAfter - finalizationTimestamp
    uint32 finalizationTimestamp;
    uint32 lastChargeTimestamp;
    uint24 nonceAndFlags;
}

struct ChargeEntry {
    uint32 scaledAmount; // SCALED amount (divided by 10^amountGranularity)
    uint24 nonce;
    uint40 notAfter;
}

// Rationale: Allows facilitator to batch charges with optimized gas cost and requires only single HTTP request per charge
struct ChargeBatchVerifier {
    // keccak256(abi.encode(ChargeEntry[:-1])) i.e. hash of all entries but last. set to 0x00 if there is only one entry
    bytes32 batchPartHash;
    ChargeEntry lastEntry;
    bytes32 scopeHash; // keccak256(abi.encode(_domainSeparatorV4(), AuthorizationScope))
}

struct ChargeBatch {
    AuthorizationScope scope;
    ChargeEntry[] entries;
    uint40 timestamp;
    bytes agentSignature; // Signature of keccak256(abi.encode(constructed ChargeBatchVerifier))
}

struct UserState {
    uint256 balance;
    uint256 numCharges;
    uint256 numDisputes;
    uint256 nonce;
    bytes32[] authorizationScopeHashes;
}

struct AuthorizationScopeData {
    uint128 totalAmount; // Original unscaled total amount
    uint40 disputeWindow;
    uint8 amountGranularity;
    // Remaining bits unused (80 bits free for future use)
}

struct Dispute {
    ChargeBatch chargeBatch;
    uint32 amountToClawback; // SCALED amount (divided by 10^amountGranularity)
    bytes signature;
}

contract ZeroLC is
    EIP712,
    ReentrancyGuardUpgradeable,
    OwnableUpgradeable,
    AccessControlUpgradeable
{
    using SafeERC20 for IERC20;

    // Custom errors
    error InvalidGasTokenAddress();
    error InvalidUniversalSigValidatorAddress();
    error InvalidScopeSignature();
    error AuthorizationScopeExpired();
    error AuthorizationScopeNotYetActive();
    error InvalidTotalAmount();
    error InvalidDisputeWindow();
    error InvalidAgentAddress();
    error UserCannotBeOwnAgent();
    error InsufficientBalance();
    error ScopeAlreadyRegistered();
    error ScopeNotActive();
    error ScopeAlreadyExhausted();
    error EmptyChargeBatch();
    error InvalidAgentSignature();
    error InvalidBatchLength();
    error BatchTimestampOutOfRange();
    error BatchTimestampNotIncreasing();
    error InvalidNonce();
    error ChargeEntryExpired();
    error InvalidChargeAmount();
    error DisputeWindowExpired();
    error FutureChargeBatch();
    error InvalidDisputeSignature();
    error ClawbackExceedsBatchTotal();
    error DisputeAlreadyExists();
    error InsufficientPendingBalance();
    error InvalidClawbackAmount();
    error InvalidUserAddress();
    error InvalidDepositAmount();
    error InvalidDepositSignature();
    error CannotDepositToSelf();
    error CallerNotAgent();
    error InvalidWithdrawalSignature();
    error ScopeMismatch();
    error BatchStillInDisputeWindow();
    error NonContinuousNonceSequence();
    error ChargesExceedPendingAmount();
    error NoWithdrawableBalance();
    error InvalidAmountGranularity();
    error InvalidTimestampRange();

    bytes32 public constant ROLE_OPERATOR = keccak256("ROLE_OPERATOR");

    event Deposit(address indexed user, uint256 amount);
    event Withdrawal(address indexed user, uint256 amount);

    // To save gas no data is logged. Applications should read and parse calldata to determine settled charges
    event ChargesSettled();

    // Same as above, but with data attached, to handle cases when settled from a contract and calldata is hard to get
    event ChargesSettledFromContract(bytes data);

    event AuthorizationScopeRegistered(
        address indexed user,
        address indexed agent,
        bytes32 indexed scopeHash
    );
    event AuthorizationScopeRevoking(
        address indexed user,
        address indexed agent,
        bytes32 indexed scopeHash
    );

    event ChargeDisputed(
        address indexed user,
        address indexed agent,
        bytes32 indexed scopeHash,
        uint256 amount
    );

    event AgentWithdrawal(
        address indexed agent,
        bytes32 indexed scopeHash,
        uint256 amount,
        bool toWallet
    );

    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    IERC20 public immutable gasToken;
    UniversalSigValidator public immutable universalSigValidator;

    mapping(address => UserState) public userStates;
    mapping(address => bytes32[]) public agentAuthorizationScopes;
    mapping(bytes32 => AuthorizationScopeState) public authorizationScopes;
    mapping(bytes32 => AuthorizationScopeData) public authorizationScopeData;
    mapping(bytes32 => bool) public disputedCharges;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(
        address _gasToken,
        address _universalSigValidator
    ) EIP712("ZeroLC", "1") {
        require(_gasToken != address(0), InvalidGasTokenAddress());
        require(
            _universalSigValidator != address(0),
            InvalidUniversalSigValidatorAddress()
        );
        gasToken = IERC20(_gasToken);
        universalSigValidator = UniversalSigValidator(_universalSigValidator);
        _disableInitializers();
    }

    function initialize() public virtual initializer {
        __ReentrancyGuard_init();
        __Ownable_init(msg.sender);
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // Note: scopeHash is different from EIP712 hash of the scope
    function getScopeHash(
        AuthorizationScope calldata scope
    ) public view returns (bytes32) {
        return keccak256(abi.encode(_domainSeparatorV4(), scope));
    }

    // ============ Helper Functions ============

    // Nonce and flags manipulation
    function _getNonce(uint24 nonceAndFlags) private pure returns (uint24) {
        return nonceAndFlags & 0x3FFFFF; // Lower 22 bits
    }

    function _setNonce(
        uint24 nonceAndFlags,
        uint24 newNonce
    ) private pure returns (uint24) {
        return (nonceAndFlags & 0xC00000) | (newNonce & 0x3FFFFF); // Preserve upper 2 bits (flags), set lower 22 bits
    }

    function _setFlag(
        uint24 nonceAndFlags,
        uint24 flag
    ) private pure returns (uint24) {
        return nonceAndFlags | flag;
    }

    function _clearFlag(
        uint24 nonceAndFlags,
        uint24 flag
    ) private pure returns (uint24) {
        return nonceAndFlags & ~flag;
    }

    // Amount scaling
    function _unscaleAmount(
        uint32 scaledAmount,
        uint8 granularity
    ) private pure returns (uint128) {
        return uint128(scaledAmount) * uint128(10 ** granularity);
    }

    // Timestamp offset manipulation
    // Timestamps are stored as negative offsets from notAfter to fit in uint32
    function _getTimestampOffset(
        uint40 notAfter,
        uint40 timestamp
    ) private pure returns (uint32) {
        return uint32(notAfter - timestamp);
    }

    function _getTimestampFromOffset(
        uint40 notAfter,
        uint32 offset
    ) private pure returns (uint40) {
        return notAfter - offset;
    }

    // State transition helper
    // Moves amounts through the pipeline: pending -> finalizing -> withdrawable
    function _updateFinalizationState(
        AuthorizationScopeState memory state,
        uint40 disputeWindow
    ) private view returns (AuthorizationScopeState memory) {
        // Calculate real finalization timestamp from offset
        uint40 realFinalizationTimestamp = _getTimestampFromOffset(
            state.notAfter,
            state.finalizationTimestamp
        );

        // Check if finalization timestamp is past dispute window
        if (block.timestamp >= realFinalizationTimestamp + disputeWindow) {
            // Move chargedAmountFinalizing to withdrawable
            state.chargedAmountWithdrawable += state.chargedAmountFinalizing;

            // Move chargedAmountPending to finalizing
            state.chargedAmountFinalizing = state.chargedAmountPending;
            state.chargedAmountPending = 0;

            // Update finalizationTimestamp to lastChargeTimestamp (both are offsets)
            state.finalizationTimestamp = state.lastChargeTimestamp;
        }
        return state;
    }

    // ============ End Helper Functions ============

    function compactUserAuthorizationStates(address user) internal {
        UserState storage userState = userStates[user];
        bytes32[] storage scopeHashes = userState.authorizationScopeHashes;
        uint256 balance = userState.balance;
        uint256 numCharges = userState.numCharges;
        for (uint256 i = 0; i < userState.authorizationScopeHashes.length; ) {
            bytes32 scopeHash = userState.authorizationScopeHashes[i];
            AuthorizationScopeState memory state = authorizationScopes[
                scopeHash
            ];
            uint24 nonce = _getNonce(state.nonceAndFlags);
            if (uint40(block.timestamp) < state.notAfter || nonce == 0) {
                i++;
                continue;
            }
            if (state.remainingAmount > 0) {
                // Need to unscale the remaining amount before adding to balance
                AuthorizationScopeData
                    memory scopeData = authorizationScopeData[scopeHash];
                balance += _unscaleAmount(
                    state.remainingAmount,
                    scopeData.amountGranularity
                );
                state.remainingAmount = 0;
            }
            if (
                (state.nonceAndFlags &
                    FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED) == 0
            ) {
                numCharges += nonce - 1;
                state.nonceAndFlags = _setFlag(
                    state.nonceAndFlags,
                    FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED
                );
            }
            authorizationScopes[scopeHash] = state;
            // Delete scope hash - swap with last element and pop
            // Don't increment i, as we need to check the swapped element
            scopeHashes[i] = scopeHashes[scopeHashes.length - 1];
            scopeHashes.pop();
        }
        userState.balance = balance;
        userState.numCharges = numCharges;
    }

    function registerAuthorizationScope(
        AuthorizationScope calldata scope,
        bytes calldata signature
    ) external nonReentrant {
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256(
                        "AuthorizationScope(address user,uint40 disputeWindow,address agent,uint40 notBefore,uint40 notAfter,uint128 totalAmount,uint8 amountGranularity)"
                    ),
                    scope.user,
                    scope.disputeWindow,
                    scope.agent,
                    scope.notBefore,
                    scope.notAfter,
                    scope.totalAmount,
                    scope.amountGranularity
                )
            )
        );
        require(
            universalSigValidator.isValidSig(scope.user, digest, signature),
            InvalidScopeSignature()
        );
        require(block.timestamp < scope.notAfter, AuthorizationScopeExpired());
        require(
            scope.notBefore <= block.timestamp,
            AuthorizationScopeNotYetActive()
        );
        require(scope.totalAmount > 0, InvalidTotalAmount());
        require(scope.disputeWindow > 0, InvalidDisputeWindow());
        require(scope.agent != address(0), InvalidAgentAddress());
        require(scope.user != scope.agent, UserCannotBeOwnAgent());

        // Validate amountGranularity
        uint32 scaledTotalAmount = uint32(
            scope.totalAmount / (10 ** scope.amountGranularity)
        );
        require(
            uint128(scaledTotalAmount) * (10 ** scope.amountGranularity) ==
                scope.totalAmount,
            InvalidAmountGranularity()
        );

        // Validate timestamp range fits in uint32
        require(scope.notAfter > scope.notBefore, InvalidTimestampRange());
        uint40 timeRange = scope.notAfter - scope.notBefore;
        require(timeRange <= type(uint32).max, InvalidTimestampRange());
        compactUserAuthorizationStates(scope.user);
        UserState storage userState = userStates[scope.user];
        if (scope.totalAmount > userState.balance) {
            uint256 amountNeeded = scope.totalAmount - userState.balance;
            uint256 allowance = gasToken.allowance(scope.user, address(this));
            uint256 gasTokenBalance = gasToken.balanceOf(scope.user);
            if (allowance >= amountNeeded && gasTokenBalance >= amountNeeded) {
                _depositInternal(scope.user, amountNeeded);
            }
        }
        require(scope.totalAmount <= userState.balance, InsufficientBalance());
        bytes32 scopeHash = getScopeHash(scope);
        require(
            authorizationScopes[scopeHash].notAfter == 0,
            ScopeAlreadyRegistered()
        );

        // Store authorization scope data for later retrieval
        authorizationScopeData[scopeHash] = AuthorizationScopeData({
            totalAmount: scope.totalAmount,
            disputeWindow: scope.disputeWindow,
            amountGranularity: scope.amountGranularity
        });

        // Calculate timestamp offsets
        // finalizationTimestamp: offset to notBefore (earliest possible finalization time)
        // lastChargeTimestamp: offset to current time (no charges yet)
        uint40 currentTime = uint40(block.timestamp);

        authorizationScopes[scopeHash] = AuthorizationScopeState({
            remainingAmount: scaledTotalAmount,
            chargedAmountWithdrawable: 0,
            chargedAmountFinalizing: 0,
            chargedAmountPending: 0,
            notAfter: scope.notAfter,
            finalizationTimestamp: uint32(scope.notAfter - scope.notBefore), // Offset to notBefore
            lastChargeTimestamp: uint32(scope.notAfter - currentTime), // Offset to now
            nonceAndFlags: _setNonce(0, 1) // Start with nonce=1, flags=0
        });
        userState.balance -= scope.totalAmount;
        userState.authorizationScopeHashes.push(scopeHash);
        agentAuthorizationScopes[scope.agent].push(scopeHash);
        emit AuthorizationScopeRegistered(scope.user, scope.agent, scopeHash);
    }

    function revokeAuthorizationScope(
        AuthorizationScope calldata scope,
        bytes calldata signature
    ) external nonReentrant {
        bytes32 scopeHash = getScopeHash(scope);
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256("RevokeAuthorizationScope(bytes32 scopeHash)"),
                    scopeHash
                )
            )
        );
        require(
            universalSigValidator.isValidSig(scope.user, digest, signature),
            InvalidScopeSignature()
        );
        uint40 newNotAfter = uint40(block.timestamp) + 300;
        AuthorizationScopeState memory state = authorizationScopes[scopeHash];
        require(state.notAfter > newNotAfter, ScopeNotActive());
        require(state.remainingAmount > 0, ScopeAlreadyExhausted());
        state.notAfter = newNotAfter;
        authorizationScopes[scopeHash] = state;
        emit AuthorizationScopeRevoking(scope.user, scope.agent, scopeHash);
    }

    function verifyChargeBatchSignature(
        ChargeBatch calldata chargeBatch
    ) internal view returns (bytes32 scopeHash) {
        scopeHash = keccak256(
            abi.encode(_domainSeparatorV4(), chargeBatch.scope)
        );
        uint numCharges = chargeBatch.entries.length;
        require(numCharges > 0, EmptyChargeBatch());
        ChargeBatchVerifier memory verifier;
        if (numCharges > 1) {
            verifier.batchPartHash = keccak256(
                abi.encode(chargeBatch.entries[0:numCharges - 1])
            );
        }
        verifier.lastEntry = chargeBatch.entries[numCharges - 1];
        verifier.scopeHash = scopeHash;
        require(
            ECDSA.recover(
                MessageHashUtils.toEthSignedMessageHash(abi.encode(verifier)),
                chargeBatch.agentSignature
            ) == chargeBatch.scope.agent,
            InvalidAgentSignature()
        );
    }

    function settleCharges(ChargeBatch[] calldata chargeBatches) external {
        require(chargeBatches.length > 0, InvalidBatchLength());
        for (uint256 i = 0; i < chargeBatches.length; i++) {
            ChargeBatch calldata chargeBatch = chargeBatches[i];
            bytes32 scopeHash = verifyChargeBatchSignature(chargeBatch);
            require(
                chargeBatch.timestamp > block.timestamp - 60 &&
                    chargeBatch.timestamp <= block.timestamp,
                BatchTimestampOutOfRange()
            );
            AuthorizationScopeState memory state = authorizationScopes[
                scopeHash
            ];
            require(
                block.timestamp < state.notAfter,
                AuthorizationScopeExpired()
            );
            state = _updateFinalizationState(
                state,
                chargeBatch.scope.disputeWindow
            );

            // Convert stored timestamp offset back to real timestamp for comparison
            uint40 realLastChargeTimestamp = _getTimestampFromOffset(
                state.notAfter,
                state.lastChargeTimestamp
            );
            require(
                chargeBatch.timestamp > realLastChargeTimestamp,
                BatchTimestampNotIncreasing()
            );

            uint32 totalScaledAmount = 0;
            uint24 nonce = _getNonce(state.nonceAndFlags);
            for (uint256 j = 0; j < chargeBatch.entries.length; j++) {
                ChargeEntry memory entry = chargeBatch.entries[j];
                require(entry.nonce == nonce, InvalidNonce());
                require(block.timestamp < entry.notAfter, ChargeEntryExpired());
                require(entry.scaledAmount > 0, InvalidChargeAmount());
                totalScaledAmount += entry.scaledAmount;
                nonce += 1;
            }
            uint32 remainingAmount = state.remainingAmount;
            require(
                totalScaledAmount <= remainingAmount,
                InsufficientBalance()
            );
            authorizationScopes[scopeHash] = AuthorizationScopeState({
                remainingAmount: remainingAmount - totalScaledAmount,
                chargedAmountWithdrawable: state.chargedAmountWithdrawable,
                chargedAmountFinalizing: state.chargedAmountFinalizing,
                chargedAmountPending: state.chargedAmountPending +
                    totalScaledAmount,
                notAfter: state.notAfter,
                finalizationTimestamp: state.finalizationTimestamp,
                lastChargeTimestamp: _getTimestampOffset(
                    state.notAfter,
                    chargeBatch.timestamp
                ),
                nonceAndFlags: _setNonce(state.nonceAndFlags, nonce)
            });
        }
        // TODO: Due to EIP-7702, this check is no longer reliable, we need to change it to check whether sender is EOA
        if (tx.origin == msg.sender) {
            // Calldata can be easily retrieved
            emit ChargesSettled();
        } else {
            emit ChargesSettledFromContract(abi.encode(chargeBatches));
        }
    }

    function dispute(Dispute[] calldata disputes) external {
        require(disputes.length > 0, InvalidBatchLength());
        for (uint256 i = 0; i < disputes.length; i++) {
            Dispute calldata d = disputes[i];
            require(d.amountToClawback > 0, InvalidClawbackAmount());
            ChargeBatch calldata chargeBatch = d.chargeBatch;
            bytes32 scopeHash = verifyChargeBatchSignature(chargeBatch);
            require(
                block.timestamp - chargeBatch.timestamp <
                    chargeBatch.scope.disputeWindow,
                DisputeWindowExpired()
            );
            require(
                chargeBatch.timestamp <= block.timestamp,
                FutureChargeBatch()
            );
            bytes32 digest = _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        keccak256(
                            "Dispute(bytes32 scopeHash,uint32 amountToClawback)"
                        ),
                        scopeHash,
                        d.amountToClawback
                    )
                )
            );
            require(
                universalSigValidator.isValidSig(
                    chargeBatch.scope.user,
                    digest,
                    d.signature
                ),
                InvalidDisputeSignature()
            );
            bytes32 disputeHash = keccak256(
                abi.encode(
                    chargeBatch.scope,
                    chargeBatch.entries,
                    chargeBatch.timestamp
                )
            );
            require(!disputedCharges[disputeHash], DisputeAlreadyExists());
            AuthorizationScopeState memory state = authorizationScopes[
                scopeHash
            ];

            // Validate nonces and calculate total amount in a single loop
            uint24 currentNonce = _getNonce(state.nonceAndFlags);
            uint32 totalChargedAmount = 0;
            uint24 expectedNonce = 0;
            for (uint256 j = 0; j < chargeBatch.entries.length; j++) {
                ChargeEntry memory entry = chargeBatch.entries[j];

                // Validate nonce: must be < current (already settled)
                require(entry.nonce < currentNonce, InvalidNonce());

                // Validate sequential nonces within batch
                if (j == 0) {
                    require(entry.nonce > 0, InvalidNonce());
                    expectedNonce = entry.nonce;
                } else {
                    require(entry.nonce == ++expectedNonce, InvalidNonce());
                }

                totalChargedAmount += entry.scaledAmount;
            }
            require(
                totalChargedAmount >= d.amountToClawback,
                ClawbackExceedsBatchTotal()
            );

            // Cascading deduction: chargedAmountWithdrawable cannot be clawed back (finalized)
            // Deduct from chargedAmountFinalizing first, then chargedAmountPending
            uint32 remaining = d.amountToClawback;
            uint32 newFinalizing = state.chargedAmountFinalizing;
            uint32 newPending = state.chargedAmountPending;

            // Deduct from finalizing first
            if (remaining > 0 && newFinalizing > 0) {
                uint32 fromFinalizing = remaining > newFinalizing
                    ? newFinalizing
                    : remaining;
                newFinalizing -= fromFinalizing;
                remaining -= fromFinalizing;
            }

            // Then deduct from pending
            if (remaining > 0 && newPending > 0) {
                uint32 fromPending = remaining > newPending
                    ? newPending
                    : remaining;
                newPending -= fromPending;
                remaining -= fromPending;
            }

            require(remaining == 0, InsufficientPendingBalance());

            state.chargedAmountFinalizing = newFinalizing;
            state.chargedAmountPending = newPending;
            state.notAfter = uint40(block.timestamp);
            authorizationScopes[scopeHash] = state;

            // Need to unscale the clawback amount for user balance
            AuthorizationScopeData memory scopeData = authorizationScopeData[
                scopeHash
            ];
            uint128 unscaledClawback = _unscaleAmount(
                d.amountToClawback,
                scopeData.amountGranularity
            );

            UserState storage userState = userStates[chargeBatch.scope.user];
            userState.balance += unscaledClawback;
            userState.numDisputes += 1;
            disputedCharges[disputeHash] = true;
            emit ChargeDisputed(
                chargeBatch.scope.user,
                chargeBatch.scope.agent,
                scopeHash,
                unscaledClawback
            );
        }
    }

    function _depositInternal(address user, uint256 amount) private {
        require(user != address(0), InvalidUserAddress());
        require(amount > 0, InvalidDepositAmount());
        gasToken.safeTransferFrom(user, address(this), amount);
        userStates[user].balance += amount;
        emit Deposit(user, amount);
    }

    function deposit(
        address user,
        uint256 amount,
        bytes calldata signature
    ) external nonReentrant {
        uint256 nonce = userStates[user].nonce;
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256(
                        "Deposit(address user,uint256 amount,uint256 nonce)"
                    ),
                    user,
                    amount,
                    nonce
                )
            )
        );
        require(
            universalSigValidator.isValidSig(user, digest, signature),
            InvalidDepositSignature()
        );
        userStates[user].nonce = nonce + 1;
        _depositInternal(user, amount);
    }

    function deposit(uint256 amount) external nonReentrant {
        address user = msg.sender;
        require(user != address(this), CannotDepositToSelf());
        _depositInternal(user, amount);
    }

    function balanceOf(address user) public view returns (uint256) {
        UserState storage userState = userStates[user];
        uint256 balance = userState.balance;
        for (
            uint256 i = 0;
            i < userState.authorizationScopeHashes.length;
            i++
        ) {
            bytes32 scopeHash = userState.authorizationScopeHashes[i];
            AuthorizationScopeState memory state = authorizationScopes[
                scopeHash
            ];
            AuthorizationScopeData memory scopeData = authorizationScopeData[
                scopeHash
            ];
            balance += _unscaleAmount(
                state.remainingAmount,
                scopeData.amountGranularity
            );
        }
        return balance;
    }

    function unlockedBalanceOf(address user) public view returns (uint256) {
        UserState storage userState = userStates[user];
        uint256 balance = userState.balance;
        for (
            uint256 i = 0;
            i < userState.authorizationScopeHashes.length;
            i++
        ) {
            bytes32 scopeHash = userState.authorizationScopeHashes[i];
            AuthorizationScopeState memory state = authorizationScopes[
                scopeHash
            ];
            if (block.timestamp < state.notAfter) {
                continue;
            }
            AuthorizationScopeData memory scopeData = authorizationScopeData[
                scopeHash
            ];
            balance += _unscaleAmount(
                state.remainingAmount,
                scopeData.amountGranularity
            );
        }
        return balance;
    }

    function getUserAuthorizationScopeHashes(
        address user
    ) public view returns (bytes32[] memory) {
        return userStates[user].authorizationScopeHashes;
    }

    // Public function for agent to directly withdraw funds
    function withdrawAgentChargedFund(
        AuthorizationScope calldata scope,
        bool toWallet
    ) external nonReentrant {
        bytes32 scopeHash = getScopeHash(scope);
        require(msg.sender == scope.agent, CallerNotAgent());
        _withdrawAgentChargedFundInternal(scope, scopeHash, toWallet);
    }

    // Public function for third-party to submit withdrawal with agent's signature
    function withdrawAgentChargedFund(
        AuthorizationScope calldata scope,
        bool toWallet,
        bytes calldata signature
    ) external nonReentrant {
        bytes32 scopeHash = getScopeHash(scope);
        uint256 nonce = userStates[scope.agent].nonce;

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256(
                        "WithdrawAgentChargedFund(bytes32 scopeHash,bool toWallet,uint256 nonce)"
                    ),
                    scopeHash,
                    toWallet,
                    nonce
                )
            )
        );

        require(
            universalSigValidator.isValidSig(scope.agent, digest, signature),
            InvalidWithdrawalSignature()
        );

        userStates[scope.agent].nonce = nonce + 1;
        _withdrawAgentChargedFundInternal(scope, scopeHash, toWallet);
    }

    // View function to get agent's pending amount for a scope
    function getAgentPendingAmount(
        AuthorizationScope calldata scope
    ) public view returns (uint128) {
        bytes32 scopeHash = getScopeHash(scope);
        AuthorizationScopeState memory state = authorizationScopes[scopeHash];
        uint32 totalScaled = state.chargedAmountPending +
            state.chargedAmountFinalizing;
        return _unscaleAmount(totalScaled, scope.amountGranularity);
    }

    // Internal core withdrawal logic
    function _withdrawAgentChargedFundInternal(
        AuthorizationScope calldata scope,
        bytes32 scopeHash,
        bool toWallet
    ) internal {
        AuthorizationScopeState memory state = authorizationScopes[scopeHash];

        // Update finalization state (moves amounts through pipeline)
        state = _updateFinalizationState(state, scope.disputeWindow);

        uint32 withdrawableScaled = state.chargedAmountWithdrawable;
        require(withdrawableScaled > 0, NoWithdrawableBalance());

        // Clear withdrawable amount
        state.chargedAmountWithdrawable = 0;

        // Unscale amount for transfer
        uint128 withdrawable = _unscaleAmount(
            withdrawableScaled,
            scope.amountGranularity
        );

        // Transfer or credit
        if (toWallet) {
            gasToken.safeTransfer(scope.agent, withdrawable);
        } else {
            userStates[scope.agent].balance += withdrawable;
        }
        authorizationScopes[scopeHash] = state;

        emit AgentWithdrawal(scope.agent, scopeHash, withdrawable, toWallet);
    }

    // View helper to get nonce from packed nonceAndFlags (lower 22 bits)
    function getScopeNonce(bytes32 scopeHash) public view returns (uint24) {
        return _getNonce(authorizationScopes[scopeHash].nonceAndFlags);
    }

    // View helper to get flags from nonceAndFlags (upper 2 bits)
    function getScopeFlags(bytes32 scopeHash) public view returns (uint24) {
        return authorizationScopes[scopeHash].nonceAndFlags & 0xC00000;
    }
}
