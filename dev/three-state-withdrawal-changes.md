# ZeroLC Three-State Withdrawal System - Implementation Changes

## Overview

This document describes all changes made to implement the three-state withdrawal system in ZeroLC.sol. The primary motivation was to remove the insecure "detailed" withdrawal mode while still allowing agents to withdraw funds in reasonable time.

**Security Issue Fixed**: The old "detailed" withdrawal mode allowed agents to selectively submit different sets of charges, which the contract couldn't verify as the actual/complete set. This enabled manipulation of which charges to withdraw.

**New Solution**: Three-state pipeline system where amounts automatically progress: `pending` → `finalizing` → `withdrawable`

---

## Struct Changes

### 1. AuthorizationScope (External-facing)

**Added Field:**
```solidity
// OLD: No amountGranularity field
struct AuthorizationScope {
    address user;
    uint48 totalAmount;  // OLD TYPE
    uint40 disputeWindow;
    address agent;
    uint40 notBefore;
    uint40 notAfter;
}

// NEW: Added amountGranularity, changed totalAmount type
struct AuthorizationScope {
    address user;
    uint40 disputeWindow;
    address agent;
    uint40 notBefore;
    uint40 notAfter;
    uint128 totalAmount;  // NEW TYPE (was uint48)
    uint8 amountGranularity;  // NEW FIELD
}
```

**Impact on Tests:**
- All `AuthorizationScope` creation must include `amountGranularity` field
- Field order changed - update EIP-712 type strings
- `totalAmount` is now uint128 (was uint48)

---

### 2. AuthorizationScopeState (Internal storage)

**Complete Restructure:**
```solidity
// OLD
struct AuthorizationScopeState {
    uint48 remainingAmount;
    uint48 agentPendingAmount;
    uint24 nonce;
    uint24 withdrawalNonce;
    uint48 notAfter;
    uint48 lastChargeTimestamp;
    uint8 isNumChargesRecorded;
}

// NEW
struct AuthorizationScopeState {
    uint32 remainingAmount;           // Scaled down
    uint32 chargedAmountWithdrawable; // NEW - finalized, ready to withdraw
    uint32 chargedAmountFinalizing;   // NEW - transitioning out of dispute window
    uint32 chargedAmountPending;      // NEW - newly charged, in dispute window
    uint40 notAfter;
    uint32 finalizationTimestamp;     // NEW - stored as offset from notAfter
    uint32 lastChargeTimestamp;       // Stored as offset from notAfter
    uint24 nonceAndFlags;             // NEW - combined nonce + flags
}
```

**Key Changes:**
- **Removed**: `agentPendingAmount`, `nonce`, `withdrawalNonce`, `isNumChargesRecorded`
- **Added**: Three amount buckets (`chargedAmountWithdrawable`, `chargedAmountFinalizing`, `chargedAmountPending`)
- **Modified**: All amounts are uint32 and scaled by `10^amountGranularity`
- **Modified**: Timestamps stored as negative offsets from `notAfter` to fit in uint32
- **Modified**: Nonce and flags combined into single uint24 field

**Impact on Tests:**
- Cannot access `state.agentPendingAmount` - use `getAgentPendingAmount()` instead
- Cannot access `state.nonce` - nonce is embedded in `nonceAndFlags`
- Cannot access `state.withdrawalNonce` - removed entirely
- Cannot access `state.isNumChargesRecorded` - now a flag bit in `nonceAndFlags`

---

### 3. ChargeEntry

**Field Rename and Type Change:**
```solidity
// OLD
struct ChargeEntry {
    uint48 amount;
    uint24 nonce;
    uint40 notAfter;
}

// NEW
struct ChargeEntry {
    uint32 scaledAmount;  // RENAMED from 'amount', TYPE changed from uint48
    uint24 nonce;
    uint40 notAfter;
}
```

**Critical**: `scaledAmount` is **pre-scaled** by clients (divided by `10^amountGranularity`) to save gas.

**Impact on Tests:**
- Change `entry.amount` to `entry.scaledAmount`
- Scale amounts before creating entries: `scaledAmount = amount / (10 ** amountGranularity)`
- Type changed from uint48 to uint32

---

### 4. Dispute

**Type Change:**
```solidity
// OLD
struct Dispute {
    ChargeBatch chargeBatch;
    uint48 amountToClawback;
    bytes signature;
}

// NEW
struct Dispute {
    ChargeBatch chargeBatch;
    uint32 amountToClawback;  // TYPE changed from uint48
    bytes signature;
}
```

**Critical**: `amountToClawback` is **pre-scaled** (divided by `10^amountGranularity`).

**Impact on Tests:**
- Type changed from uint48 to uint32
- Scale amounts before creating disputes: `scaledAmount = amount / (10 ** amountGranularity)`

---

### 5. AuthorizationScopeData (NEW)

