# ZeroLC Contract - Comprehensive Test Plan

This document outlines all tests needed to comprehensively cover the ZeroLC contract, including edge cases and security scenarios.

## Test Coverage Goals
- **200+ test cases** covering all functions and edge cases
- Boundary conditions on all numeric and time-based checks
- Signature verification for EOA and smart contract wallets (ERC-1271, ERC-6492)
- Reentrancy protection validation
- Integer overflow/underflow scenarios
- Complex multi-user, multi-agent scenarios
- Security vulnerabilities and attack vectors

---

## 1. Constructor & Initialization Tests

- [ ] Constructor with valid gas token address and valid universal sig validator address
- [ ] Constructor with zero gas token address (should revert)
- [ ] Constructor with zero universal sig validator address (should revert)
- [ ] Initialize function sets correct owner and roles
- [ ] Cannot initialize twice (reinitializer protection)
- [ ] Cannot call initialize on implementation contract
- [ ] Domain separator is correct ("ZeroLC", "1")
- [ ] Domain separator is chain-specific
- [ ] Immutable gasToken reference is set correctly
- [ ] Immutable universalSigValidator reference is set correctly

---

## 2. Deposit Tests

### 2.1 Direct Deposit (no signature)

- [x] Deposit with valid amount increases user balance
- [x] Deposit with zero amount (should revert)
- [x] Deposit with insufficient token balance (should revert)
- [x] Deposit with insufficient allowance (should revert)
- [x] Deposit emits correct Deposit event
- [x] Reentrancy attack on deposit (should be blocked)
- [x] Multiple consecutive deposits accumulate correctly

### 2.2 Deposit with Signature

- [x] Deposit with valid signature from EOA
- [x] Deposit emits correct event when using signature
- [x] Third party can submit deposit with valid signature
- [x] Deposit with valid ERC-1271 signature from smart contract wallet
- [x] Deposit with invalid ERC-1271 signature (should revert)
- [x] Deposit with invalid signature (should revert)
- [x] Deposit with signature from wrong signer (should revert)
- [x] Deposit with malformed signature (should revert)
- [x] Deposit with signature for different amount (should revert)
- [x] Deposit with signature for different user (should revert)
- [x] Deposit with ERC-6492 counterfactual signature
- [x] Reentrancy attack on signed deposit (should be blocked)
- [x] Deposit to zero address (should revert)
- [x] Deposit signature has correct EIP712 type hash (includes nonce)
- [x] Deposit signature with wrong domain name (should revert)
- [x] Deposit signature with wrong domain version (should revert)
- [x] Nonce increments after successful deposit
- [x] Replay attack prevention - reused signature rejected
- [x] Sequential deposits with incrementing nonces work correctly
- [x] Signature with future nonce rejected
- [x] Signature with old nonce rejected

### 2.3 Gas Token Integration

- [x] SafeERC20 transfer protection works
- [x] Transfer with non-standard ERC20 (no return value)
- [x] Transfer with reverting token
- [x] Transfer with token that returns false
- [x] Allowance checks work correctly
- [x] Token balance checks work correctly
- [x] Token with non-standard decimals (6 decimals like USDC)
  - [x] Basic deposit with 6-decimal token
  - [x] Multiple deposits with 6-decimal token
  - [x] Fractional amounts with 6 decimals

---

## 3. Authorization Scope Registration Tests

### 3.1 Valid Registration

- [x] Register scope with valid signature and sufficient balance
- [x] Register scope with EOA signature
- [x] Register scope with ERC-1271 smart wallet signature
- [x] Register scope with ERC-6492 counterfactual signature
- [x] Register scope triggers auto-deposit when balance insufficient but allowance exists
- [x] Register scope emits AuthorizationScopeRegistered event
- [x] Register scope updates user state correctly
- [x] Register scope updates agent state correctly
- [x] Register scope updates authorizationScopes mapping correctly
- [x] Register multiple scopes for same user
- [x] Register multiple scopes for same agent
- [x] Register scope updates user balance correctly (subtracts totalAmount)
- [x] Register same scope twice (should revert with "Authorization scope already registered")

### 3.2 Edge Cases & Failures

