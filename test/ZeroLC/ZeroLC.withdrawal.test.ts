import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeroLC, TestERC20, UniversalSigValidator } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ZeroLC - Agent Withdrawal", function () {
  // Fixture to deploy the contract and set up test environment
  async function deployZeroLCFixture() {
    const [owner, user1, user2, agent1, agent2] = await ethers.getSigners();

    // Deploy test ERC20 token to use as gas token
    const TestERC20Factory = await ethers.getContractFactory("TestERC20");
    const gasToken = (await TestERC20Factory.deploy(ethers.parseEther("1000000"))) as TestERC20;
    await gasToken.waitForDeployment();

    // Deploy UniversalSigValidator
    const UniversalSigValidatorFactory = await ethers.getContractFactory("UniversalSigValidator");
    const universalSigValidator = (await UniversalSigValidatorFactory.deploy()) as UniversalSigValidator;
    await universalSigValidator.waitForDeployment();

    // Deploy ZeroLC contract as implementation
    const ZeroLCFactory = await ethers.getContractFactory("ZeroLC");
    const zeroLCImpl = (await ZeroLCFactory.deploy(
      await gasToken.getAddress(),
      await universalSigValidator.getAddress()
    )) as ZeroLC;
    await zeroLCImpl.waitForDeployment();

    // Deploy a proxy pointing to the implementation
    const ERC1967ProxyFactory = await ethers.getContractFactory(
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy"
    );
    const initData = zeroLCImpl.interface.encodeFunctionData("initialize");
    const proxy = await ERC1967ProxyFactory.deploy(await zeroLCImpl.getAddress(), initData);
    await proxy.waitForDeployment();

    // Get the ZeroLC interface attached to the proxy address
    const zeroLC = ZeroLCFactory.attach(await proxy.getAddress()) as ZeroLC;

    // Distribute tokens to test users
    await gasToken.transfer(user1.address, ethers.parseEther("10000"));
    await gasToken.transfer(user2.address, ethers.parseEther("10000"));

    // Helper function to create and sign authorization scope
    async function createAuthorizationScope(
      user: SignerWithAddress,
      agent: SignerWithAddress,
      totalAmount: bigint,
      disputeWindow: number = 3600,
      notBefore?: number,
      notAfter?: number,
      amountGranularity: number = 0
    ) {
      const currentTime = await time.latest();
      const scope = {
        user: user.address,
        disputeWindow: disputeWindow,
        agent: agent.address,
        notBefore: notBefore ?? currentTime,
        notAfter: notAfter ?? currentTime + 86400, // 1 day from now
        totalAmount: totalAmount,
        amountGranularity: amountGranularity,
      };

      // Get domain separator
      const domain = {
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      };

      const types = {
        AuthorizationScope: [
          { name: "user", type: "address" },
          { name: "disputeWindow", type: "uint40" },
          { name: "agent", type: "address" },
          { name: "notBefore", type: "uint40" },
          { name: "notAfter", type: "uint40" },
          { name: "totalAmount", type: "uint128" },
          { name: "amountGranularity", type: "uint8" },
        ],
      };

      const signature = await user.signTypedData(domain, types, scope);

      return { scope, signature };
    }

    // Helper function to deposit tokens for a user
    async function depositForUser(user: SignerWithAddress, amount: bigint) {
      await gasToken.connect(user).approve(await zeroLC.getAddress(), amount);
      await zeroLC.connect(user)["deposit(uint256)"](amount);
    }

    // Helper function to register an authorization scope
    async function registerScope(
      user: SignerWithAddress,
      agent: SignerWithAddress,
      totalAmount: bigint,
      disputeWindow: number = 3600,
      notBefore?: number,
      notAfter?: number,
      amountGranularity: number = 0
    ) {
      const { scope, signature } = await createAuthorizationScope(
        user,
        agent,
        totalAmount,
        disputeWindow,
        notBefore,
        notAfter,
        amountGranularity
      );
      await zeroLC.registerAuthorizationScope(scope, signature);
      return scope;
    }

    // Helper function to create a charge batch with agent signature
    async function createChargeBatch(
      scope: any,
      agent: SignerWithAddress,
      entries: { scaledAmount: bigint; nonce: number; notAfter: number }[],
      timestamp?: number
    ) {
      const currentTime = await time.latest();
      const batchTimestamp = timestamp ?? currentTime;

      const chargeEntries = entries.map((e) => ({
        scaledAmount: e.scaledAmount,
        nonce: e.nonce,
        notAfter: e.notAfter,
      }));

      // Get scopeHash from contract to ensure it matches
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Create verifier struct
      let batchPartHash = "0x0000000000000000000000000000000000000000000000000000000000000000";
      if (chargeEntries.length > 1) {
        const entriesWithoutLast = chargeEntries.slice(0, -1);
        const encodedEntries = entriesWithoutLast.map((e) => [e.scaledAmount, e.nonce, e.notAfter]);
        batchPartHash = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(["tuple(uint32,uint24,uint40)[]"], [encodedEntries])
        );
      }

      const lastEntry = chargeEntries[chargeEntries.length - 1];

      // Encode the verifier struct components
      const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint32,uint24,uint40)", "bytes32"],
        [batchPartHash, [lastEntry.scaledAmount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
      );

      // Sign the verifier bytes
      const verifierBytes = ethers.getBytes(verifierEncoded);
      const agentSignature = await agent.signMessage(verifierBytes);

      return {
        scope: scope,
        entries: chargeEntries,
        timestamp: batchTimestamp,
        agentSignature: agentSignature,
      };
    }

    // Helper function to settle charges
    async function settleCharges(
      scope: any,
      agent: SignerWithAddress,
      entries: { scaledAmount: bigint; nonce: number; notAfter: number }[],
      timestamp?: number
    ) {
      const chargeBatch = await createChargeBatch(scope, agent, entries, timestamp);
      await zeroLC.settleCharges([chargeBatch]);
      return chargeBatch;
    }

    // Helper function to calculate scaled amounts
    function calculateScaledAmount(amount: bigint, granularity: number): bigint {
      return amount / (10n ** BigInt(granularity));
    }

    // Helper function to get authorization scope data
    async function getAuthorizationScopeData(scopeHash: string) {
      return await zeroLC.authorizationScopeData(scopeHash);
    }

    // Helper function to sign withdrawal request
    async function signWithdrawalRequest(
      agent: SignerWithAddress,
      scopeHash: string,
      toWallet: boolean,
      nonce: bigint
    ) {
      const domain = {
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      };

      const types = {
        WithdrawAgentChargedFund: [
          { name: "scopeHash", type: "bytes32" },
          { name: "toWallet", type: "bool" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        scopeHash: scopeHash,
        toWallet: toWallet,
        nonce: nonce,
      };

      return await agent.signTypedData(domain, types, value);
    }

    // Helper function to wait for first finalization (pending → finalizing)
    // First finalization happens when: block.timestamp >= notBefore + disputeWindow
    // Since settlement happens shortly after notBefore, we need to wait enough for first
    // finalization but not enough to trigger the second finalization (which depends on lastChargeTimestamp)
    async function waitForFirstFinalization(scope: any) {
      const currentTime = await time.latest();
      const firstFinalizationTime = scope.notBefore + scope.disputeWindow;
      const timeToWait = firstFinalizationTime - currentTime + 1; // +1 to ensure we're past the threshold
      if (timeToWait > 0) {
        await time.increase(timeToWait);
      }
    }

    // Helper function to wait for withdrawal to become available (both finalization steps)
    // The finalization requires:
    // 1. First transition: pending → finalizing when block.timestamp >= notBefore + disputeWindow
    // 2. Second transition: finalizing → withdrawable when block.timestamp >= lastChargeTimestamp + disputeWindow
    // Since we typically settle right after registration (notBefore ≈ settlementTime),
    // we need to wait ~disputeWindow for first transition, then another ~disputeWindow for second transition
    async function waitForWithdrawal(scope: any) {
      const currentTime = await time.latest();
      const firstFinalization = scope.notBefore + scope.disputeWindow;
      const waitTime = Math.max(0, firstFinalization - currentTime) + scope.disputeWindow + 10; // +10 for safety
      await time.increase(waitTime);
    }

    return {
      zeroLC,
      gasToken,
      universalSigValidator,
      owner,
      user1,
      user2,
      agent1,
      agent2,
      createAuthorizationScope,
      depositForUser,
      registerScope,
      createChargeBatch,
      settleCharges,
      calculateScaledAmount,
      getAuthorizationScopeData,
      signWithdrawalRequest,
      waitForFirstFinalization,
      waitForWithdrawal,
    };
  }

  // ============================================================================
  // Section 20.1 - Basic Withdrawal Flow (12 tests)
  // All tests use amountGranularity = 0 for simplicity
  // ============================================================================

  describe("Section 20.1 - Basic Withdrawal Flow", function () {
    // Use smaller amounts that fit in uint32 (max ~4.29 billion)
    // With amountGranularity=0, amounts must fit directly in uint32
    const MICRO_AMOUNT = 1000000n; // 1 million wei
    const CHARGE_AMOUNT = 100000n; // 100k wei
    const DISPUTE_WINDOW = 3600; // 1 hour

    it("should allow withdrawal when amounts reach withdrawable state (after 2 dispute windows)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForWithdrawal } =
        await loadFixture(deployZeroLCFixture);

      // Setup: deposit and register scope
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400
      );

      // Settle charges
      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      // Wait for amounts to reach withdrawable state
      await waitForWithdrawal(scope);

      // Withdrawal should succeed
      await expect(zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true))
        .to.not.be.reverted;
    });

    it("should withdraw to wallet (toWallet = true) and transfer ERC20 tokens to agent", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, settleCharges, waitForWithdrawal } =
        await loadFixture(deployZeroLCFixture);

      // Setup
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      await waitForWithdrawal(scope);

      // Get agent's token balance before withdrawal
      const balanceBefore = await gasToken.balanceOf(agent1.address);

      // Withdraw to wallet
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true);

      // Verify token transfer
      const balanceAfter = await gasToken.balanceOf(agent1.address);
      expect(balanceAfter - balanceBefore).to.equal(CHARGE_AMOUNT);
    });

    it("should withdraw to balance (toWallet = false) and credit agent's internal balance", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForWithdrawal } =
        await loadFixture(deployZeroLCFixture);

      // Setup
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      await waitForWithdrawal(scope);

      // Get agent's internal balance before withdrawal
      const userStateBefore = await zeroLC.userStates(agent1.address);

      // Withdraw to balance
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, false);

      // Verify internal balance credit
      const userStateAfter = await zeroLC.userStates(agent1.address);
      expect(userStateAfter.balance - userStateBefore.balance).to.equal(CHARGE_AMOUNT);
    });

    it("should fail with NoWithdrawableBalance when only amounts in pending state", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      // Setup
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      // Attempt withdrawal immediately (amounts still in pending)
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true)
      ).to.be.revertedWithCustomError(zeroLC, "NoWithdrawableBalance");
    });

    it("should fail with NoWithdrawableBalance when only amounts in finalizing state", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForFirstFinalization } =
        await loadFixture(deployZeroLCFixture);

      // Setup
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      // Use an earlier notBefore to create a gap between first and second finalization
      const notBefore = currentTime - DISPUTE_WINDOW / 2;
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        notBefore,
        currentTime + 86400
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      // Wait for first finalization (amounts move to finalizing, but not withdrawable yet)
      await waitForFirstFinalization(scope);

      // Attempt withdrawal (amounts in finalizing, not withdrawable)
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true)
      ).to.be.revertedWithCustomError(zeroLC, "NoWithdrawableBalance");
    });

    it("should update chargedAmountWithdrawable to 0 after successful withdrawal", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForWithdrawal } =
        await loadFixture(deployZeroLCFixture);

      // Setup
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      await waitForWithdrawal(scope);

      const scopeHash = await zeroLC.getScopeHash(scope);

      // Withdraw
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true);

      // Verify chargedAmountWithdrawable is cleared
      const state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.chargedAmountWithdrawable).to.equal(0);
    });

    it("should emit AgentWithdrawal event with correct parameters (unscaled amount, toWallet flag)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForWithdrawal } =
        await loadFixture(deployZeroLCFixture);

      // Setup
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      await waitForWithdrawal(scope);

      const scopeHash = await zeroLC.getScopeHash(scope);

      // Withdraw and verify event
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true)
      )
        .to.emit(zeroLC, "AgentWithdrawal")
        .withArgs(agent1.address, scopeHash, CHARGE_AMOUNT, true);
    });

    it("should fail with NoWithdrawableBalance when no charges have been settled", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } =
        await loadFixture(deployZeroLCFixture);

      // Setup: just register scope, no charges
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400
      );

      // Attempt withdrawal (no charges settled)
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true)
      ).to.be.revertedWithCustomError(zeroLC, "NoWithdrawableBalance");
    });

    it("should fail on second consecutive withdrawal if no new amounts finalized", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForWithdrawal } =
        await loadFixture(deployZeroLCFixture);

      // Setup
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      await waitForWithdrawal(scope);

      // First withdrawal succeeds
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true);

      // Second withdrawal fails (no new withdrawable amounts)
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true)
      ).to.be.revertedWithCustomError(zeroLC, "NoWithdrawableBalance");
    });

    it("should call _updateFinalizationState and verify state transitions", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForFirstFinalization } =
        await loadFixture(deployZeroLCFixture);

      // Setup
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      // Use an earlier notBefore to create a gap between first and second finalization
      const notBefore = currentTime - DISPUTE_WINDOW / 2;
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        notBefore,
        currentTime + 86400
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      const scopeHash = await zeroLC.getScopeHash(scope);

      // Verify initial state (amounts in pending)
      let state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.chargedAmountPending).to.equal(CHARGE_AMOUNT);
      expect(state.chargedAmountFinalizing).to.equal(0);
      expect(state.chargedAmountWithdrawable).to.equal(0);

      // Wait for first finalization
      await waitForFirstFinalization(scope);

      // Trigger _updateFinalizationState via a small settlement (to persist the state change)
      // A settlement will call _updateFinalizationState and save the result to storage
      await time.increase(1);
      const secondBatchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: 1n, nonce: 2, notAfter: currentTime + 86400 },
      ], secondBatchTimestamp);

      // Verify state transition (pending → finalizing, with 1 wei in pending from new charge)
      state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.chargedAmountPending).to.equal(1n); // The new 1 wei charge
      expect(state.chargedAmountFinalizing).to.equal(CHARGE_AMOUNT); // Previous charge moved to finalizing
      expect(state.chargedAmountWithdrawable).to.equal(0);

      // Now withdrawal should fail because nothing is withdrawable yet
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true)
      ).to.be.revertedWithCustomError(zeroLC, "NoWithdrawableBalance");

      // Wait another dispute window for second finalization
      await time.increase(scope.disputeWindow + 10);

      // Withdrawal succeeds (finalizing → withdrawable)
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true);

      // Verify final state (withdrawable cleared after withdrawal)
      state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.chargedAmountPending).to.equal(0);
      expect(state.chargedAmountFinalizing).to.equal(0);
      expect(state.chargedAmountWithdrawable).to.equal(0);
    });

    it("should withdraw exact amount equal to chargedAmountWithdrawable (unscaled)", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, settleCharges, waitForWithdrawal, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      // Setup
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      await waitForWithdrawal(scope);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      // Calculate expected withdrawal amount (unscaled)
      const expectedAmount = CHARGE_AMOUNT; // amountGranularity = 0, so no scaling

      // Get agent balance before
      const balanceBefore = await gasToken.balanceOf(agent1.address);

      // Withdraw
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true);

      // Verify exact amount withdrawn
      const balanceAfter = await gasToken.balanceOf(agent1.address);
      expect(balanceAfter - balanceBefore).to.equal(expectedAmount);
    });

    it("should verify getAgentPendingAmount excludes withdrawable amounts", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForFirstFinalization } =
        await loadFixture(deployZeroLCFixture);

      // Setup
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      // Use an earlier notBefore to create a gap between first and second finalization
      const notBefore = currentTime - DISPUTE_WINDOW / 2;
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        notBefore,
        currentTime + 86400
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      // Initially: amounts in pending, getAgentPendingAmount should return CHARGE_AMOUNT
      let pendingAmount = await zeroLC.getAgentPendingAmount(scope);
      expect(pendingAmount).to.equal(CHARGE_AMOUNT);

      // Wait for first finalization (pending → finalizing)
      await waitForFirstFinalization(scope);

      // Trigger state update via a small settlement (to persist the state change)
      await time.increase(1);
      const secondBatchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: 1n, nonce: 2, notAfter: currentTime + 86400 },
      ], secondBatchTimestamp);

      // Still in finalizing, getAgentPendingAmount should return CHARGE_AMOUNT + 1
      // (CHARGE_AMOUNT in finalizing + 1 in pending)
      pendingAmount = await zeroLC.getAgentPendingAmount(scope);
      expect(pendingAmount).to.equal(CHARGE_AMOUNT + 1n);

      // Wait another dispute window (finalizing → withdrawable)
      await time.increase(scope.disputeWindow + 10);

      // Trigger state update via another small settlement
      await time.increase(1);
      const thirdBatchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: 1n, nonce: 3, notAfter: currentTime + 86400 },
      ], thirdBatchTimestamp);

      // Now CHARGE_AMOUNT + 1 wei is withdrawable, getAgentPendingAmount should return only 1 wei pending
      // (The 1 wei from 2nd settlement also moved to withdrawable via double finalization,
      // only the 1 wei from 3rd settlement is still pending)
      pendingAmount = await zeroLC.getAgentPendingAmount(scope);
      expect(pendingAmount).to.equal(1n);
    });
  });

  // ============================================================================
  // Section 20.2 - Three-State Pipeline Progression (15 tests)
  // Focus on state transitions, granularity, and edge cases
  // ============================================================================

  describe("Section 20.2 - Three-State Pipeline Progression", function () {
    const MICRO_AMOUNT = 1000000n; // 1 million wei
    const CHARGE_AMOUNT = 100000n; // 100k wei
    const DISPUTE_WINDOW = 3600; // 1 hour

    it("should initialize scope with chargedAmountFinalizing and chargedAmountWithdrawable at zero", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } =
        await loadFixture(deployZeroLCFixture);

      // Setup: register scope
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400
      );

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      // Verify initial state: all three-state amounts are zero
      expect(state.chargedAmountPending).to.equal(0);
      expect(state.chargedAmountFinalizing).to.equal(0);
      expect(state.chargedAmountWithdrawable).to.equal(0);
    });

    it("should place new charges in chargedAmountPending after settlement", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      // Setup
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      // Verify: charges go to pending, not finalizing or withdrawable
      expect(state.chargedAmountPending).to.equal(CHARGE_AMOUNT);
      expect(state.chargedAmountFinalizing).to.equal(0);
      expect(state.chargedAmountWithdrawable).to.equal(0);
    });

    it("should move pending to finalizing after 1st dispute window", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForFirstFinalization } =
        await loadFixture(deployZeroLCFixture);

      // Setup with earlier notBefore to create gap
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const notBefore = currentTime - DISPUTE_WINDOW / 2;
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        notBefore,
        currentTime + 86400
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      // Wait for first finalization
      await waitForFirstFinalization(scope);

      // Trigger state update via small settlement
      await time.increase(1);
      const secondBatchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: 1n, nonce: 2, notAfter: currentTime + 86400 },
      ], secondBatchTimestamp);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      // Verify: previous pending moved to finalizing, new charge in pending
      expect(state.chargedAmountPending).to.equal(1n);
      expect(state.chargedAmountFinalizing).to.equal(CHARGE_AMOUNT);
      expect(state.chargedAmountWithdrawable).to.equal(0);
    });

    it("should move finalizing to withdrawable after 2nd dispute window", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForWithdrawal } =
        await loadFixture(deployZeroLCFixture);

      // Setup
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      // Wait for full withdrawal availability (2 dispute windows)
      await waitForWithdrawal(scope);

      // Trigger state update via withdrawal attempt (will succeed)
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      // Verify: amounts moved to withdrawable and then withdrawn (all zero)
      expect(state.chargedAmountPending).to.equal(0);
      expect(state.chargedAmountFinalizing).to.equal(0);
      expect(state.chargedAmountWithdrawable).to.equal(0); // Cleared after withdrawal
    });

    it("should accumulate first settlement in pending, then subsequent settlements trigger finalization", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      // Setup
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400
      );

      // Due to initialization (finalizationTimestamp = epoch = 0), the gas optimization
      // prevents finalization on the FIRST settlement, but the SECOND settlement will
      // trigger finalization (moving first charge to finalizing, second stays in pending)
      const charge1 = 30000n;
      const charge2 = 20000n;
      const charge3 = 15000n;

      // First settlement: goes to pending (gas optimization prevents finalization)
      await time.increase(1);
      let batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: charge1, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      let scopeHash = await zeroLC.getScopeHash(scope);
      let state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.chargedAmountPending).to.equal(charge1);
      expect(state.chargedAmountFinalizing).to.equal(0);

      // Second settlement: triggers first finalization because finalizationTimestamp points to epoch
      // First run: epoch + disputeWindow has definitely passed, so charge1 → finalizing
      // finalizationTimestamp updated to lastChargeTimestamp (1st settlement time)
      // Second run: Skipped (only 1 second elapsed since 1st settlement, need 3600 seconds)
      await time.increase(1);
      batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: charge2, nonce: 2, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.chargedAmountPending).to.equal(charge2);
      expect(state.chargedAmountFinalizing).to.equal(charge1);
      expect(state.chargedAmountWithdrawable).to.equal(0);

      // Third settlement: not enough time passed for another finalization
      await time.increase(1);
      batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: charge3, nonce: 3, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      state = await zeroLC.authorizationScopes(scopeHash);
      // After 3rd settlement, not enough time has passed for another finalization
      // Only 2 seconds elapsed since 1st settlement, need 3600 seconds (disputeWindow)
      // So charge1 stays in finalizing, charge2 and charge3 accumulate in pending
      expect(state.chargedAmountPending).to.equal(charge2 + charge3); // 35000
      expect(state.chargedAmountFinalizing).to.equal(charge1); // 30000
      expect(state.chargedAmountWithdrawable).to.equal(0);
    });

    it("should only allow withdrawal when chargedAmountWithdrawable > 0", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForWithdrawal } =
        await loadFixture(deployZeroLCFixture);

      // Setup
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      // Should fail before any finalization
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true)
      ).to.be.revertedWithCustomError(zeroLC, "NoWithdrawableBalance");

      // Wait for withdrawal availability
      await waitForWithdrawal(scope);

      // Should succeed now
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true)
      ).to.not.be.reverted;
    });

    it("should verify getAgentPendingAmount returns pending + finalizing (excludes withdrawable)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForFirstFinalization, waitForWithdrawal } =
        await loadFixture(deployZeroLCFixture);

      // Setup with earlier notBefore to create gap
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const notBefore = currentTime - DISPUTE_WINDOW / 2;
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        notBefore,
        currentTime + 86400
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      // Phase 1: All in pending
      let pendingAmount = await zeroLC.getAgentPendingAmount(scope);
      expect(pendingAmount).to.equal(CHARGE_AMOUNT);

      // Phase 2: Move to finalizing
      await waitForFirstFinalization(scope);
      await time.increase(1);
      const secondBatchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: 10n, nonce: 2, notAfter: currentTime + 86400 },
      ], secondBatchTimestamp);

      pendingAmount = await zeroLC.getAgentPendingAmount(scope);
      expect(pendingAmount).to.equal(CHARGE_AMOUNT + 10n); // finalizing + pending

      // Phase 3: Move to withdrawable (should exclude from pending)
      await time.increase(scope.disputeWindow + 10);
      await time.increase(1);
      const thirdBatchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: 5n, nonce: 3, notAfter: currentTime + 86400 },
      ], thirdBatchTimestamp);

      // Now CHARGE_AMOUNT + 10 is withdrawable, only 5 is pending
      pendingAmount = await zeroLC.getAgentPendingAmount(scope);
      expect(pendingAmount).to.equal(5n);
    });

    it("should handle state progression at exact boundary: block.timestamp == finalizationTimestamp + disputeWindow", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      // Setup with earlier notBefore to create controlled timing
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const notBefore = currentTime - DISPUTE_WINDOW / 2;
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        notBefore,
        currentTime + 86400
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      // Verify initial state: all in pending
      let scopeHash = await zeroLC.getScopeHash(scope);
      let state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.chargedAmountPending).to.equal(CHARGE_AMOUNT);
      expect(state.chargedAmountFinalizing).to.equal(0);

      // Calculate exact boundary: notBefore + disputeWindow
      const firstFinalizationTime = notBefore + DISPUTE_WINDOW;

      // Set time to exactly the boundary
      await time.setNextBlockTimestamp(firstFinalizationTime);

      // Settle at exact boundary (settleCharges will call _updateFinalizationState)
      await settleCharges(scope, agent1, [
        { scaledAmount: 1n, nonce: 2, notAfter: currentTime + 86400 },
      ], firstFinalizationTime);

      state = await zeroLC.authorizationScopes(scopeHash);

      // At exact boundary, finalization should occur
      // First charge moves to finalizing, second charge stays in pending
      expect(state.chargedAmountFinalizing).to.equal(CHARGE_AMOUNT);
      expect(state.chargedAmountPending).to.equal(1n);
    });

    it("should verify gas optimization prevents finalization on first settlement", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      // Setup
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400
      );

      // First settlement: gas optimization prevents finalization
      // (finalizationTimestamp == lastChargeTimestamp initially)
      await time.increase(1);
      const firstBatchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: CHARGE_AMOUNT, nonce: 1, notAfter: currentTime + 86400 },
      ], firstBatchTimestamp);

      // Verify: all in pending, nothing in finalizing or withdrawable
      let scopeHash = await zeroLC.getScopeHash(scope);
      let state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.chargedAmountPending).to.equal(CHARGE_AMOUNT);
      expect(state.chargedAmountFinalizing).to.equal(0);
      expect(state.chargedAmountWithdrawable).to.equal(0);
    });

    it("should handle pipeline progression with amountGranularity = 3 (verify scaled storage, unscaled retrieval)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForWithdrawal, calculateScaledAmount, gasToken } =
        await loadFixture(deployZeroLCFixture);

      const granularity = 3;
      const unscaledAmount = 1000000n; // 1 million wei
      const unscaledCharge = 100000n; // 100k wei
      const scaledCharge = calculateScaledAmount(unscaledCharge, granularity);

      // Setup with granularity
      await depositForUser(user1, unscaledAmount);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        unscaledAmount,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400,
        granularity
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: scaledCharge, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      const scopeHash = await zeroLC.getScopeHash(scope);
      let state = await zeroLC.authorizationScopes(scopeHash);

      // Verify scaled storage
      expect(state.chargedAmountPending).to.equal(scaledCharge);

      // Wait for withdrawal
      await waitForWithdrawal(scope);

      // Get balance before withdrawal
      const balanceBefore = await gasToken.balanceOf(agent1.address);

      // Withdraw
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true);

      // Verify unscaled retrieval
      const balanceAfter = await gasToken.balanceOf(agent1.address);
      expect(balanceAfter - balanceBefore).to.equal(unscaledCharge);
    });

    it("should handle pipeline progression with amountGranularity = 6 (USDC-like)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForWithdrawal, calculateScaledAmount, gasToken } =
        await loadFixture(deployZeroLCFixture);

      const granularity = 6;
      const unscaledAmount = 1000000000n; // 1 billion wei
      const unscaledCharge = 100000000n; // 100 million wei
      const scaledCharge = calculateScaledAmount(unscaledCharge, granularity);

      // Setup with granularity
      await depositForUser(user1, unscaledAmount);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        unscaledAmount,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400,
        granularity
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: scaledCharge, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      const scopeHash = await zeroLC.getScopeHash(scope);
      let state = await zeroLC.authorizationScopes(scopeHash);

      // Verify scaled storage
      expect(state.chargedAmountPending).to.equal(scaledCharge);

      // Wait for withdrawal
      await waitForWithdrawal(scope);

      // Get balance before withdrawal
      const balanceBefore = await gasToken.balanceOf(agent1.address);

      // Withdraw
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true);

      // Verify unscaled retrieval
      const balanceAfter = await gasToken.balanceOf(agent1.address);
      expect(balanceAfter - balanceBefore).to.equal(unscaledCharge);
    });

    it("should handle pipeline progression with amountGranularity = 12 (high precision)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForWithdrawal, calculateScaledAmount, gasToken } =
        await loadFixture(deployZeroLCFixture);

      const granularity = 12;
      const unscaledAmount = 1000000000000000n; // 10^15 wei
      const unscaledCharge = 100000000000000n; // 10^14 wei
      const scaledCharge = calculateScaledAmount(unscaledCharge, granularity);

      // Setup with granularity
      await depositForUser(user1, unscaledAmount);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        unscaledAmount,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400,
        granularity
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: scaledCharge, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      const scopeHash = await zeroLC.getScopeHash(scope);
      let state = await zeroLC.authorizationScopes(scopeHash);

      // Verify scaled storage
      expect(state.chargedAmountPending).to.equal(scaledCharge);

      // Wait for withdrawal
      await waitForWithdrawal(scope);

      // Get balance before withdrawal
      const balanceBefore = await gasToken.balanceOf(agent1.address);

      // Withdraw
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true);

      // Verify unscaled retrieval
      const balanceAfter = await gasToken.balanceOf(agent1.address);
      expect(balanceAfter - balanceBefore).to.equal(unscaledCharge);
    });

    it("should verify withdrawn amount == chargedAmountWithdrawable * 10^amountGranularity", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForWithdrawal, calculateScaledAmount, gasToken } =
        await loadFixture(deployZeroLCFixture);

      const granularity = 3;
      const unscaledAmount = 1000000n;
      const unscaledCharge = 123000n; // Must be divisible by 10^3 to avoid truncation
      const scaledCharge = calculateScaledAmount(unscaledCharge, granularity);

      // Setup
      await depositForUser(user1, unscaledAmount);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        unscaledAmount,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400,
        granularity
      );

      await time.increase(1);
      const batchTimestamp = await time.latest();
      await settleCharges(scope, agent1, [
        { scaledAmount: scaledCharge, nonce: 1, notAfter: currentTime + 86400 },
      ], batchTimestamp);

      await waitForWithdrawal(scope);

      const scopeHash = await zeroLC.getScopeHash(scope);

      // Get balance before withdrawal
      const balanceBefore = await gasToken.balanceOf(agent1.address);

      // Withdraw
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true);

      // Verify: withdrawn amount = scaledAmount * 10^granularity
      const balanceAfter = await gasToken.balanceOf(agent1.address);
      const withdrawnAmount = balanceAfter - balanceBefore;

      // Calculate expected unscaled amount
      const expectedAmount = scaledCharge * (10n ** BigInt(granularity));
      expect(withdrawnAmount).to.equal(expectedAmount);

      // Also verify it equals the original unscaled charge
      expect(withdrawnAmount).to.equal(unscaledCharge);
    });

    it("should handle multiple settlements with cascading finalization through pipeline", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, waitForWithdrawal, gasToken } =
        await loadFixture(deployZeroLCFixture);

      // Setup
      await depositForUser(user1, MICRO_AMOUNT);
      const currentTime = await time.latest();
      const scope = await registerScope(
        user1,
        agent1,
        MICRO_AMOUNT,
        DISPUTE_WINDOW,
        currentTime,
        currentTime + 86400
      );

      // Settle multiple charges - each settlement after the first triggers finalization
      const charges = [30000n, 20000n, 15000n, 10000n];
      let nonce = 1;

      for (const charge of charges) {
        await time.increase(1);
        const batchTimestamp = await time.latest();
        await settleCharges(scope, agent1, [
          { scaledAmount: charge, nonce: nonce++, notAfter: currentTime + 86400 },
        ], batchTimestamp);
      }

      const scopeHash = await zeroLC.getScopeHash(scope);
      let state = await zeroLC.authorizationScopes(scopeHash);

      // After 4 settlements with only 1 second between each:
      // 1st: 30000 → pending (gas optimization prevents finalization)
      // 2nd: 30000 → finalizing (epoch + disputeWindow passed), 20000 → pending
      // 3rd: Nothing moves (only 2 seconds since 1st settlement), 35000 in pending, 30000 in finalizing
      // 4th: Nothing moves (only 3 seconds since 1st settlement), 45000 in pending, 30000 in finalizing
      expect(state.chargedAmountPending).to.equal(20000n + 15000n + 10000n); // 45000
      expect(state.chargedAmountFinalizing).to.equal(30000n); // First charge still finalizing
      expect(state.chargedAmountWithdrawable).to.equal(0);

      // Wait for remaining charges to finalize
      await waitForWithdrawal(scope);

      // Get balance before withdrawal
      const balanceBefore = await gasToken.balanceOf(agent1.address);

      // Withdraw all finalized amounts
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true);

      // Verify all charges eventually withdrawn
      const balanceAfter = await gasToken.balanceOf(agent1.address);
      const totalCharge = charges.reduce((sum, c) => sum + c, 0n);
      expect(balanceAfter - balanceBefore).to.equal(totalCharge);
    });
  });
});