**New Storage Struct:**
```solidity
struct AuthorizationScopeData {
    uint128 totalAmount;      // Original unscaled total amount
    uint40 disputeWindow;
    uint8 amountGranularity;
    // Remaining bits unused (80 bits free for future use)
}
```

**Purpose**: Stores scope metadata for later retrieval (used for unscaling amounts).

**Storage**: New mapping `authorizationScopeData[scopeHash]`

**Impact on Tests:**
- Can query this mapping to retrieve scope metadata
- Automatically populated during `registerAuthorizationScope`

---

## Function Signature Changes

### 1. withdrawAgentChargedFund (BREAKING CHANGES)

**OLD Signatures:**
```solidity
// Version 1: Direct call
function withdrawAgentChargedFund(
    AuthorizationScope calldata scope,
    bool toWallet,
    ChargeBatch[] calldata recentCharges  // REMOVED
) external nonReentrant

// Version 2: With signature
function withdrawAgentChargedFund(
    AuthorizationScope calldata scope,
    bool toWallet,
    ChargeBatch[] calldata recentCharges,  // REMOVED
    bytes calldata signature
) external nonReentrant
```

**NEW Signatures:**
```solidity
// Version 1: Direct call
function withdrawAgentChargedFund(
    AuthorizationScope calldata scope,
    bool toWallet
) external nonReentrant

// Version 2: With signature
function withdrawAgentChargedFund(
    AuthorizationScope calldata scope,
    bool toWallet,
    bytes calldata signature
) external nonReentrant
```

**Impact on Tests:**
- Remove `recentCharges` parameter from all withdrawal calls
- Update EIP-712 signature type from `WithdrawAgentChargedFund(bytes32 scopeHash,bool toWallet,bytes32 recentChargesHash,uint256 nonce)` to `WithdrawAgentChargedFund(bytes32 scopeHash,bool toWallet,uint256 nonce)`

---

### 2. getAgentPendingAmount

**Return Type Change:**
```solidity
// OLD
function getAgentPendingAmount(
    AuthorizationScope calldata scope
) public view returns (uint48)

// NEW
function getAgentPendingAmount(
    AuthorizationScope calldata scope
) public view returns (uint128)
```

**Behavior**: Now returns sum of `chargedAmountPending + chargedAmountFinalizing` (unscaled).

**Impact on Tests:**
- Update expected return type from uint48 to uint128

---

### 3. Removed Functions

**Completely Removed:**
- `getAgentWithdrawalNonce()` - No longer needed without withdrawal nonce tracking
- `getWithdrawableAmountSimple()` - Removed (was view-only helper)
- `_calculateWithdrawableSimple()` - Removed (internal helper)

**Impact on Tests:**
- Remove all calls to these functions
- For withdrawal amount, agents must call `withdrawAgentChargedFund` (it will revert if nothing is withdrawable)

---

## EIP-712 Signature Changes

### 1. AuthorizationScope Type String

**OLD:**
```solidity
"AuthorizationScope(address user,uint48 totalAmount,uint40 disputeWindow,address agent,uint40 notBefore,uint40 notAfter)"
```

**NEW:**
```solidity
"AuthorizationScope(address user,uint40 disputeWindow,address agent,uint40 notBefore,uint40 notAfter,uint128 totalAmount,uint8 amountGranularity)"
```

**Changes:**
- Field order changed
- Added `amountGranularity` field
- `totalAmount` type changed from uint48 to uint128

**Impact on Tests:**
- Update all EIP-712 signature generation for scope registration
- Include `amountGranularity` in encoding

---

### 2. Dispute Type String

**OLD:**
```solidity
"Dispute(bytes32 scopeHash,uint48 amountToClawback)"
```

**NEW:**
```solidity
"Dispute(bytes32 scopeHash,uint32 amountToClawback)"
```

**Impact on Tests:**
- Update dispute signature generation
- Type changed from uint48 to uint32

---

### 3. WithdrawAgentChargedFund Type String

**OLD:**
```solidity
"WithdrawAgentChargedFund(bytes32 scopeHash,bool toWallet,bytes32 recentChargesHash,uint256 nonce)"
```

**NEW:**
```solidity
"WithdrawAgentChargedFund(bytes32 scopeHash,bool toWallet,uint256 nonce)"
```

**Impact on Tests:**
- Remove `recentChargesHash` from signature encoding

---

## New Custom Errors

**Added:**
```solidity
error InvalidAmountGranularity();
error InvalidTimestampRange();
```

**Impact on Tests:**
- Test these new validation errors
- `InvalidAmountGranularity`: Thrown when `totalAmount / (10 ** amountGranularity)` doesn't fit in uint32 or doesn't divide evenly
- `InvalidTimestampRange`: Thrown when `notAfter - notBefore` exceeds uint32.max

---

## Behavioral Changes

### 1. Withdrawal Flow