- [x] Register scope with insufficient balance and no allowance (should revert)
- [x] Register scope with invalid signature (should revert)
- [x] Register scope with expired notAfter (should revert)
- [x] Register scope with notBefore in future (should revert)
- [x] Register scope with zero totalAmount (should revert)
- [x] Register scope with zero disputeWindow (should revert)
- [x] Register scope with zero agent address (should revert)
- [x] Register scope where user == agent (should revert)
- [x] Register duplicate scope hash (should revert) - covered in 3.1
- [x] Register scope at exact notBefore timestamp (boundary)
- [x] Register scope at notAfter - 1 second (boundary)
- [x] Register scope with totalAmount == balance (exact match)
- [x] Register scope with totalAmount > balance by 1 wei (should revert without allowance)
- [x] Reentrancy attack during registration (should be blocked)

### 3.3 EIP712 Signature Verification

- [x] Signature includes all fields: user, totalAmount, disputeWindow, agent, notBefore, notAfter
- [x] Signature verification with tampered user address fails
- [x] Signature verification with tampered totalAmount fails
- [x] Signature verification with tampered disputeWindow fails
- [x] Signature verification with tampered agent fails
- [x] Signature verification with tampered notBefore fails
- [x] Signature verification with tampered notAfter fails

### 3.4 Auto-Deposit Logic

- [ ] Auto-deposit when balance < totalAmount and allowance sufficient
- [ ] No auto-deposit when balance < totalAmount but allowance insufficient
- [ ] No auto-deposit when balance < totalAmount but token balance insufficient
- [ ] Auto-deposit deposits exact amount needed (totalAmount - balance)

### 3.5 Scope Hash Calculation

- [ ] getScopeHash returns consistent hash for same scope
- [ ] getScopeHash returns different hash for different scopes
- [ ] Scope hash includes domain separator
- [ ] Scope hash uniquely identifies scope

---

## 4. Authorization Scope Revocation Tests

- [ ] Revoke scope with valid signature
- [ ] Revoke scope sets notAfter to block.timestamp + 300
- [ ] Revoke scope with invalid signature (should revert)
- [ ] Revoke already expired scope (should revert)
- [ ] Revoke scope with remainingAmount == 0 (should revert)
- [ ] Revoke scope with newNotAfter >= current notAfter (should revert)
- [ ] Revoke scope at exact boundary (notAfter == newNotAfter + 1)
- [ ] Revoke scope emits AuthorizationScopeRevoking event
- [ ] Revoke scope twice (second should fail)
- [ ] Revoke scope after partial charges
- [ ] Revoke scope with valid ERC-1271 signature
- [ ] Revoke scope maintains remainingAmount correctly
- [ ] Revoke scope maintains agentPendingAmount correctly
- [ ] Reentrancy attack on revocation (should be blocked)

---

## 5. Charge Settlement Tests

### 5.1 Valid Settlement

- [ ] Settle single charge batch with one entry
- [ ] Settle single charge batch with multiple entries
- [ ] Settle multiple charge batches in one transaction
- [ ] Settle charges with sequential nonces
- [ ] Settle charges updates remainingAmount correctly
- [ ] Settle charges updates agentPendingAmount correctly
- [ ] Settle charges updates lastChargeTimestamp correctly
- [ ] Settle charges updates nonce correctly (increments by number of entries)
- [ ] Settle charges emits ChargesSettled() event when tx.origin == msg.sender
- [ ] Settle charges emits ChargesSettled(bytes) event when contract caller
- [ ] Settle charges maintains isNumChargesRecorded flag

### 5.2 Signature Verification

- [ ] Settle with valid agent ECDSA signature
- [ ] Settle with invalid agent signature (should revert)
- [ ] Settle with wrong agent signing (should revert)
- [ ] Settle with single entry (batchPartHash == 0x00)
- [ ] Settle with multiple entries (batchPartHash verified)
- [ ] Settle with tampered batchPartHash (should revert)
- [ ] Settle with tampered lastEntry (should revert)
- [ ] Settle with tampered scopeHash (should revert)
- [ ] Signature uses correct verifier struct encoding

### 5.3 Timestamp Validation

- [ ] Settle with timestamp within valid 60-second window
- [ ] Settle with timestamp == block.timestamp - 60 (boundary, should revert)
- [ ] Settle with timestamp == block.timestamp - 59 (boundary, should pass)
- [ ] Settle with timestamp == block.timestamp (boundary, should pass)
- [ ] Settle with timestamp < block.timestamp - 60 (should revert)
- [ ] Settle with timestamp > block.timestamp (should revert)
- [ ] Settle with timestamp <= lastChargeTimestamp (should revert)
- [ ] Settle with timestamp == lastChargeTimestamp + 1 (boundary)
- [ ] Settle multiple batches with increasing timestamps

### 5.4 Nonce Validation

