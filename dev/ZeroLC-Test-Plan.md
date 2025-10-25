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

- [x] Auto-deposit when balance < totalAmount and allowance sufficient
- [x] No auto-deposit when balance < totalAmount but allowance insufficient
- [x] No auto-deposit when balance < totalAmount but token balance insufficient
- [x] Auto-deposit deposits exact amount needed (totalAmount - balance)

### 3.5 Scope Hash Calculation

- [x] getScopeHash returns consistent hash for same scope
- [x] getScopeHash returns different hash for different scopes
- [x] Scope hash includes domain separator
- [x] Scope hash uniquely identifies scope

---

## 4. Authorization Scope Revocation Tests

- [x] Revoke scope with valid signature
- [x] Revoke scope sets notAfter to block.timestamp + 300
- [x] Revoke scope with invalid signature (should revert)
- [x] Revoke already expired scope (should revert)
- [ ] Revoke scope with remainingAmount == 0 (should revert) - pending settlement tests
- [x] Revoke scope with newNotAfter >= current notAfter (should revert)
- [x] Revoke scope at exact boundary (notAfter == newNotAfter + few seconds)
- [x] Revoke scope emits AuthorizationScopeRevoking event
- [x] Revoke scope twice (second should fail)
- [x] Revoke scope after partial charges
- [x] Revoke scope with valid ERC-1271 signature
- [x] Revoke scope maintains remainingAmount correctly
- [x] Revoke scope maintains agentPendingAmount correctly
- [x] Reentrancy attack on revocation (should be blocked)
- [x] Revoke with malformed signature (should revert)
- [x] Revoke non-existent scope (should revert)
- [x] Revoke with very long initial duration
- [x] Revocation doesn't affect user balance
- [x] Revocation shortens time window for settlements

---

## 5. Charge Settlement Tests

### 5.1 Valid Settlement

- [x] Settle single charge batch with one entry
- [x] Settle single charge batch with multiple entries
- [x] Settle multiple charge batches in one transaction
- [x] Settle charges with sequential nonces
- [x] Settle charges updates remainingAmount correctly
- [x] Settle charges updates agentPendingAmount correctly
- [x] Settle charges updates lastChargeTimestamp correctly
- [x] Settle charges updates nonce correctly (increments by number of entries)
- [x] Settle charges emits ChargesSettled() event when tx.origin == msg.sender
- [x] Settle charges maintains isNumChargesRecorded flag

### 5.2 Signature Verification

- [x] Settle with valid agent ECDSA signature
- [x] Settle with invalid agent signature (should revert)
- [x] Settle with wrong agent signing (should revert)
- [x] Settle with single entry (batchPartHash == 0x00)
- [x] Settle with multiple entries (batchPartHash verified)
- [x] Settle with tampered batchPartHash (should revert)
- [x] Settle with tampered lastEntry (should revert)
- [x] Settle with tampered scopeHash (should revert)
- [x] Signature uses correct verifier struct encoding

### 5.3 Timestamp Validation

- [x] Settle with timestamp within valid 60-second window
- [x] Settle with timestamp == block.timestamp - 60 (boundary, should revert)
- [x] Settle with timestamp within 59 seconds window (boundary, should pass)
- [x] Settle with timestamp == block.timestamp (boundary, should pass)
- [x] Settle with timestamp < block.timestamp - 60 (should revert)
- [x] Settle with timestamp > block.timestamp (should revert)
- [x] Settle with timestamp <= lastChargeTimestamp (should revert)
- [x] Settle with timestamp == lastChargeTimestamp + 1 (boundary)
- [x] Settle multiple batches with increasing timestamps

### 5.4 Nonce Validation

- [x] Settle with correct sequential nonces starting from 1
- [x] Settle with wrong nonce (should revert)
- [x] Settle with skipped nonce (should revert)
- [x] Settle with repeated nonce (should revert)
- [x] Settle multiple batches incrementing nonces correctly
- [x] Nonce persists across multiple settlements
- [x] Nonce starts at 1 for new scope

### 5.5 Amount & Balance

- [x] Settle with totalAmount < remainingAmount
- [x] Settle with totalAmount == remainingAmount (exact drain)
- [x] Settle with totalAmount > remainingAmount (should revert)
- [x] Settle with zero amount entries (should revert)
- [x] Settle with uint48 max amount (overflow check)
- [x] All entries must have amount > 0