**OLD Behavior:**
- Two modes: "simple" (wait for all) or "detailed" (submit specific charges)
- Detailed mode was insecure
- Withdrawal nonce tracked what was withdrawn

**NEW Behavior:**
- Only one mode: automatic three-state pipeline
- Amounts progress automatically: `pending` → `finalizing` → `withdrawable`
- When agent calls `withdrawAgentChargedFund`:
  1. `_updateFinalizationState()` is called (moves amounts through pipeline if dispute window passed)
  2. Withdraw everything in `chargedAmountWithdrawable`
  3. Clear `chargedAmountWithdrawable` to 0

**Impact on Tests:**
- Withdrawal timing depends on dispute window
- Agents may need to call withdrawal multiple times as amounts progress through pipeline
- No more "detailed" withdrawal tests needed

---

### 2. Dispute Deduction

**OLD Behavior:**
- Deducted from single `agentPendingAmount` bucket

**NEW Behavior:**
- Cascading deduction in order:
  1. Skip `chargedAmountWithdrawable` (finalized, cannot be clawed back)
  2. Deduct from `chargedAmountFinalizing` first
  3. Then deduct from `chargedAmountPending`
  4. Revert if insufficient funds

**Impact on Tests:**
- Disputes cannot claw back finalized amounts
- Test cascading deduction logic
- Test that disputes fail if trying to claw back more than available in finalizing+pending

---

### 3. Amount Scaling

**NEW Behavior:**
- All amounts in `AuthorizationScopeState` are scaled down by `10^amountGranularity`
- Client must pre-scale amounts in `ChargeEntry.scaledAmount` and `Dispute.amountToClawback`
- Contract unscales when transferring funds or emitting events

**Impact on Tests:**
- Calculate scaled amounts: `scaledAmount = amount / (10 ** amountGranularity)`
- Ensure `amount` divides evenly by `10^amountGranularity`
- Common value for tests: `amountGranularity = 0` (no scaling) or `amountGranularity = 6` (similar to USDC)

---

### 4. Timestamp Offsets

**NEW Behavior:**
- `finalizationTimestamp` and `lastChargeTimestamp` stored as negative offsets from `notAfter`
- Real timestamp = `notAfter - offset`
- Initialized during scope registration:
  - `finalizationTimestamp = notAfter - notBefore` (offset to earliest time)
  - `lastChargeTimestamp = notAfter - block.timestamp` (offset to now)

**Impact on Tests:**
- Cannot directly read timestamps from state - they are offsets
- Time-based tests need to account for offset calculation
- Validation requires `notAfter - notBefore <= type(uint32).max`

---

### 5. Nonce and Flags

**NEW Behavior:**
- Nonce stored in lower 22 bits of `nonceAndFlags`
- Flags stored in upper 2 bits:
  - `FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED` (bit 23): Set when charges counted during compaction
  - `FLAG_SCOPE_STATUS_DEACTIVATED` (bit 22): Reserved for future use

**Impact on Tests:**
- Cannot directly access nonce from state
- Cannot directly check `isNumChargesRecorded` flag
- Nonce range: 0 to 4,194,303 (2^22 - 1)

---

## Migration Guide for Tests

### Step 1: Update Helper Functions

Create test helpers for amount scaling:
```typescript
function scaleAmount(amount: bigint, granularity: number): number {
  return Number(amount / (10n ** BigInt(granularity)));
}

function unscaleAmount(scaledAmount: number, granularity: number): bigint {
  return BigInt(scaledAmount) * (10n ** BigInt(granularity));
}
```

### Step 2: Update AuthorizationScope Creation

```typescript
// OLD
const scope = {
  user: userAddress,
  totalAmount: ethers.parseEther("100"),
  disputeWindow: 3600,
  agent: agentAddress,
  notBefore: nowTimestamp,
  notAfter: nowTimestamp + 86400
};

// NEW
const scope = {
  user: userAddress,
  disputeWindow: 3600,
  agent: agentAddress,
  notBefore: nowTimestamp,
  notAfter: nowTimestamp + 86400,
  totalAmount: ethers.parseEther("100"),
  amountGranularity: 0  // or 6 for USDC-like scaling
};
```

### Step 3: Update ChargeEntry Creation

```typescript
// OLD
const entry = {
  amount: ethers.parseEther("10"),
  nonce: 1,
  notAfter: nowTimestamp + 3600
};

// NEW
const amountGranularity = 0; // or get from scope
const entry = {
  scaledAmount: scaleAmount(ethers.parseEther("10"), amountGranularity),
  nonce: 1,
  notAfter: nowTimestamp + 3600
};
```

### Step 4: Update Dispute Creation

```typescript
// OLD
const dispute = {
  chargeBatch: batch,
  amountToClawback: ethers.parseEther("5"),
  signature: disputeSignature
};

// NEW
const dispute = {
  chargeBatch: batch,
  amountToClawback: scaleAmount(ethers.parseEther("5"), amountGranularity),
  signature: disputeSignature
};
```