- [ ] Settle with correct sequential nonces starting from 1
- [ ] Settle with wrong nonce (should revert)
- [ ] Settle with skipped nonce (should revert)
- [ ] Settle with repeated nonce (should revert)
- [ ] Settle multiple batches incrementing nonces correctly
- [ ] Nonce persists across multiple settlements
- [ ] Nonce starts at 1 for new scope

### 5.5 Amount & Balance

- [ ] Settle with totalAmount < remainingAmount
- [ ] Settle with totalAmount == remainingAmount (exact drain)
- [ ] Settle with totalAmount > remainingAmount (should revert)
- [ ] Settle with zero amount entries (should revert)
- [ ] Settle with uint48 max amount (overflow check)
- [ ] Settle causing totalAmount overflow (should revert)
- [ ] All entries must have amount > 0

### 5.6 Entry Expiration

- [ ] Settle with entry.notAfter > block.timestamp (valid, not expired)
- [ ] Settle with entry.notAfter == block.timestamp (boundary, valid)
- [ ] Settle with entry.notAfter < block.timestamp (should revert, expired)
- [ ] Multiple entries with different notAfter values

### 5.7 Scope Status

- [ ] Settle with active scope (notAfter > block.timestamp)
- [ ] Settle with expired scope (should revert)
- [ ] Settle with scope notAfter == block.timestamp (should revert)
- [ ] Settle with scope notAfter == block.timestamp + 1 (boundary, should pass)

### 5.8 Empty Batch Validation

- [ ] Settle with empty chargeBatches array (should revert)
- [ ] Settle with batch containing empty entries array (should revert)
- [ ] verifyChargeBatchSignature validates non-empty entries

---

## 6. Dispute Tests

### 6.1 Valid Disputes

- [ ] Dispute valid charge batch within dispute window
- [ ] Dispute with partial clawback amount
- [ ] Dispute with full clawback amount (amountToClawback == totalChargedAmount)
- [ ] Dispute with valid user EOA signature
- [ ] Dispute with valid ERC-1271 signature from smart wallet
- [ ] Dispute updates agentPendingAmount correctly (decreases)
- [ ] Dispute updates user balance correctly (increases)
- [ ] Dispute sets scope notAfter to block.timestamp
- [ ] Dispute increments numDisputes counter
- [ ] Dispute emits ChargeDisputed event with correct parameters
- [ ] Multiple disputes in single transaction (different batches)

### 6.2 Dispute Window

- [ ] Dispute within valid dispute window
- [ ] Dispute at exact disputeWindow boundary (block.timestamp - timestamp == disputeWindow - 1)
- [ ] Dispute after dispute window expires (should revert)
- [ ] Dispute with very short dispute window (1 second)
- [ ] Dispute with very long dispute window (uint48 max)
- [ ] Dispute window calculation with timestamp edge cases

### 6.3 Signature Validation

- [ ] Dispute with invalid user signature (should revert)
- [ ] Dispute with wrong signer (should revert)
- [ ] Dispute with tampered amountToClawback (should revert)
- [ ] Dispute with tampered scopeHash (should revert)
- [ ] Dispute signature uses correct EIP712 type hash
- [ ] Dispute with ERC-6492 signature

### 6.4 Amount Validation

- [ ] Dispute with amountToClawback < totalChargedAmount
- [ ] Dispute with amountToClawback == totalChargedAmount (boundary)
- [ ] Dispute with amountToClawback > totalChargedAmount (should revert)
- [ ] Dispute with amountToClawback > agentPendingAmount (should revert)
- [ ] Dispute with zero amountToClawback
- [ ] Dispute calculates totalChargedAmount correctly from entries

### 6.5 Duplicate Disputes

- [ ] Dispute same charge batch twice (second should revert)
- [ ] Dispute hash calculation is unique per batch
- [ ] Dispute hash includes scope, entries, and timestamp
- [ ] Different batches have different dispute hashes

### 6.6 Agent Signature Verification

- [ ] Dispute verifies agent signature on charge batch
- [ ] Dispute with invalid agent signature (should revert during verification)
- [ ] Dispute validates charge batch signature before processing

### 6.7 Timestamp Validation

- [ ] Dispute with future charge batch timestamp (should revert)
- [ ] Dispute with timestamp == block.timestamp (boundary)
- [ ] Dispute validates timestamp <= block.timestamp

### 6.8 Empty Batch Validation

- [ ] Dispute with empty disputes array (should revert)
- [ ] Dispute verifies non-empty charge batch entries

---