### 5.6 Entry Expiration

- [x] Settle with entry.notAfter > block.timestamp (valid, not expired)
- [x] Settle with entry.notAfter == block.timestamp (boundary, valid)
- [x] Settle with entry.notAfter < block.timestamp (should revert, expired)
- [x] Multiple entries with different notAfter values

### 5.7 Scope Status

- [x] Settle with active scope (notAfter > block.timestamp)
- [x] Settle with expired scope (should revert)
- [x] Settle with scope notAfter == block.timestamp (should revert)
- [x] Settle with scope notAfter == block.timestamp + 1 (boundary, should pass)

### 5.8 Empty Batch Validation

- [x] Settle with empty chargeBatches array (should revert)
- [x] Settle with batch containing empty entries array (should revert)
- [x] verifyChargeBatchSignature validates non-empty entries

### 5.9 Event Emissions

- [x] Settle emits ChargesSettledFromContract when called from contract (tx.origin != msg.sender)
- [x] Settle does NOT emit ChargesSettled when called from contract
- [x] ChargesSettledFromContract contains correct encoded data
- [x] ChargesSettledFromContract works with multiple batches
- [x] tx.origin vs msg.sender determines which event to emit

---

## 6. Dispute Tests

### 6.1 Valid Disputes

- [x] Dispute valid charge batch within dispute window
- [x] Dispute with partial clawback amount
- [x] Dispute with full clawback amount (amountToClawback == totalChargedAmount)
- [x] Dispute with valid user EOA signature
- [x] Dispute with valid ERC-1271 signature from smart wallet
- [x] Dispute updates agentPendingAmount correctly (decreases)
- [x] Dispute updates user balance correctly (increases)
- [x] Dispute sets scope notAfter to block.timestamp
- [x] Dispute increments numDisputes counter
- [x] Dispute emits ChargeDisputed event with correct parameters
- [x] Multiple disputes in single transaction (different batches)

### 6.2 Dispute Window

- [x] Dispute within valid dispute window
- [x] Dispute at exact disputeWindow boundary (block.timestamp - timestamp < disputeWindow)
- [x] Dispute after dispute window expires (should revert)
- [x] Dispute with very short dispute window (10 seconds)
- [x] Dispute with very long dispute window (uint48 max)
- [x] Dispute window calculation with timestamp edge cases

### 6.3 Signature Validation

- [x] Dispute with invalid user signature (should revert)
- [x] Dispute with wrong signer (should revert)
- [x] Dispute with tampered amountToClawback (should revert)
- [x] Dispute with tampered scopeHash (should revert)
- [x] Dispute signature uses correct EIP712 type hash
- [x] Dispute with ERC-6492 signature

### 6.4 Amount Validation

- [x] Dispute with amountToClawback < totalChargedAmount
- [x] Dispute with amountToClawback == totalChargedAmount (boundary)
- [x] Dispute with amountToClawback > totalChargedAmount (should revert)
- [x] Dispute with amountToClawback > agentPendingAmount (should revert)
- [x] Dispute with zero amountToClawback (should revert)
- [x] Dispute calculates totalChargedAmount correctly from entries

### 6.5 Duplicate Disputes

- [x] Dispute same charge batch twice (second should revert)
- [x] Dispute hash calculation is unique per batch
- [x] Dispute hash includes scope, entries, and timestamp
- [x] Different batches have different dispute hashes

### 6.6 Agent Signature Verification

- [x] Dispute verifies agent signature on charge batch
- [x] Dispute with invalid agent signature (should revert during verification)
- [x] Dispute validates charge batch signature before processing

### 6.7 Timestamp Validation

- [x] Dispute with future charge batch timestamp (should revert)
- [x] Dispute with timestamp == block.timestamp (boundary)
- [x] Dispute validates timestamp <= block.timestamp

### 6.8 Empty Batch Validation

- [x] Dispute with empty disputes array (should revert)
- [x] Dispute verifies non-empty charge batch entries

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