### Step 5: Update EIP-712 Signatures

**AuthorizationScope:**
```typescript
// OLD
const types = {
  AuthorizationScope: [
    { name: "user", type: "address" },
    { name: "totalAmount", type: "uint48" },
    { name: "disputeWindow", type: "uint40" },
    { name: "agent", type: "address" },
    { name: "notBefore", type: "uint40" },
    { name: "notAfter", type: "uint40" }
  ]
};

// NEW
const types = {
  AuthorizationScope: [
    { name: "user", type: "address" },
    { name: "disputeWindow", type: "uint40" },
    { name: "agent", type: "address" },
    { name: "notBefore", type: "uint40" },
    { name: "notAfter", type: "uint40" },
    { name: "totalAmount", type: "uint128" },
    { name: "amountGranularity", type: "uint8" }
  ]
};
```

**Dispute:**
```typescript
// OLD
const types = {
  Dispute: [
    { name: "scopeHash", type: "bytes32" },
    { name: "amountToClawback", type: "uint48" }
  ]
};

// NEW
const types = {
  Dispute: [
    { name: "scopeHash", type: "bytes32" },
    { name: "amountToClawback", type: "uint32" }
  ]
};
```

**WithdrawAgentChargedFund:**
```typescript
// OLD
const types = {
  WithdrawAgentChargedFund: [
    { name: "scopeHash", type: "bytes32" },
    { name: "toWallet", type: "bool" },
    { name: "recentChargesHash", type: "bytes32" },
    { name: "nonce", type: "uint256" }
  ]
};

// NEW
const types = {
  WithdrawAgentChargedFund: [
    { name: "scopeHash", type: "bytes32" },
    { name: "toWallet", type: "bool" },
    { name: "nonce", type: "uint256" }
  ]
};
```

### Step 6: Update Withdrawal Calls

```typescript
// OLD
await contract.withdrawAgentChargedFund(scope, true, recentCharges);

// NEW
await contract.withdrawAgentChargedFund(scope, true);
```

### Step 7: Update State Assertions

```typescript
// OLD
const state = await contract.authorizationScopes(scopeHash);
expect(state.agentPendingAmount).to.equal(expectedAmount);
expect(state.nonce).to.equal(2);

// NEW
// Cannot access state fields directly - use view functions
const pendingAmount = await contract.getAgentPendingAmount(scope);
expect(pendingAmount).to.equal(expectedAmount);
// Note: nonce is not directly accessible
```

### Step 8: Add Tests for New Features

**Test amount granularity validation:**
```typescript
it("should reject invalid amount granularity", async () => {
  const scope = {
    ...baseScope,
    totalAmount: ethers.parseEther("100") + 1n, // Not divisible
    amountGranularity: 18
  };
  await expect(
    contract.registerAuthorizationScope(scope, signature)
  ).to.be.revertedWithCustomError(contract, "InvalidAmountGranularity");
});
```

**Test timestamp range validation:**
```typescript
it("should reject timestamp range too large", async () => {
  const scope = {
    ...baseScope,
    notBefore: 0,
    notAfter: 2n ** 32n + 1n // Exceeds uint32
  };
  await expect(
    contract.registerAuthorizationScope(scope, signature)
  ).to.be.revertedWithCustomError(contract, "InvalidTimestampRange");
});
```

**Test three-state withdrawal:**
```typescript
it("should withdraw after dispute window passes", async () => {
  // 1. Settle charges (goes to pending)
  await contract.settleCharges([chargeBatch]);

  // 2. Try to withdraw immediately - should fail
  await expect(
    contract.withdrawAgentChargedFund(scope, true)
  ).to.be.revertedWithCustomError(contract, "NoWithdrawableBalance");

  // 3. Fast forward past dispute window
  await time.increase(disputeWindow + 1);

  // 4. Withdraw - should trigger state transition and succeed
  await contract.withdrawAgentChargedFund(scope, true);
});
```

**Test cascading dispute deduction:**
```typescript
it("should not claw back finalized amounts", async () => {
  // 1. Settle charges
  await contract.settleCharges([chargeBatch]);

  // 2. Fast forward to finalize some amounts
  await time.increase(disputeWindow + 1);

  // 3. Withdraw (moves amounts to withdrawable)
  await contract.withdrawAgentChargedFund(scope, true);

  // 4. Try to dispute - should fail (amount is finalized)
  await expect(
    contract.dispute([dispute])
  ).to.be.revertedWithCustomError(contract, "InsufficientPendingBalance");
});
```

---

## Summary of Breaking Changes

