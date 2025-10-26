// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

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
    uint48 totalAmount;
    uint48 disputeWindow; // in seconds
    address agent;
    uint48 notBefore;
    uint48 notAfter;
}

// NOTE: Keep size of the struct under 256 bits
struct AuthorizationScopeState {
    uint48 remainingAmount;
    uint48 agentPendingAmount;
    uint24 nonce;
    uint24 withdrawalNonce; // Tracks the last charge nonce that has been withdrawn
    uint48 notAfter;
    uint48 lastChargeTimestamp;
    uint8 isNumChargesRecorded;
}

struct ChargeEntry {
    uint48 amount;
    uint48 nonce; // TODO: Change to uint24 to match AuthorizationScopeState.nonce, update all signature-related code, and remove type casting
    uint48 notAfter;
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
    uint48 timestamp;
    bytes agentSignature; // Signature of keccak256(abi.encode(constructed ChargeBatchVerifier))
}

struct UserState {
    uint256 balance;
    uint256 numCharges;
    uint256 numDisputes;
    uint256 nonce;
    bytes32[] authorizationScopeHashes;
}

struct Dispute {
    ChargeBatch chargeBatch;
    uint48 amountToClawback;
    bytes signature;
}

contract ZeroLC is
    EIP712,
    ReentrancyGuardUpgradeable,
    OwnableUpgradeable,
    AccessControlUpgradeable
{
    using SafeERC20 for IERC20;

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
    mapping(bytes32 => bool) public disputedCharges;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(
        address _gasToken,
        address _universalSigValidator
    ) EIP712("ZeroLC", "1") {
        require(_gasToken != address(0), "Invalid gas token address");
        require(
            _universalSigValidator != address(0),
            "Invalid universal sig validator address"
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
            if (uint48(block.timestamp) < state.notAfter || state.nonce == 0) {
                i++;
                continue;
            }
            if (state.remainingAmount > 0) {
                balance += state.remainingAmount;
                state.remainingAmount = 0;
            }
            if (state.isNumChargesRecorded == 0) {
                numCharges += state.nonce - 1;
                state.isNumChargesRecorded = 1;
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
                        "AuthorizationScope(address user,uint48 totalAmount,uint48 disputeWindow,address agent,uint48 notBefore,uint48 notAfter)"
                    ),
                    scope.user,
                    scope.totalAmount,
                    scope.disputeWindow,
                    scope.agent,
                    scope.notBefore,
                    scope.notAfter
                )
            )
        );
        require(
            universalSigValidator.isValidSig(scope.user, digest, signature),
            "Invalid scope signature"
        );
        require(
            block.timestamp < scope.notAfter,
            "Authorization scope expired"
        );
        require(
            scope.notBefore <= block.timestamp,
            "Authorization scope not yet active"
        );
        require(
            scope.totalAmount > 0,
            "Authorization scope total amount must be greater than 0"
        );
        require(
            scope.disputeWindow > 0,
            "Authorization scope dispute window must be greater than 0"
        );
        require(
            scope.agent != address(0),
            "Authorization scope agent address must be non-zero"
        );
        require(scope.user != scope.agent, "User cannot be their own agent");
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
        require(scope.totalAmount <= userState.balance, "Insufficient balance");
        bytes32 scopeHash = getScopeHash(scope);
        require(
            authorizationScopes[scopeHash].notAfter == 0,
            "Authorization scope already registered"
        );
        authorizationScopes[scopeHash] = AuthorizationScopeState({
            remainingAmount: scope.totalAmount,
            agentPendingAmount: 0,
            nonce: 1,
            withdrawalNonce: 0,
            notAfter: scope.notAfter,
            lastChargeTimestamp: 0,
            isNumChargesRecorded: 0
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
            "Invalid scope signature"
        );
        uint48 newNotAfter = uint48(block.timestamp) + 300;
        AuthorizationScopeState memory state = authorizationScopes[scopeHash];
        require(
            state.notAfter > newNotAfter,
            "Authorization scope is not active"
        );
        require(
            state.remainingAmount > 0,
            "Authorization scope is already exhausted"
        );
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
        require(numCharges > 0, "No charges in batch");
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
            "Invalid signature"
        );
    }

    function settleCharges(ChargeBatch[] calldata chargeBatches) external {
        require(chargeBatches.length > 0, "Invalid batch length");
        for (uint256 i = 0; i < chargeBatches.length; i++) {
            ChargeBatch calldata chargeBatch = chargeBatches[i];
            bytes32 scopeHash = verifyChargeBatchSignature(chargeBatch);
            require(
                chargeBatch.timestamp > block.timestamp - 60 &&
                    chargeBatch.timestamp <= block.timestamp,
                "Invalid batch timestamp (must be within 1 minute)"
            );
            AuthorizationScopeState memory state = authorizationScopes[
                scopeHash
            ];
            require(
                block.timestamp < state.notAfter,
                "Authorization scope expired"
            );
            require(
                chargeBatch.timestamp > state.lastChargeTimestamp,
                "Invalid batch timestamp (must be greater than last charge timestamp)"
            );
            uint48 totalAmount = 0;
            uint24 nonce = state.nonce;
            for (uint256 j = 0; j < chargeBatch.entries.length; j++) {
                ChargeEntry memory entry = chargeBatch.entries[j];
                require(entry.nonce == nonce, "Invalid nonce");
                require(
                    block.timestamp < entry.notAfter,
                    "Charge entry expired"
                );
                require(
                    entry.amount > 0,
                    "Charge amount must be greater than 0"
                );
                totalAmount += entry.amount;
                nonce += 1;
            }
            uint48 remainingAmount = state.remainingAmount;
            require(totalAmount <= remainingAmount, "Insufficient balance");
            authorizationScopes[scopeHash] = AuthorizationScopeState({
                remainingAmount: remainingAmount - totalAmount,
                agentPendingAmount: state.agentPendingAmount + totalAmount,
                nonce: nonce,
                withdrawalNonce: state.withdrawalNonce,
                notAfter: state.notAfter,
                lastChargeTimestamp: chargeBatch.timestamp,
                isNumChargesRecorded: state.isNumChargesRecorded
            });
        }
        if (tx.origin == msg.sender) {
            // Calldata can be easily retrieved
            emit ChargesSettled();
        } else {
            emit ChargesSettledFromContract(abi.encode(chargeBatches));
        }
    }

    function dispute(Dispute[] calldata disputes) external {
        require(disputes.length > 0, "Invalid batch length");
        for (uint256 i = 0; i < disputes.length; i++) {
            Dispute calldata d = disputes[i];
            require(d.amountToClawback > 0, "Invalid amount to clawback");
            ChargeBatch calldata chargeBatch = d.chargeBatch;
            bytes32 scopeHash = verifyChargeBatchSignature(chargeBatch);
            require(
                block.timestamp - chargeBatch.timestamp <
                    chargeBatch.scope.disputeWindow,
                "Dispute window expired"
            );
            require(
                chargeBatch.timestamp <= block.timestamp,
                "Future charge batch"
            );
            bytes32 digest = _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        keccak256(
                            "Dispute(bytes32 scopeHash,uint48 amountToClawback)"
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
                "Invalid dispute signature"
            );
            uint48 totalChargedAmount = 0;
            for (uint256 j = 0; j < chargeBatch.entries.length; j++) {
                ChargeEntry memory entry = chargeBatch.entries[j];
                totalChargedAmount += entry.amount;
            }
            require(
                totalChargedAmount >= d.amountToClawback,
                "amountToClawback must be less than total charged amount in the batch"
            );
            bytes32 disputeHash = keccak256(
                abi.encode(
                    chargeBatch.scope,
                    chargeBatch.entries,
                    chargeBatch.timestamp
                )
            );
            require(!disputedCharges[disputeHash], "Dispute already exists");
            AuthorizationScopeState memory state = authorizationScopes[
                scopeHash
            ];
            require(
                state.agentPendingAmount >= d.amountToClawback,
                "UNEXPECTED: No balance to clawback"
            );
            state.agentPendingAmount -= d.amountToClawback;
            state.notAfter = uint48(block.timestamp);
            authorizationScopes[scopeHash] = state;
            UserState storage userState = userStates[chargeBatch.scope.user];
            userState.balance += d.amountToClawback;
            userState.numDisputes += 1;
            disputedCharges[disputeHash] = true;
            emit ChargeDisputed(
                chargeBatch.scope.user,
                chargeBatch.scope.agent,
                scopeHash,
                d.amountToClawback
            );
        }
    }

    function _depositInternal(address user, uint256 amount) private {
        require(user != address(0), "Invalid user address");
        require(amount > 0, "Deposit amount must be greater than zero");
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
                    keccak256("Deposit(address user,uint256 amount,uint256 nonce)"),
                    user,
                    amount,
                    nonce
                )
            )
        );
        require(
            universalSigValidator.isValidSig(user, digest, signature),
            "Invalid deposit signature"
        );
        userStates[user].nonce = nonce + 1;
        _depositInternal(user, amount);
    }

    function deposit(uint256 amount) external nonReentrant {
        address user = msg.sender;
        require(user != address(this), "Cannot deposit to self");
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
            balance += state.remainingAmount;
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
            balance += state.remainingAmount;
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
        bool toWallet,
        ChargeBatch[] calldata recentCharges
    ) external nonReentrant {
        bytes32 scopeHash = getScopeHash(scope);
        require(msg.sender == scope.agent, "Caller is not the agent");
        _withdrawAgentChargedFundInternal(scope, scopeHash, toWallet, recentCharges);
    }

    // Public function for third-party to submit withdrawal with agent's signature
    function withdrawAgentChargedFund(
        AuthorizationScope calldata scope,
        bool toWallet,
        ChargeBatch[] calldata recentCharges,
        bytes calldata signature
    ) external nonReentrant {
        bytes32 scopeHash = getScopeHash(scope);
        bytes32 recentChargesHash = keccak256(abi.encode(recentCharges));
        uint256 nonce = userStates[scope.agent].nonce;

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    keccak256("WithdrawAgentChargedFund(bytes32 scopeHash,bool toWallet,bytes32 recentChargesHash,uint256 nonce)"),
                    scopeHash,
                    toWallet,
                    recentChargesHash,
                    nonce
                )
            )
        );

        require(
            universalSigValidator.isValidSig(scope.agent, digest, signature),
            "Invalid withdrawal signature"
        );

        userStates[scope.agent].nonce = nonce + 1;
        _withdrawAgentChargedFundInternal(scope, scopeHash, toWallet, recentCharges);
    }

    // View function to get withdrawable amount using simple method
    function getWithdrawableAmountSimple(
        AuthorizationScope calldata scope
    ) public view returns (uint48) {
        bytes32 scopeHash = getScopeHash(scope);
        return _calculateWithdrawableSimple(scopeHash, scope.disputeWindow);
    }

    // View function to get withdrawable amount using detailed method
    function getWithdrawableAmountDetailed(
        AuthorizationScope calldata scope,
        ChargeBatch[] calldata recentCharges
    ) public view returns (uint48) {
        bytes32 scopeHash = getScopeHash(scope);
        AuthorizationScopeState memory state = authorizationScopes[scopeHash];
        (uint48 withdrawable, ) = _calculateWithdrawableDetailed(
            scopeHash,
            scope,
            recentCharges,
            state.withdrawalNonce
        );
        return withdrawable;
    }

    // View function to get agent's pending amount for a scope
    function getAgentPendingAmount(
        AuthorizationScope calldata scope
    ) public view returns (uint48) {
        bytes32 scopeHash = getScopeHash(scope);
        return authorizationScopes[scopeHash].agentPendingAmount;
    }

    // View function to get agent's withdrawal nonce for a scope
    function getAgentWithdrawalNonce(
        AuthorizationScope calldata scope
    ) public view returns (uint24) {
        bytes32 scopeHash = getScopeHash(scope);
        return authorizationScopes[scopeHash].withdrawalNonce;
    }

    // Internal helper function for simple withdrawal calculation
    function _calculateWithdrawableSimple(
        bytes32 scopeHash,
        uint48 disputeWindow
    ) internal view returns (uint48) {
        AuthorizationScopeState memory state = authorizationScopes[scopeHash];

        // If last charge is outside dispute window, all pending is withdrawable
        if (block.timestamp >= state.lastChargeTimestamp + disputeWindow) {
            return state.agentPendingAmount;
        }
        return 0; // Conservative: nothing withdrawable if any charge in window
    }

    // Internal helper function for detailed withdrawal calculation
    function _calculateWithdrawableDetailed(
        bytes32 scopeHash,
        AuthorizationScope calldata scope,
        ChargeBatch[] calldata recentCharges,
        uint24 currentWithdrawalNonce
    ) internal view returns (uint48 withdrawable, uint24 newWithdrawalNonce) {
        AuthorizationScopeState memory state = authorizationScopes[scopeHash];

        uint48 totalWithdrawableCharges = 0;
        uint24 expectedNonce = currentWithdrawalNonce + 1;
        uint24 highestNonce = currentWithdrawalNonce;

        // Process all provided charge batches and verify they are past dispute window
        for (uint256 i = 0; i < recentCharges.length; i++) {
            ChargeBatch calldata batch = recentCharges[i];

            // Verify charge batch signature
            verifyChargeBatchSignature(batch);

            // Verify batch scope matches
            require(getScopeHash(batch.scope) == scopeHash, "Scope mismatch");

            // Verify batch timestamp is valid (not in future)
            require(batch.timestamp <= block.timestamp, "Future charge batch");

            // Reject if this batch is still within dispute window
            require(
                batch.timestamp <= block.timestamp - scope.disputeWindow,
                "Charge batch still in dispute window"
            );

            // Process each entry in the batch
            for (uint256 j = 0; j < batch.entries.length; j++) {
                ChargeEntry memory entry = batch.entries[j];
                uint24 entryNonce = uint24(entry.nonce);

                // Verify nonce continuity - must be sequential with no gaps
                require(entryNonce == expectedNonce, "Non-continuous nonce sequence");

                totalWithdrawableCharges += entry.amount;

                expectedNonce++;
                if (entryNonce > highestNonce) {
                    highestNonce = entryNonce;
                }
            }
        }

        // Verify that total provided charges don't exceed pending amount
        require(
            totalWithdrawableCharges <= state.agentPendingAmount,
            "Provided charges exceed pending amount"
        );

        // All provided charges are withdrawable (since all are past dispute window)
        withdrawable = totalWithdrawableCharges;
        newWithdrawalNonce = highestNonce;

        return (withdrawable, newWithdrawalNonce);
    }

    // Internal core withdrawal logic
    function _withdrawAgentChargedFundInternal(
        AuthorizationScope calldata scope,
        bytes32 scopeHash,
        bool toWallet,
        ChargeBatch[] calldata recentCharges
    ) internal {
        AuthorizationScopeState storage state = authorizationScopes[scopeHash];

        // Calculate withdrawable amount
        uint48 withdrawable;
        uint24 newWithdrawalNonce = state.withdrawalNonce;

        if (recentCharges.length == 0) {
            withdrawable = _calculateWithdrawableSimple(scopeHash, scope.disputeWindow);
            // Simple method: update withdrawalNonce to current nonce - 1
            // (all charges up to nonce-1 are considered withdrawn)
            newWithdrawalNonce = state.nonce - 1;
        } else {
            (withdrawable, newWithdrawalNonce) = _calculateWithdrawableDetailed(
                scopeHash,
                scope,
                recentCharges,
                state.withdrawalNonce
            );
        }

        require(withdrawable > 0, "No withdrawable balance");

        // Update state
        state.agentPendingAmount -= withdrawable;
        state.withdrawalNonce = newWithdrawalNonce;

        // Transfer or credit
        if (toWallet) {
            gasToken.safeTransfer(scope.agent, withdrawable);
        } else {
            userStates[scope.agent].balance += withdrawable;
        }

        emit AgentWithdrawal(scope.agent, scopeHash, withdrawable, toWallet);
    }
}