## 7. Balance View Functions

### 7.1 balanceOf

- [ ] balanceOf returns correct total (balance + all remainingAmounts)
- [ ] balanceOf with no scopes (returns only balance)
- [ ] balanceOf with multiple active scopes
- [ ] balanceOf with expired scopes (includes expired scope amounts)
- [ ] balanceOf after partial settlements
- [ ] balanceOf after deposits
- [ ] balanceOf after disputes
- [ ] balanceOf for zero address
- [ ] balanceOf for address with no state

### 7.2 unlockedBalanceOf

- [ ] unlockedBalanceOf returns balance + expired scope amounts only
- [ ] unlockedBalanceOf with no scopes
- [ ] unlockedBalanceOf with all active scopes (returns only balance)
- [ ] unlockedBalanceOf with all expired scopes
- [ ] unlockedBalanceOf with mixed active/expired scopes
- [ ] unlockedBalanceOf at exact expiration boundary (notAfter == block.timestamp)
- [ ] unlockedBalanceOf after compaction
- [ ] unlockedBalanceOf for zero address
- [ ] unlockedBalanceOf for address with no state

---

## 8. Compact User Authorization States

### 8.1 Compaction Logic

- [ ] Compact with expired scopes returns remainingAmount to balance
- [ ] Compact updates numCharges from nonce (nonce - 1)
- [ ] Compact sets isNumChargesRecorded flag to 1
- [ ] Compact removes expired scopes from array
- [ ] Compact handles empty scope array
- [ ] Compact called during registerAuthorizationScope
- [ ] Compact with multiple expired scopes
- [ ] Compact with no expired scopes (no changes)
- [ ] Compact doesn't affect active scopes
- [ ] Compact with scope where nonce == 0 (skipped, uninitialized)
- [ ] Compact at exact expiration boundary (notAfter == block.timestamp, should skip)
- [ ] Compact with scope where remainingAmount == 0
- [ ] Compact only records numCharges once (isNumChargesRecorded prevents duplicate)

### 8.2 Array Manipulation

- [ ] Compact correctly removes and packs array (swap with last, then pop)
- [ ] Compact handles single element array
- [ ] Compact handles last element removal
- [ ] Compact handles first element removal
- [ ] Compact handles middle element removal
- [ ] Compact with all scopes expired (empties array)
- [ ] Array length decreases correctly
- [ ] Loop index decrements correctly after removal (i--)

### 8.3 State Updates

- [ ] Compact updates userState.balance in storage
- [ ] Compact updates userState.numCharges in storage
- [ ] Compact clears remainingAmount in authorizationScopes
- [ ] Compact preserves other scope state (agentPendingAmount, notAfter, etc.)

---

## 9. Access Control Tests

- [ ] Owner set correctly on initialization
- [ ] DEFAULT_ADMIN_ROLE granted to deployer
- [ ] ROLE_OPERATOR role defined correctly
- [ ] Can grant ROLE_OPERATOR to other addresses
- [ ] Can revoke ROLE_OPERATOR from addresses
- [ ] Admin can manage roles correctly

---

## 10. Reentrancy Protection Tests

- [ ] Reentrancy on deposit (should be blocked)
- [ ] Reentrancy on deposit with signature (should be blocked)
- [ ] Reentrancy on registerAuthorizationScope (should be blocked)
- [ ] Reentrancy on revokeAuthorizationScope (should be blocked)
- [ ] No reentrancy guard on settleCharges (intentional, verify safe)
- [ ] No reentrancy guard on dispute (intentional, verify safe)
- [ ] View functions have no reentrancy issues

---

## 11. Integer Overflow/Underflow Tests

- [ ] uint48 casting doesn't overflow in AuthorizationScopeState
- [ ] Addition overflow in totalAmount calculation (should revert)
- [ ] Subtraction underflow in remainingAmount (should revert)
- [ ] Balance arithmetic overflow (adding deposits)
- [ ] Nonce increment to max uint48
- [ ] Timestamp calculations don't overflow
- [ ] agentPendingAmount addition doesn't overflow
- [ ] User balance increase in dispute doesn't overflow

---

## 12. EIP712 Tests

- [x] Domain separator correct ("ZeroLC", "1")
- [x] Domain separator is chain-specific
- [ ] getScopeHash produces correct hash
- [ ] AuthorizationScope type hash includes all fields
- [x] Deposit type hash is correct (includes nonce: `Deposit(address user,uint256 amount,uint256 nonce)`)
- [ ] RevokeAuthorizationScope type hash is correct
- [ ] Dispute type hash is correct