**HIGH PRIORITY (Will break existing tests):**
1. ✅ `AuthorizationScope` structure changed (field order + new field)
2. ✅ `ChargeEntry.amount` renamed to `ChargeEntry.scaledAmount` (type changed)
3. ✅ `Dispute.amountToClawback` type changed to uint32
4. ✅ All EIP-712 type strings changed
5. ✅ `withdrawAgentChargedFund` signature changed (removed `recentCharges`)
6. ✅ Removed functions: `getAgentWithdrawalNonce`, `getWithdrawableAmountSimple`
7. ✅ Cannot access `state.agentPendingAmount` - use `getAgentPendingAmount()` instead

**MEDIUM PRIORITY (May require test updates):**
1. ✅ Amounts must be pre-scaled by `10^amountGranularity`
2. ✅ Withdrawal behavior changed (three-state pipeline)
3. ✅ Dispute deduction logic changed (cascading, protects finalized)
4. ✅ New validations for `amountGranularity` and timestamp range

**LOW PRIORITY (Internal changes):**
1. ✅ Timestamp storage changed to offsets
2. ✅ Nonce/flags combined into single field
3. ✅ New `AuthorizationScopeData` storage mapping

---

## Files to Update

Based on glob search, these test files likely need updates:

1. `test/ZeroLC/ZeroLC.authorization.test.ts` - Scope registration
2. `test/ZeroLC/ZeroLC.settlement.test.ts` - Charge settlement with scaled amounts
3. `test/ZeroLC/ZeroLC.withdrawal.test.ts` - Withdrawal flow (major changes)
4. `test/ZeroLC/ZeroLC.dispute.test.ts` - Dispute with scaled amounts and cascading deduction
5. `test/ZeroLC/ZeroLC.compact.test.ts` - State compaction with new fields
6. `test/ZeroLC/ZeroLC.revocation.test.ts` - Scope revocation (minimal changes)

---

## Testing Checklist

**Authorization Tests (test/ZeroLC/ZeroLC.authorization.test.ts):**
- [x] Update all `AuthorizationScope` creation with `amountGranularity`
- [x] Update all EIP-712 signature generation (field order and types changed)
- [x] Add tests for `InvalidAmountGranularity` error
- [x] Add tests for `InvalidTimestampRange` error
- [x] Add tests for granularity values 3, 6, and 12
- [x] Update auto-deposit tests to test with granularity 0 and 3
- [x] Add `authorizationScopeData` mapping verification tests
- [x] Remove assertions on deleted state fields (`agentPendingAmount`, `nonce`, etc.)
- [x] Add assertions for new three-state amounts

**Remaining Test Files:**
- [ ] Change `ChargeEntry.amount` to `ChargeEntry.scaledAmount` everywhere
- [ ] Scale all charge amounts before creating entries
- [ ] Scale all dispute amounts before creating disputes
- [ ] Remove `recentCharges` from all withdrawal calls
- [ ] Remove all calls to `getAgentWithdrawalNonce()`
- [ ] Remove all calls to `getWithdrawableAmountSimple()`
- [ ] Replace `state.agentPendingAmount` with `getAgentPendingAmount()` calls
- [ ] Add tests for three-state withdrawal pipeline
- [ ] Add tests for cascading dispute deduction
- [ ] Test that finalized amounts cannot be disputed
- [ ] Test time-based withdrawal (dispute window passing)
- [ ] Test multiple withdrawals as amounts progress through pipeline

---

## Test Helper Functions - Migration Guide

The ZeroLC test suite has common helper functions duplicated across multiple test files. This section documents how each helper function needs to be updated for the three-state withdrawal system. **Apply these changes to ALL test files that contain these helpers.**

### Common Helper Functions Found In Test Files

These functions appear in most/all test files inside `deployZeroLCFixture()`:
- `createAuthorizationScope` - **CRITICAL, appears in all test files**
- `depositForUser` - No changes needed
- `registerScope` - Needs parameter update (calls createAuthorizationScope)
- `createChargeEntry` - **CRITICAL, field rename** (settlement, withdrawal, dispute tests)

---

### 1. createAuthorizationScope (CRITICAL - ALL FILES)

**Files:** `authorization.test.ts` ✅, `settlement.test.ts`, `withdrawal.test.ts`, `revocation.test.ts`, `dispute.test.ts`, `compact.test.ts`

**BEFORE (old implementation):**
```typescript
async function createAuthorizationScope(
  user: SignerWithAddress,
  agent: SignerWithAddress,
  totalAmount: bigint,
  disputeWindow: number = 3600,
  notBefore?: number,
  notAfter?: number
) {
  const currentTime = await time.latest();
  const scope = {
    user: user.address,
    totalAmount: totalAmount,          // ❌ OLD position (2nd field)
    disputeWindow: disputeWindow,
    agent: agent.address,
    notBefore: notBefore ?? currentTime,
    notAfter: notAfter ?? currentTime + 86400,
  };

  const domain = {
    name: "ZeroLC",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await zeroLC.getAddress(),
  };

  const types = {
    AuthorizationScope: [
      { name: "user", type: "address" },
      { name: "totalAmount", type: "uint48" },    // ❌ OLD type
      { name: "disputeWindow", type: "uint48" },  // ❌ OLD type
      { name: "agent", type: "address" },
      { name: "notBefore", type: "uint48" },      // ❌ OLD type
      { name: "notAfter", type: "uint48" },       // ❌ OLD type
    ],
  };

  const signature = await user.signTypedData(domain, types, scope);
  return { scope, signature };
}
```