**Completed**: 178
- Section 2.1 - Direct Deposit (7 tests)
- Section 2.2 - Deposit with Signature (21 tests including nonce/replay protection)
- Section 2.3 - Gas Token Integration (14 tests including 6-decimal token support)
- Section 3.1 - Valid Registration (13 tests including ERC-6492)
- Section 3.2 - Edge Cases & Failures (13 tests)
- Section 3.3 - EIP712 Signature Verification (7 tests)
- Section 3.4 - Auto-Deposit Logic (4 tests)
- Section 3.5 - Scope Hash Calculation (4 tests)
- Section 4 - Authorization Scope Revocation (18 tests)
- Section 5.1 - Valid Settlement (10 tests)
- Section 5.2 - Signature Verification (9 tests)
- Section 5.3 - Timestamp Validation (9 tests)
- Section 5.4 - Nonce Validation (7 tests)
- Section 5.5 - Amount & Balance (6 tests)
- Section 5.6 - Entry Expiration (4 tests)
- Section 5.7 - Scope Status (4 tests)
- Section 5.8 - Empty Batch Validation (3 tests)
- Section 5.9 - Event Emissions (5 tests)
- Section 6.1 - Valid Disputes (11 tests)
- Additional tests: 9 tests covering multiple users and edge cases

**In Progress**: 0
**Not Started**: 22+

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
- ✅ Completed Section 3.4 - Auto-Deposit Logic (4 tests)
- ✅ Verified auto-deposit triggers when balance insufficient but allowance exists
- ✅ Tested auto-deposit deposits exact amount needed (totalAmount - balance)
- ✅ Verified auto-deposit failures when allowance or token balance insufficient
- ✅ Completed Section 3.5 - Scope Hash Calculation (4 tests)
- ✅ Verified getScopeHash returns consistent hash for same scope
- ✅ Verified different scopes produce different hashes
- ✅ Confirmed scope hash includes domain separator
- ✅ Verified scope hash uniquely identifies each scope
- ✅ Completed Section 4 - Authorization Scope Revocation (18 tests)
- ✅ Created [test/ZeroLC/ZeroLC.revocation.test.ts](test/ZeroLC/ZeroLC.revocation.test.ts)
- ✅ Tested valid revocation with EOA and ERC-1271 signatures
- ✅ Verified revocation sets notAfter to block.timestamp + 300
- ✅ Tested revocation failure scenarios: expired scopes, invalid signatures, malformed data
- ✅ Verified revocation doesn't affect user balance and properly shortens settlement window
- ✅ Tested boundary conditions for revocation timing
- ✅ Verified reentrancy protection on revocation
- ✅ Completed Section 5 - Charge Settlement Tests (57 tests total across 9 subsections)
- ✅ Created [test/ZeroLC/ZeroLC.settlement.test.ts](test/ZeroLC/ZeroLC.settlement.test.ts)
- ✅ Implemented comprehensive charge batch settlement tests with agent ECDSA signatures
- ✅ Critical fix: Signature verification requires signing ENCODED BYTES, not hash
- ✅ Used ethers.getBytes() to convert hex strings to Uint8Array for proper message hashing
- ✅ Tested single and multiple charge batches with batch part hash verification
- ✅ Verified timestamp validation (60-second settlement window)
- ✅ Tested nonce-based replay protection for charge entries (sequential nonces starting from 1)
- ✅ Verified amount validation, entry expiration, and scope status checks
- ✅ Tested empty batch validation and boundary conditions
- ✅ Created [contracts/test/SettlementCaller.sol](contracts/test/SettlementCaller.sol) helper contract
- ✅ Implemented Section 5.9 - Event Emissions tests for tx.origin vs msg.sender detection
- ✅ Verified ChargesSettled() emitted when called directly (tx.origin == msg.sender)
- ✅ Verified ChargesSettledFromContract(bytes) emitted when called from contract (tx.origin != msg.sender)
- ✅ Completed Section 6.1 - Valid Disputes (11 tests)
- ✅ Created [test/ZeroLC/ZeroLC.dispute.test.ts](test/ZeroLC/ZeroLC.dispute.test.ts)
- ✅ Tested valid disputes within dispute window with EOA and ERC-1271 smart wallet signatures
- ✅ Verified partial and full clawback amounts
- ✅ Tested state updates: agentPendingAmount decrease, user balance increase, scope notAfter update
- ✅ Verified numDisputes counter increment
- ✅ Tested ChargeDisputed event emission
- ✅ Implemented multiple disputes in single transaction (different batches)
- ✅ Fixed timestamp issues using time.latest() instead of Date.now() for Hardhat compatibility
- ✅ Used time.increase() for advancing blockchain time in tests

---

**Last Updated**: 2025-10-25
**Contract Version**: ZeroLC.sol (with nonce-based replay protection)