---

## 13. Struct Packing Tests

- [ ] AuthorizationScopeState stays under 256 bits
- [ ] uint48 boundary values work (max: 281474976710655)
- [ ] All timestamp fields near year 2038 (uint48 safe until ~8921556 AD)
- [ ] Struct packing optimizes gas usage

---

## 14. Event Emission Tests

- [ ] Deposit event emits with correct parameters
- [ ] Withdrawal event defined (for future use)
- [ ] AuthorizationScopeRegistered emits with correct indexed parameters
- [ ] AuthorizationScopeRevoking emits with correct indexed parameters
- [ ] ChargeDisputed emits with correct indexed parameters
- [ ] ChargesSettled() emitted when tx.origin == msg.sender
- [ ] ChargesSettled(bytes) emitted when tx.origin != msg.sender
- [ ] All indexed parameters are correctly indexed
- [ ] Event data can be parsed correctly

---

## 15. Integration & Complex Scenarios

### 15.1 Complete Lifecycles

- [ ] Full lifecycle: deposit → register → settle → no dispute
- [ ] Full lifecycle: deposit → register → settle → dispute → clawback
- [ ] Full lifecycle: deposit → register → revoke → wait → compact
- [ ] Full lifecycle: deposit → register → settle fully → compact
- [ ] Multiple scopes for single user lifecycle

### 15.2 Multi-User/Multi-Agent

- [ ] Multiple users with multiple agents
- [ ] Multiple agents with multiple users
- [ ] Same agent for different users
- [ ] Same user with different agents
- [ ] Concurrent operations on different scopes
- [ ] Isolation between different user scopes

### 15.3 Edge Timing Scenarios

- [ ] Scope expiration during active settlement attempts (should fail)
- [ ] Race condition: revoke vs settle (revoke shortens window)
- [ ] Race condition: dispute vs new settle (dispute ends scope)
- [ ] Multiple settlements rapidly increasing nonce
- [ ] Settle right before scope expiration
- [ ] Dispute right before dispute window closes

### 15.4 Complex State Scenarios

- [ ] User with 10+ active scopes
- [ ] User with mix of active and expired scopes
- [ ] Compact with 10+ expired scopes
- [ ] Agent with 10+ scopes from different users
- [ ] Scope fully drained then disputed
- [ ] Multiple disputes on same scope (different batches)

---

## 16. Security Tests

### 16.1 Signature Attacks

- [x] Signature replay attacks prevented (nonce-based for deposits)
- [ ] Signature replay attacks prevented (different scopes)
- [x] Signature replay across chains prevented (domain separator)
- [ ] Signature malleability attacks
- [ ] Front-running signature submission
- [ ] Signature expiration (via scope expiration)
- [x] Deposit signature replay attack with same nonce (prevented)
- [x] Deposit signature with future nonce (prevented)
- [x] Deposit signature with old nonce (prevented)

### 16.2 Economic Attacks

- [ ] Front-running disputes to prevent settlement
- [ ] Malicious agent submitting invalid charges (signature prevents)
- [ ] User attempting to dispute non-existent charges (verification prevents)
- [ ] Agent draining scope then user disputes
- [ ] User revoking scope with pending settlements

### 16.3 Timestamp Manipulation

- [ ] Miner timestamp manipulation for settlements (60 second window limits impact)
- [ ] Future timestamp in charge batch rejected
- [ ] Very old timestamp in charge batch rejected
- [ ] Timestamp manipulation in disputes

### 16.4 Other Attacks

- [ ] Self-dealing (user == agent) prevented
- [ ] Zero address attacks prevented
- [ ] Integer overflow attacks prevented
- [ ] Reentrancy attacks prevented
- [ ] Griefing attacks (excessive gas usage)

---

## 17. Gas Optimization Validation

- [ ] Batch settling saves gas vs individual settlements
- [ ] Compact state reduces long-term storage costs
- [ ] View functions are gas-efficient
- [ ] Event emission choice (with/without data) optimizes gas
- [ ] Struct packing reduces storage costs

---

## 18. Edge Cases & Boundary Conditions

### 18.1 Numeric Boundaries

- [ ] uint48 max value for amounts
- [ ] uint48 max value for timestamps
- [ ] Zero values where allowed
- [ ] One wei amounts
- [ ] Maximum possible dispute window

### 18.2 Time Boundaries