**AFTER (new implementation):**
```typescript
async function createAuthorizationScope(
  user: SignerWithAddress,
  agent: SignerWithAddress,
  totalAmount: bigint,
  disputeWindow: number = 3600,
  notBefore?: number,
  notAfter?: number,
  amountGranularity: number = 0  // ✅ NEW parameter
) {
  const currentTime = await time.latest();
  const scope = {
    user: user.address,
    disputeWindow: disputeWindow,      // ✅ MOVED to 2nd position
    agent: agent.address,
    notBefore: notBefore ?? currentTime,
    notAfter: notAfter ?? currentTime + 86400,
    totalAmount: totalAmount,          // ✅ MOVED to 6th position
    amountGranularity: amountGranularity, // ✅ NEW field (7th position)
  };

  const domain = {
    name: "ZeroLC",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await zeroLC.getAddress(),
  };

  const types = {
    AuthorizationScope: [
      { name: "user", type: "address" },
      { name: "disputeWindow", type: "uint40" },  // ✅ CHANGED from uint48
      { name: "agent", type: "address" },
      { name: "notBefore", type: "uint40" },      // ✅ CHANGED from uint48
      { name: "notAfter", type: "uint40" },       // ✅ CHANGED from uint48
      { name: "totalAmount", type: "uint128" },   // ✅ CHANGED from uint48
      { name: "amountGranularity", type: "uint8" }, // ✅ NEW field
    ],
  };

  const signature = await user.signTypedData(domain, types, scope);
  return { scope, signature };
}
```

**Change Checklist:**
- [x] ✅ Add `amountGranularity: number = 0` parameter
- [x] ✅ Move `disputeWindow` to 2nd position in scope object
- [x] ✅ Move `totalAmount` to 6th position in scope object
- [x] ✅ Add `amountGranularity` field to scope object (7th position)
- [x] ✅ Reorder EIP-712 types array to match new field order
- [x] ✅ Change `disputeWindow` type from `uint48` → `uint40`
- [x] ✅ Change `notBefore` type from `uint48` → `uint40`
- [x] ✅ Change `notAfter` type from `uint48` → `uint40`
- [x] ✅ Change `totalAmount` type from `uint48` → `uint128`
- [x] ✅ Add `amountGranularity` type `uint8` to types array

---

### 2. depositForUser (NO CHANGES NEEDED)

**Files:** ALL test files

This helper function **does not need any changes**. It remains the same:

```typescript
async function depositForUser(user: SignerWithAddress, amount: bigint) {
  await gasToken.connect(user).approve(await zeroLC.getAddress(), amount);
  await zeroLC.connect(user)["deposit(uint256)"](amount);
}
```

✅ No action required for this function.

---

### 3. NEW Helper: getAuthorizationScopeData

**Files to ADD:** `authorization.test.ts` ✅, `settlement.test.ts`, `withdrawal.test.ts`, `dispute.test.ts`

**Purpose:** Fetch data from the new `authorizationScopeData` mapping.

**Implementation:**
```typescript
async function getAuthorizationScopeData(scopeHash: string) {
  return await zeroLC.authorizationScopeData(scopeHash);
}
```

**Add to fixture return:**
```typescript
return {
  // ... existing returns
  getAuthorizationScopeData,  // ✅ ADD THIS
};
```

**Usage:**
```typescript
const scopeHash = await zeroLC.getScopeHash(scope);
const scopeData = await getAuthorizationScopeData(scopeHash);

expect(scopeData.totalAmount).to.equal(totalAmount);  // Unscaled original amount
expect(scopeData.disputeWindow).to.equal(3600);
expect(scopeData.amountGranularity).to.equal(3);
```

---

### 4. NEW Helper: calculateScaledAmount

**Files to ADD:** ALL test files

**Purpose:** Calculate what amount will be after scaling (for assertions).

**Implementation:**
```typescript
function calculateScaledAmount(amount: bigint, granularity: number): bigint {
  return amount / (10n ** BigInt(granularity));
}
```

**Add to fixture return:**
```typescript
return {
  // ... existing returns
  calculateScaledAmount,  // ✅ ADD THIS
};
```

**Usage:**
```typescript
const totalAmount = 1000000n;
const granularity = 3;
const expectedScaledAmount = calculateScaledAmount(totalAmount, granularity); // 1000n

const scopeState = await zeroLC.authorizationScopes(scopeHash);
expect(scopeState.remainingAmount).to.equal(expectedScaledAmount);
```

