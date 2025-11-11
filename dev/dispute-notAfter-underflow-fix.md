# Fix for Arithmetic Underflow in dispute() Function

## Problem

When `dispute()` sets `state.notAfter = uint40(block.timestamp)` (line 734 in ZeroLC.sol), it causes arithmetic underflow in subsequent withdrawal attempts.

**Root Cause:**
- Timestamp offsets (`finalizationTimestamp` and `lastChargeTimestamp`) are stored relative to the **original** `notAfter`
- Formula: `offset = originalNotAfter - realTimestamp`
- When retrieving: `realTimestamp = notAfter - offset`
- After dispute updates `notAfter` to `block.timestamp` (which is typically much earlier than original `notAfter`), the calculation `newNotAfter - offset` underflows

**Example:**
```
Original notAfter = 1000000
Settlement at timestamp = 999000
Stored offset = 1000000 - 999000 = 1000

After dispute:
New notAfter = block.timestamp = 999500
Attempting to retrieve: realTimestamp = 999500 - 1000 = 998500 ✓ (works)

But if dispute happens later:
New notAfter = block.timestamp = 999100
Attempting to retrieve: realTimestamp = 999100 - 1000 = UNDERFLOW ✗
```

## Proposed Fix

Update the `dispute()` function to recalculate timestamp offsets when updating `notAfter`:

### Location
File: `contracts/ZeroLC.sol`
Lines: After line 733, before line 734

### Code Change

**Before:**
```solidity
state.chargedAmountFinalizing = newFinalizing;
state.chargedAmountPending = newPending;
state.notAfter = uint40(block.timestamp);
authorizationScopes[scopeHash] = state;
```

**After:**
```solidity
state.chargedAmountFinalizing = newFinalizing;
state.chargedAmountPending = newPending;

// When updating notAfter, recalculate timestamp offsets to prevent underflow
// Offsets are stored as: offset = notAfter - realTimestamp
uint40 oldNotAfter = state.notAfter;
uint40 newNotAfter = uint40(block.timestamp);

// Calculate real timestamps from old offsets
uint40 realFinalizationTimestamp = oldNotAfter - state.finalizationTimestamp;
uint40 realLastChargeTimestamp = oldNotAfter - state.lastChargeTimestamp;

// Calculate new offsets relative to new notAfter
// If real timestamp > new notAfter (in the future), cap offset at 0
state.finalizationTimestamp = newNotAfter > realFinalizationTimestamp
    ? uint32(newNotAfter - realFinalizationTimestamp)
    : 0;
state.lastChargeTimestamp = newNotAfter > realLastChargeTimestamp
    ? uint32(newNotAfter - realLastChargeTimestamp)
    : 0;
state.notAfter = newNotAfter;

authorizationScopes[scopeHash] = state;
```

## Test Cases Affected

The following tests will pass after this fix:
- Section 20.10: All dispute-related withdrawal tests
- Section 20.11: Dispute after scope expiration test

## Alternative Approach

If you prefer not to recalculate offsets, another approach would be to:
1. Keep the original `notAfter` stored separately in `AuthorizationScopeData`
2. Use the original `notAfter` for offset calculations
3. Use the updated `notAfter` only for settlement validation

However, the proposed fix is simpler and maintains the existing storage structure.