- [ ] block.timestamp edge cases
- [ ] Scope expiration at exact block.timestamp
- [ ] Charge entry expiration at exact block.timestamp
- [ ] Dispute window at exact boundary
- [ ] Settlement timestamp at exact boundaries

### 18.3 State Boundaries

- [ ] Empty arrays
- [ ] Single element arrays
- [ ] Maximum array sizes
- [ ] Zero balances
- [ ] Fully drained scopes

---

## 19. Error Message Validation

- [ ] All require statements have clear error messages
- [ ] Error messages match the actual error condition
- [ ] Error messages are consistent across contract

---

## 20. Future Function Compatibility

- [ ] Contract ready for withdrawal function addition
- [ ] Contract ready for agent claim function addition
- [ ] ROLE_OPERATOR ready for future use
- [ ] Withdrawal event ready for future use
- [ ] Upgradeability considerations tested

---

## Test Implementation Notes

### Recommended Testing Framework
- Use Hardhat with ethers.js or Foundry for comprehensive coverage
- Consider fuzzing for numeric edge cases
- Use test helpers for signature generation (EIP712)
- Mock ERC20 token for gas token
- Mock ERC1271 wallet for smart contract signature tests

### Test Structure
```
test/
└── ZeroLC/
    ├── ZeroLC.constructor.test.ts
    ├── ZeroLC.deposit.test.ts
    ├── ZeroLC.authorization.test.ts
    ├── ZeroLC.settlement.test.ts
    ├── ZeroLC.dispute.test.ts
    ├── ZeroLC.balances.test.ts
    ├── ZeroLC.compact.test.ts
    ├── ZeroLC.integration.test.ts
    └── ZeroLC.security.test.ts
```

### Coverage Goals
- Line coverage: 100%
- Branch coverage: 100%
- Function coverage: 100%
- Statement coverage: 100%

---

## Progress Tracking

**Total Tests**: 200+

**Completed**: 84
- Section 2.1 - Direct Deposit (7 tests)
- Section 2.2 - Deposit with Signature (21 tests including nonce/replay protection)
- Section 2.3 - Gas Token Integration (14 tests including 6-decimal token support)
- Section 3.1 - Valid Registration (13 tests including ERC-6492)
- Section 3.2 - Edge Cases & Failures (13 tests)
- Section 3.3 - EIP712 Signature Verification (7 tests)
- Additional tests: 9 tests covering multiple users and edge cases

**In Progress**: 0
**Not Started**: 116+

### Recent Updates
- ✅ Implemented nonce-based replay protection for deposit signatures
- ✅ Added `nonce` field to `UserState` struct
- ✅ Updated EIP712 Deposit type to include nonce: `Deposit(address user,uint256 amount,uint256 nonce)`
- ✅ Added comprehensive replay attack prevention tests
- ✅ Added tests for ERC-1271 and ERC-6492 signature support
- ✅ Created `MockERC1271Wallet` contract for testing smart contract wallet signatures
- ✅ Completed Section 2.3 - Gas Token Integration tests
- ✅ Created mock tokens for testing: `NonStandardERC20`, `FalseReturningERC20`, `RevertingERC20`
- ✅ Verified SafeERC20 protection with various token behaviors
- ✅ Added 6-decimal token support tests (`TestERC20_6Decimals`) to verify USDC/USDT-like token compatibility
- ✅ Tested basic deposit, multiple deposits, and fractional amounts with 6-decimal tokens
- ✅ Completed Section 3.1 - Authorization Scope Valid Registration (13 tests)
- ✅ Completed Section 3.2 - Authorization Scope Edge Cases & Failures (13 tests)
- ✅ Created [test/ZeroLC/ZeroLC.authorization.test.ts](test/ZeroLC/ZeroLC.authorization.test.ts)
- ✅ Tested EOA, ERC-1271, and ERC-6492 signatures for authorization scope registration
- ✅ Verified auto-deposit functionality when balance insufficient
- ✅ Tested duplicate scope registration prevention
- ✅ Verified user/agent state updates and event emissions
- ✅ Created SimpleCreate2Factory for testing CREATE2 deployments
- ✅ Comprehensive edge case testing: insufficient balance, invalid signatures, expired scopes, time boundaries
- ✅ Tested self-dealing prevention (user == agent)
- ✅ Tested validation for zero values (totalAmount, disputeWindow, agent address)
- ✅ Boundary condition tests for notBefore/notAfter timestamps
- ✅ Verified reentrancy protection on registration

---

**Last Updated**: 2025-10-24
**Contract Version**: ZeroLC.sol (with nonce-based replay protection)