---

### 5. createChargeBatch (CRITICAL - settlement/withdrawal/dispute tests)

**Files:** `settlement.test.ts`, `withdrawal.test.ts`, `dispute.test.ts`

**BEFORE (old implementation):**
```typescript
async function createChargeBatch(
  scope: any,
  agent: SignerWithAddress,
  entries: { amount: bigint; nonce: number; notAfter: number }[],  // ❌ OLD field name
  timestamp?: number
) {
  // ... existing code ...

  const chargeEntries = entries.map((e) => ({
    amount: e.amount,      // ❌ OLD field name
    nonce: e.nonce,
    notAfter: e.notAfter,
  }));

  // ... encoding logic ...
  const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "tuple(uint48,uint24,uint48)", "bytes32"],  // ❌ OLD types
    [batchPartHash, [lastEntry.amount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
  );

  // ... rest of function
}
```

**AFTER (new implementation):**
```typescript
async function createChargeBatch(
  scope: any,
  agent: SignerWithAddress,
  entries: { scaledAmount: bigint; nonce: number; notAfter: number }[],  // ✅ RENAMED
  timestamp?: number
) {
  // ... existing code ...

  const chargeEntries = entries.map((e) => ({
    scaledAmount: e.scaledAmount,  // ✅ RENAMED from 'amount'
    nonce: e.nonce,
    notAfter: e.notAfter,
  }));

  // ... encoding logic ...
  const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "tuple(uint32,uint24,uint48)", "bytes32"],  // ✅ CHANGED uint48→uint32
    [batchPartHash, [lastEntry.scaledAmount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
  );

  // ... rest of function
}
```

**Change Checklist:**
- [ ] Rename `entries` parameter field: `amount` → `scaledAmount`
- [ ] Update `chargeEntries.map()`: rename `amount` → `scaledAmount`
- [ ] Update encoding type: `tuple(uint48,uint24,uint48)` → `tuple(uint32,uint24,uint48)`
- [ ] Update all call sites to pass `scaledAmount` instead of `amount`

**⚠️ IMPORTANT - Calling Code Must Change:**
```typescript
// OLD - passing unscaled amounts
const chargeBatch = await createChargeBatch(scope, agent1, [
  { amount: 50000n, nonce: 1, notAfter: scope.notAfter },  // ❌
  { amount: 30000n, nonce: 2, notAfter: scope.notAfter },  // ❌
]);

// NEW - MUST scale amounts before calling
const granularity = 3;
const chargeBatch = await createChargeBatch(scope, agent1, [
  {
    scaledAmount: calculateScaledAmount(50000n, granularity),  // ✅
    nonce: 1,
    notAfter: scope.notAfter
  },
  {
    scaledAmount: calculateScaledAmount(30000n, granularity),  // ✅
    nonce: 2,
    notAfter: scope.notAfter
  },
]);
```

---

### 6. registerScope (parameter update needed)

**Files:** `settlement.test.ts`, `withdrawal.test.ts`, `dispute.test.ts`

This helper wraps `createAuthorizationScope` and `registerAuthorizationScope`.

**BEFORE:**
```typescript
async function registerScope(
  user: SignerWithAddress,
  agent: SignerWithAddress,
  totalAmount: bigint,
  disputeWindow: number = 3600,
  notBefore?: number,
  notAfter?: number
) {
  const { scope, signature } = await createAuthorizationScope(
    user, agent, totalAmount, disputeWindow, notBefore, notAfter
  );
  await zeroLC.registerAuthorizationScope(scope, signature);
  return scope;
}
```

**AFTER:**
```typescript
async function registerScope(
  user: SignerWithAddress,
  agent: SignerWithAddress,
  totalAmount: bigint,
  disputeWindow: number = 3600,
  notBefore?: number,
  notAfter?: number,
  amountGranularity: number = 0  // ✅ ADD THIS
) {
  const { scope, signature } = await createAuthorizationScope(
    user, agent, totalAmount, disputeWindow, notBefore, notAfter, amountGranularity  // ✅ PASS IT
  );
  await zeroLC.registerAuthorizationScope(scope, signature);
  return scope;
}
```

**Change Checklist:**
- [ ] Add `amountGranularity: number = 0` parameter
- [ ] Pass `amountGranularity` to `createAuthorizationScope` call

---

### 7. State Assertions - BREAKING CHANGES

**OLD Assertions (will cause errors):**
```typescript
const scopeState = await zeroLC.authorizationScopes(scopeHash);

// ❌ These fields NO LONGER EXIST - tests will fail
expect(scopeState.agentPendingAmount).to.equal(0);
expect(scopeState.nonce).to.equal(1);
expect(scopeState.withdrawalNonce).to.equal(0);
expect(scopeState.lastChargeTimestamp).to.equal(0);
expect(scopeState.isNumChargesRecorded).to.equal(0);
```

**NEW Assertions:**
```typescript
const scopeState = await zeroLC.authorizationScopes(scopeHash);

// ✅ Available fields
expect(scopeState.remainingAmount).to.equal(scaledAmount);
expect(scopeState.chargedAmountWithdrawable).to.equal(0);
expect(scopeState.chargedAmountFinalizing).to.equal(0);
expect(scopeState.chargedAmountPending).to.equal(0);
expect(scopeState.notAfter).to.equal(scope.notAfter);

// ✅ For agentPendingAmount, use contract function
const agentPending = await zeroLC.getAgentPendingAmount(scopeHash);
expect(agentPending).to.equal(expectedAmount);

// ⚠️ Cannot directly access: nonce, withdrawalNonce, isNumChargesRecorded
// These are embedded in nonceAndFlags (packed storage)
```

---

### Quick Reference - Fixture Return Updates

Update all `deployZeroLCFixture()` return statements to include new helpers:

```typescript
return {
  zeroLC,
  gasToken,
  universalSigValidator,
  owner,
  user1,
  user2,
  agent1,
  agent2,
  createAuthorizationScope,   // ✅ Updated implementation
  depositForUser,             // ✅ No changes needed
  registerScope,              // ✅ Updated implementation (if exists)
  createChargeBatch,          // ✅ Updated implementation (if exists)
  getAuthorizationScopeData,  // ✅ NEW - add this
  calculateScaledAmount,      // ✅ NEW - add this
};
```

---

### Summary - Helper Function Migration by File

| Test File | createAuthorizationScope | depositForUser | getAuthorizationScopeData | calculateScaledAmount | createChargeBatch | registerScope |
|-----------|--------------------------|----------------|---------------------------|----------------------|-------------------|---------------|
| `authorization.test.ts` | ✅ DONE | ✅ No change | ✅ DONE | ✅ DONE | N/A | N/A |
| `settlement.test.ts` | ⬜ TODO | ✅ No change | ⬜ ADD | ⬜ ADD | ⬜ TODO | ⬜ TODO |
| `withdrawal.test.ts` | ⬜ TODO | ✅ No change | ⬜ ADD | ⬜ ADD | ⬜ TODO | ⬜ TODO |
| `dispute.test.ts` | ⬜ TODO | ✅ No change | ⬜ ADD | ⬜ ADD | ⬜ TODO | ⬜ TODO |
| `compact.test.ts` | ✅ DONE | ✅ No change | ✅ DONE | ✅ DONE | N/A | N/A |
| `revocation.test.ts` | ✅ DONE | ✅ No change | ✅ DONE | ✅ DONE | N/A | N/A |
| `balances.test.ts` | ✅ DONE | ✅ No change | ✅ DONE | ✅ DONE | N/A | N/A |

**Legend:**
- ✅ = Completed
- ⬜ = Needs update
- N/A = Function doesn't exist in this file

---

## Additional Notes

### Amount Granularity Best Practices

For tests, recommended values:
- `amountGranularity = 0`: No scaling (simplest for tests, amounts stay as-is)
- `amountGranularity = 6`: USDC-like (divides by 1,000,000)
- `amountGranularity = 18`: ETH-like (divides by 10^18, but amounts must be in wei already)

### Timestamp Calculations

When testing time-sensitive features:
```typescript
const disputeWindow = 3600; // 1 hour
const notBefore = await time.latest();
const notAfter = notBefore + 86400; // 24 hours

// Ensure notAfter - notBefore fits in uint32
expect(notAfter - notBefore).to.be.lte(2n ** 32n - 1n);
```

### Three-State Pipeline Timing

Visual representation of amount flow:
```
Time 0: Charge settled
├─ chargedAmountPending: 100
├─ chargedAmountFinalizing: 0
└─ chargedAmountWithdrawable: 0

Time T (dispute window passes for finalizationTimestamp):
├─ chargedAmountPending: 100 (stays)
├─ chargedAmountFinalizing: 0 (previous finalizing moved to withdrawable)
└─ chargedAmountWithdrawable: 0

Time T + disputeWindow (dispute window passes for last charge):
├─ chargedAmountPending: 0
├─ chargedAmountFinalizing: 100 (pending moved here)
└─ chargedAmountWithdrawable: 0

Time 2T + disputeWindow (another dispute window passes):
├─ chargedAmountPending: 0
├─ chargedAmountFinalizing: 0
└─ chargedAmountWithdrawable: 100 (finalizing moved here, ready!)

Withdrawal possible: YES (chargedAmountWithdrawable > 0)
```

---

**Document Version**: 1.0
**Date**: 2025-01-07
**Contract Version**: Three-State Withdrawal System
**Last Git Commit**: (current HEAD)