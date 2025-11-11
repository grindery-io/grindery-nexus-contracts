import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeroLC, TestERC20, UniversalSigValidator, SettlementCaller } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ZeroLC - Charge Settlement", function () {
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

    // Deploy SettlementCaller helper contract for testing contract-to-contract calls
    const SettlementCallerFactory = await ethers.getContractFactory("SettlementCaller");
    const settlementCaller = (await SettlementCallerFactory.deploy()) as SettlementCaller;
    await settlementCaller.waitForDeployment();

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
        // Contract uses: keccak256(abi.encode(chargeBatch.entries[0:numCharges - 1]))
        // which encodes the array slice
        const encodedEntries = entriesWithoutLast.map((e) => [e.scaledAmount, e.nonce, e.notAfter]);
        batchPartHash = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(["tuple(uint32,uint24,uint40)[]"], [encodedEntries])
        );
      }

      const lastEntry = chargeEntries[chargeEntries.length - 1];

      // Encode the verifier struct components
      // Contract uses: abi.encode(ChargeBatchVerifier) which encodes the struct fields in order
      const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint32,uint24,uint40)", "bytes32"],
        [batchPartHash, [lastEntry.scaledAmount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
      );

      // IMPORTANT: The contract uses MessageHashUtils.toEthSignedMessageHash(abi.encode(verifier))
      // We need to convert the hex string to bytes before signing!
      // ethers.signMessage needs a Uint8Array, not a hex string, to properly compute the message hash
      const verifierBytes = ethers.getBytes(verifierEncoded);
      const agentSignature = await agent.signMessage(verifierBytes);

      return {
        scope: scope,
        entries: chargeEntries,
        timestamp: batchTimestamp,
        agentSignature: agentSignature,
      };
    }

    // Helper function to calculate scaled amounts
    function calculateScaledAmount(amount: bigint, granularity: number): bigint {
      return amount / (10n ** BigInt(granularity));
    }

    // Helper function to get authorization scope data
    async function getAuthorizationScopeData(scopeHash: string) {
      return await zeroLC.authorizationScopeData(scopeHash);
    }

    return {
      zeroLC,
      gasToken,
      universalSigValidator,
      settlementCaller,
      owner,
      user1,
      user2,
      agent1,
      agent2,
      createAuthorizationScope,
      depositForUser,
      registerScope,
      createChargeBatch,
      calculateScaledAmount,
      getAuthorizationScopeData,
    };
  }

  describe("5.1 Valid Settlement", function () {
    it("should settle single charge batch with one entry", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;

      // Verify state updates
      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      expect(state.remainingAmount).to.equal(calculateScaledAmount(totalAmount - 1000n, granularity));
      const agentPending = await zeroLC.getAgentPendingAmount(scope);
      expect(agentPending).to.equal(1000n);
      expect(state.chargedAmountPending).to.equal(calculateScaledAmount(1000n, granularity));
      expect(state.chargedAmountFinalizing).to.equal(0);
      expect(state.chargedAmountWithdrawable).to.equal(0);
      const nonce = await zeroLC.getScopeNonce(scopeHash);
      expect(nonce).to.equal(2);
      const expectedOffset = scope.notAfter - chargeBatch.timestamp;
      expect(state.lastChargeTimestamp).to.equal(expectedOffset);
    });

    it("should settle single charge batch with multiple entries", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
        { scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: currentTime + 3600 },
        { scaledAmount: calculateScaledAmount(1500n, granularity), nonce: 3, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;

      // Verify state updates
      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      expect(state.remainingAmount).to.equal(calculateScaledAmount(totalAmount - 4500n, granularity));
      const agentPending = await zeroLC.getAgentPendingAmount(scope);
      expect(agentPending).to.equal(4500n);
      const nonce = await zeroLC.getScopeNonce(scopeHash);
      expect(nonce).to.equal(4); // Started at 1, processed 3 entries
    });

    it("should settle multiple charge batches in one transaction", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch1 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 }],
        currentTime
      );

      // Second batch must have later timestamp
      await time.increase(10);
      const laterTime = await time.latest();
      const chargeBatch2 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: laterTime + 3600 }],
        laterTime
      );

      await expect(zeroLC.settleCharges([chargeBatch1, chargeBatch2])).to.not.be.reverted;

      // Verify final state
      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      expect(state.remainingAmount).to.equal(calculateScaledAmount(totalAmount - 3000n, granularity));
      const agentPending = await zeroLC.getAgentPendingAmount(scope);
      expect(agentPending).to.equal(3000n);
      const nonce = await zeroLC.getScopeNonce(scopeHash);
      expect(nonce).to.equal(3);
    });

    it("should settle charges with sequential nonces", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // First settlement
      const batch1 = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);
      await zeroLC.settleCharges([batch1]);

      // Second settlement with next nonce
      await time.increase(10);
      const laterTime = await time.latest();
      const batch2 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: laterTime + 3600 }],
        laterTime
      );
      await zeroLC.settleCharges([batch2]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const nonce = await zeroLC.getScopeNonce(scopeHash);
      expect(nonce).to.equal(3);
    });

    it("should update remainingAmount correctly", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeAmount = 15000n;
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(chargeAmount, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await zeroLC.settleCharges([chargeBatch]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      expect(state.remainingAmount).to.equal(calculateScaledAmount(totalAmount - chargeAmount, granularity));
    });

    it("should update chargedAmountPending correctly", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(10000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await zeroLC.settleCharges([chargeBatch]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      // First settlement: all charges go to pending (gas optimization prevents finalization)
      expect(state.chargedAmountPending).to.equal(calculateScaledAmount(10000n, granularity));
      expect(state.chargedAmountFinalizing).to.equal(0);

      // Settle more charges
      await time.increase(10);
      const laterTime = await time.latest();
      const chargeBatch2 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(5000n, granularity), nonce: 2, notAfter: laterTime + 3600 }],
        laterTime
      );

      await zeroLC.settleCharges([chargeBatch2]);

      const state2 = await zeroLC.authorizationScopes(scopeHash);
      // Second settlement: first charge moves to finalizing (epoch + disputeWindow has passed)
      // Second charge goes to pending
      expect(state2.chargedAmountPending).to.equal(calculateScaledAmount(5000n, granularity));
      expect(state2.chargedAmountFinalizing).to.equal(calculateScaledAmount(10000n, granularity));
      expect(state2.chargedAmountWithdrawable).to.equal(0);
    });

    it("should update lastChargeTimestamp offset correctly", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 }],
        currentTime
      );

      await zeroLC.settleCharges([chargeBatch]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      // lastChargeTimestamp is stored as offset from notAfter
      const expectedOffset = scope.notAfter - currentTime;
      expect(state.lastChargeTimestamp).to.equal(expectedOffset);
    });

    it("should update nonce correctly (increments by number of entries)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
        { scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: currentTime + 3600 },
        { scaledAmount: calculateScaledAmount(3000n, granularity), nonce: 3, notAfter: currentTime + 3600 },
        { scaledAmount: calculateScaledAmount(4000n, granularity), nonce: 4, notAfter: currentTime + 3600 },
        { scaledAmount: calculateScaledAmount(5000n, granularity), nonce: 5, notAfter: currentTime + 3600 },
      ]);

      await zeroLC.settleCharges([chargeBatch]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const nonce = await zeroLC.getScopeNonce(scopeHash);
      expect(nonce).to.equal(6); // Started at 1, processed 5 entries
    });

    it("should emit ChargesSettled event when tx.origin == msg.sender", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      // When called directly (tx.origin == msg.sender), should emit ChargesSettled event without parameters
      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.emit(zeroLC, "ChargesSettled")
        .to.not.emit(zeroLC, "ChargesSettledFromContract");
    });

    it("should maintain FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED flag", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await zeroLC.settleCharges([chargeBatch]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const flags = await zeroLC.getScopeFlags(scopeHash);

      // FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED (bit 23) should remain 0 until compaction
      const FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED = BigInt(1 << 23);
      expect(Number(flags) & Number(FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED)).to.equal(0);
    });
  });

  describe("5.2 Signature Verification", function () {
    it("should settle with valid agent ECDSA signature", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;
    });

    it("should revert with invalid agent signature", async function () {
      const { zeroLC, user1, user2, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // Create batch but sign with wrong signer
      const chargeBatch = await createChargeBatch(scope, user2, [
        // user2 instead of agent1
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(zeroLC, "InvalidAgentSignature");
    });

    it("should revert with wrong agent signing", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // Create batch signed by agent2 instead of agent1
      const chargeBatch = await createChargeBatch(scope, agent2, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(zeroLC, "InvalidAgentSignature");
    });

    it("should settle with single entry (batchPartHash == 0x00)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      // Single entry should have batchPartHash of all zeros
      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;
    });

    it("should settle with multiple entries (batchPartHash verified)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
        { scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: currentTime + 3600 },
        { scaledAmount: calculateScaledAmount(3000n, granularity), nonce: 3, notAfter: currentTime + 3600 },
      ]);

      // Multiple entries should verify batchPartHash correctly
      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;
    });

    it("should revert with tampered batchPartHash", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
        { scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: currentTime + 3600 },
      ]);

      // Tamper with the first entry after signing
      chargeBatch.entries[0].scaledAmount = 9999n;

      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(zeroLC, "InvalidAgentSignature");
    });

    it("should revert with tampered lastEntry", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      // Tamper with the last entry amount after signing
      chargeBatch.entries[0].scaledAmount = 9999n;

      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(zeroLC, "InvalidAgentSignature");
    });

    it("should revert with tampered scopeHash", async function () {
      const { zeroLC, user1, user2, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);
      await depositForUser(user2, totalAmount);

      const scope1 = await registerScope(user1, agent1, totalAmount);
      const scope2 = await registerScope(user2, agent1, totalAmount);

      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope1, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      // Tamper with scope by substituting user
      chargeBatch.scope = scope2;

      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(zeroLC, "InvalidAgentSignature");
    });

    it("should use correct verifier struct encoding", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // Test that the encoding matches what the contract expects
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
        { scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: currentTime + 3600 },
      ]);

      // If encoding is correct, settlement should succeed
      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;
    });
  });

  describe("5.3 Timestamp Validation", function () {
    it("should settle with timestamp within valid 60-second window", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);

      // Advance time enough so we can create a batch with past timestamp that's still > registration time
      await time.increase(40);
      const currentTime = await time.latest();

      // Create batch with timestamp 30 seconds in the past (well within 60-second window)
      // but still > registration time (which was 41 seconds ago)
      const pastTime = currentTime - 30;
      const chargeBatch = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 }],
        pastTime
      );

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;
    });

    it("should revert with timestamp == block.timestamp - 60 (boundary)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // Create batch with timestamp exactly 60 seconds in the past
      const pastTime = currentTime - 60;
      const chargeBatch = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 }],
        pastTime
      );

      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(
        zeroLC,
        "BatchTimestampOutOfRange"
      );
    });

    it("should settle with timestamp within 59 seconds window (boundary)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);

      // Advance time enough so we can create a batch with past timestamp that's still > registration time
      await time.increase(59);

      // Get current time
      let currentTime = await time.latest();

      // Create batch with timestamp 55 seconds in the past (safely within the 60-second window)
      // but still > registration time (which was 60 seconds ago)
      const pastTime = currentTime - 55;
      const chargeBatch = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 }],
        pastTime
      );

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;
    });

    it("should settle with timestamp == block.timestamp (boundary)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 }],
        currentTime
      );

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;
    });

    it("should revert with timestamp < block.timestamp - 60", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // Create batch with timestamp 120 seconds in the past
      const pastTime = currentTime - 120;
      const chargeBatch = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 }],
        pastTime
      );

      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(
        zeroLC,
        "BatchTimestampOutOfRange"
      );
    });

    it("should revert with timestamp > block.timestamp", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // Create batch with timestamp in the future
      const futureTime = currentTime + 10;
      const chargeBatch = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 }],
        futureTime
      );

      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(
        zeroLC,
        "BatchTimestampOutOfRange"
      );
    });

    it("should revert with timestamp <= lastChargeTimestamp", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // First settlement
      const batch1 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 }],
        currentTime
      );
      await zeroLC.settleCharges([batch1]);

      // Try to settle with same timestamp
      const batch2 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: currentTime + 3600 }],
        currentTime
      );

      await expect(zeroLC.settleCharges([batch2])).to.be.revertedWithCustomError(zeroLC, "BatchTimestampNotIncreasing");
    });

    it("should settle with timestamp == lastChargeTimestamp + 1 (boundary)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // First settlement
      const batch1 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 }],
        currentTime
      );
      await zeroLC.settleCharges([batch1]);

      // Advance time by 1 second
      await time.increase(1);
      const nextTime = await time.latest();

      // Settle with timestamp exactly 1 second after last charge
      const batch2 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: nextTime + 3600 }],
        nextTime
      );

      await expect(zeroLC.settleCharges([batch2])).to.not.be.reverted;
    });

    it("should settle multiple batches with increasing timestamps", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // First batch
      const batch1 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 }],
        currentTime
      );
      await zeroLC.settleCharges([batch1]);

      // Second batch with later timestamp
      await time.increase(5);
      const time2 = await time.latest();
      const batch2 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: time2 + 3600 }],
        time2
      );
      await zeroLC.settleCharges([batch2]);

      // Third batch with even later timestamp
      await time.increase(5);
      const time3 = await time.latest();
      const batch3 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(3000n, granularity), nonce: 3, notAfter: time3 + 3600 }],
        time3
      );
      await zeroLC.settleCharges([batch3]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);
      const nonce = await zeroLC.getScopeNonce(scopeHash);
      expect(nonce).to.equal(4);
    });
  });

  describe("5.4 Nonce Validation", function () {
    it("should settle with correct sequential nonces starting from 1", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
        { scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: currentTime + 3600 },
        { scaledAmount: calculateScaledAmount(3000n, granularity), nonce: 3, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;
    });

    it("should revert with wrong nonce", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // Start with nonce 2 instead of 1
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 2, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(zeroLC, "InvalidNonce");
    });

    it("should revert with skipped nonce", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // Skip from nonce 1 to 3
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
        { scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 3, notAfter: currentTime + 3600 }, // Skipped 2
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(zeroLC, "InvalidNonce");
    });

    it("should revert with repeated nonce", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // First settlement with nonce 1
      const batch1 = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);
      await zeroLC.settleCharges([batch1]);

      // Try to settle again with nonce 1
      await time.increase(5);
      const laterTime = await time.latest();
      const batch2 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 1, notAfter: laterTime + 3600 }],
        laterTime
      );

      await expect(zeroLC.settleCharges([batch2])).to.be.revertedWithCustomError(zeroLC, "InvalidNonce");
    });

    it("should settle multiple batches incrementing nonces correctly", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // First batch: nonces 1-3
      const batch1 = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 2, notAfter: currentTime + 3600 },
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 3, notAfter: currentTime + 3600 },
      ]);
      await zeroLC.settleCharges([batch1]);

      // Second batch: nonces 4-6
      await time.increase(5);
      const time2 = await time.latest();
      const batch2 = await createChargeBatch(
        scope,
        agent1,
        [
          { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 4, notAfter: time2 + 3600 },
          { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 5, notAfter: time2 + 3600 },
          { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 6, notAfter: time2 + 3600 },
        ],
        time2
      );
      await zeroLC.settleCharges([batch2]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);
      const nonce = await zeroLC.getScopeNonce(scopeHash);
      expect(nonce).to.equal(7);
    });

    it("should persist nonce across multiple settlements", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      let currentTime = await time.latest();

      // Settlement 1
      const batch1 = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);
      await zeroLC.settleCharges([batch1]);

      // Settlement 2
      await time.increase(5);
      currentTime = await time.latest();
      const batch2 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 2, notAfter: currentTime + 3600 }],
        currentTime
      );
      await zeroLC.settleCharges([batch2]);

      // Settlement 3
      await time.increase(5);
      currentTime = await time.latest();
      const batch3 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 3, notAfter: currentTime + 3600 }],
        currentTime
      );
      await zeroLC.settleCharges([batch3]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);
      const nonce = await zeroLC.getScopeNonce(scopeHash);
      expect(nonce).to.equal(4);
    });

    it("should have nonce start at 1 for new scope", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      const nonce = await zeroLC.getScopeNonce(scopeHash);
      expect(nonce).to.equal(1);
    });
  });

  describe("5.5 Amount & Balance", function () {
    it("should settle with totalAmount < remainingAmount", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(50000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.remainingAmount).to.equal(50000n);
    });

    it("should settle with totalAmount == remainingAmount (exact drain)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(100000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.remainingAmount).to.equal(0);
      const agentPending = await zeroLC.getAgentPendingAmount(scope);
      expect(agentPending).to.equal(100000n);
    });

    it("should revert with totalAmount > remainingAmount", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(100001n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(zeroLC, "InsufficientBalance");
    });

    it("should revert with zero amount entries", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(0n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(zeroLC, "InvalidChargeAmount");
    });

    it("should settle with uint48 max amount (overflow check)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      // Test with large amount that fits in uint32 after scaling (uint32 max with granularity 0)
      const maxUint32 = (1n << 32n) - 1n;
      const granularity = 0;
      await depositForUser(user1, maxUint32);

      const scope = await registerScope(user1, agent1, maxUint32, 3600, undefined, undefined, granularity);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(maxUint32, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;
    });

    it("should ensure all entries have amount > 0", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
        { scaledAmount: calculateScaledAmount(0n, granularity), nonce: 2, notAfter: currentTime + 3600 }, // Zero amount
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(zeroLC, "InvalidChargeAmount");
    });
  });

  describe("5.6 Entry Expiration", function () {
    it("should settle with entry.notAfter > block.timestamp (valid, not expired)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 }, // Expires 1 hour from now
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;
    });

    it("should settle with entry.notAfter == block.timestamp + 1 (boundary, valid)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);

      // Get current time right before creating the batch
      let currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(
        scope,
        agent1,
        [
          { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 2 }, // notAfter will be block.timestamp + 1 when settled
        ],
        currentTime
      );

      // notAfter is EXCLUSIVE, so entry.notAfter == block.timestamp + 1 is still valid
      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;
    });

    it("should revert with entry.notAfter == block.timestamp (boundary, expired)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);

      // Get current time right before creating the batch
      let currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(
        scope,
        agent1,
        [
          { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 1 }, // notAfter will equal block.timestamp when settled
        ],
        currentTime
      );

      // notAfter is EXCLUSIVE, so entry.notAfter == block.timestamp means expired
      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(zeroLC, "ChargeEntryExpired");
    });

    it("should revert with entry.notAfter < block.timestamp (expired)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime - 1 }, // Already expired
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(zeroLC, "ChargeEntryExpired");
    });

    it("should settle multiple entries with different notAfter values", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 1800 }, // 30 min
        { scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: currentTime + 3600 }, // 1 hour
        { scaledAmount: calculateScaledAmount(1500n, granularity), nonce: 3, notAfter: currentTime + 7200 }, // 2 hours
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;
    });
  });

  describe("5.7 Scope Status", function () {
    it("should settle with active scope (notAfter > block.timestamp)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, 3600, currentTime, currentTime + 86400);
      await time.increase(1);

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;
    });

    it("should revert with expired scope", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      // Create scope that expires in 10 seconds
      const scope = await registerScope(user1, agent1, totalAmount, 3600, currentTime, currentTime + 10);
      await time.increase(1);

      // Advance time past scope expiration
      await time.increase(15);

      const laterTime = await time.latest();
      const chargeBatch = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: laterTime + 3600 }],
        laterTime
      );

      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(
        zeroLC,
        "AuthorizationScopeExpired"
      );
    });

    it("should revert with scope notAfter == block.timestamp", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      // Create scope that expires in 5 seconds
      const scope = await registerScope(user1, agent1, totalAmount, 3600, currentTime, currentTime + 5);
      await time.increase(1);

      // Advance time to exactly the expiration
      await time.increase(5);

      const expirationTime = await time.latest();
      const chargeBatch = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: expirationTime + 3600 }],
        expirationTime
      );

      await expect(zeroLC.settleCharges([chargeBatch])).to.be.revertedWithCustomError(
        zeroLC,
        "AuthorizationScopeExpired"
      );
    });

    it("should settle with scope notAfter == block.timestamp + 1 (boundary)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      // Create scope that expires 20 seconds from now
      const expirationTime = currentTime + 20;
      const scope = await registerScope(user1, agent1, totalAmount, 3600, currentTime, expirationTime);
      await time.increase(1);

      // Advance time to a bit before expiration
      await time.increase(16);

      // Create a charge batch with timestamp that will be within 60 seconds of settlement
      const batchTime = await time.latest();
      const chargeBatch = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: expirationTime + 3600 }],
        batchTime
      );

      // Set next block timestamp so that scope.notAfter == block.timestamp + 1
      // batchTime is currentTime + 17, expirationTime is currentTime + 20
      // So we want block.timestamp = expirationTime - 1 = currentTime + 19
      // This makes batchTime = block.timestamp - 2, which is within the 60-second window
      await time.setNextBlockTimestamp(expirationTime - 1);

      // Verify the settlement works at this boundary
      const tx = await zeroLC.settleCharges([chargeBatch]);
      await tx.wait();

      // Verify the timestamp was correct
      const block = await ethers.provider.getBlock("latest");
      expect(block!.timestamp).to.equal(expirationTime - 1);
    });
  });

  describe("5.8 Empty Batch Validation", function () {
    it("should revert with empty chargeBatches array", async function () {
      const { zeroLC } = await loadFixture(deployZeroLCFixture);

      await expect(zeroLC.settleCharges([])).to.be.revertedWithCustomError(zeroLC, "InvalidBatchLength");
    });

    it("should revert with batch containing empty entries array", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // Create a batch with no entries
      const emptyBatch = {
        scope: scope,
        entries: [],
        timestamp: currentTime,
        agentSignature: "0x" + "00".repeat(65), // Dummy signature
      };

      await expect(zeroLC.settleCharges([emptyBatch])).to.be.revertedWithCustomError(zeroLC, "EmptyChargeBatch");
    });

    it("should verify non-empty entries in verifyChargeBatchSignature", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // Valid batch with entries should work
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;
    });
  });

  describe("5.9 Event Emissions", function () {
    it("should emit ChargesSettledFromContract when called from contract (tx.origin != msg.sender)", async function () {
      const { zeroLC, settlementCaller, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      // When called via contract, should emit ChargesSettledFromContract with encoded data
      const tx = await settlementCaller.settleChargesViaContract(await zeroLC.getAddress(), [chargeBatch]);
      const receipt = await tx.wait();

      // Check that ChargesSettledFromContract was emitted
      const events = receipt?.logs.filter((log: any) => {
        try {
          const parsed = zeroLC.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          return parsed?.name === "ChargesSettledFromContract";
        } catch {
          return false;
        }
      });

      expect(events).to.have.lengthOf(1);
    });

    it("should NOT emit ChargesSettled when called from contract", async function () {
      const { zeroLC, settlementCaller, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      const tx = await settlementCaller.settleChargesViaContract(await zeroLC.getAddress(), [chargeBatch]);
      const receipt = await tx.wait();

      // Check that ChargesSettled was NOT emitted
      const chargesSettledEvents = receipt?.logs.filter((log: any) => {
        try {
          const parsed = zeroLC.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          return parsed?.name === "ChargesSettled";
        } catch {
          return false;
        }
      });

      expect(chargesSettledEvents).to.have.lengthOf(0);
    });

    it("should emit ChargesSettledFromContract with correct encoded data", async function () {
      const { zeroLC, settlementCaller, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      const tx = await settlementCaller.settleChargesViaContract(await zeroLC.getAddress(), [chargeBatch]);
      const receipt = await tx.wait();

      const events = receipt?.logs.filter((log: any) => {
        try {
          const parsed = zeroLC.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          return parsed?.name === "ChargesSettledFromContract";
        } catch {
          return false;
        }
      });

      expect(events).to.have.lengthOf(1);

      // Verify the emitted data contains the encoded chargeBatches array
      if (events && events.length > 0) {
        const parsedEvent = zeroLC.interface.parseLog({
          topics: events[0].topics as string[],
          data: events[0].data,
        });

        expect(parsedEvent?.name).to.equal("ChargesSettledFromContract");
        expect(parsedEvent?.args.data).to.not.be.undefined;

        // The data should be the ABI-encoded chargeBatches array
        const encodedBatches = ethers.AbiCoder.defaultAbiCoder().encode(
          [
            "tuple(tuple(address user,uint40 disputeWindow,address agent,uint40 notBefore,uint40 notAfter,uint128 totalAmount,uint8 amountGranularity) scope,tuple(uint32 scaledAmount,uint24 nonce,uint40 notAfter)[] entries,uint40 timestamp,bytes agentSignature)[]",
          ],
          [[chargeBatch]]
        );

        expect(parsedEvent?.args.data).to.equal(encodedBatches);
      }
    });

    it("should emit ChargesSettledFromContract with multiple batches", async function () {
      const { zeroLC, settlementCaller, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch1 = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await time.increase(5);
      const laterTime = await time.latest();
      const chargeBatch2 = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: laterTime + 3600 },
      ]);

      const tx = await settlementCaller.settleChargesViaContract(await zeroLC.getAddress(), [
        chargeBatch1,
        chargeBatch2,
      ]);
      const receipt = await tx.wait();

      const events = receipt?.logs.filter((log: any) => {
        try {
          const parsed = zeroLC.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          return parsed?.name === "ChargesSettledFromContract";
        } catch {
          return false;
        }
      });

      expect(events).to.have.lengthOf(1);

      // Verify the data contains both batches
      if (events && events.length > 0) {
        const parsedEvent = zeroLC.interface.parseLog({
          topics: events[0].topics as string[],
          data: events[0].data,
        });

        const encodedBatches = ethers.AbiCoder.defaultAbiCoder().encode(
          [
            "tuple(tuple(address user,uint40 disputeWindow,address agent,uint40 notBefore,uint40 notAfter,uint128 totalAmount,uint8 amountGranularity) scope,tuple(uint32 scaledAmount,uint24 nonce,uint40 notAfter)[] entries,uint40 timestamp,bytes agentSignature)[]",
          ],
          [[chargeBatch1, chargeBatch2]]
        );

        expect(parsedEvent?.args.data).to.equal(encodedBatches);
      }
    });

    it("should use tx.origin vs msg.sender to determine which event to emit", async function () {
      const { zeroLC, settlementCaller, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch1 = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      // Direct call: tx.origin == msg.sender -> ChargesSettled
      await expect(zeroLC.settleCharges([chargeBatch1]))
        .to.emit(zeroLC, "ChargesSettled")
        .to.not.emit(zeroLC, "ChargesSettledFromContract");

      // Contract call: tx.origin != msg.sender -> ChargesSettledFromContract
      await time.increase(5);
      const laterTime = await time.latest();
      const chargeBatch2 = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: laterTime + 3600 },
      ]);

      const tx = await settlementCaller.settleChargesViaContract(await zeroLC.getAddress(), [chargeBatch2]);
      const receipt = await tx.wait();

      const fromContractEvents = receipt?.logs.filter((log: any) => {
        try {
          const parsed = zeroLC.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          return parsed?.name === "ChargesSettledFromContract";
        } catch {
          return false;
        }
      });

      expect(fromContractEvents).to.have.lengthOf(1);
    });
  });

  describe("5.10 Amount Granularity", function () {
    it("should settle with amountGranularity = 0 (no scaling)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount, 3600, undefined, undefined, granularity);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      // With granularity=0, scaled amounts equal original amounts
      expect(state.remainingAmount).to.equal(99000n);
      expect(state.chargedAmountPending).to.equal(1000n);
    });

    it("should settle with amountGranularity = 3", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 1000000n; // 1 million (divisible by 1000)
      const granularity = 3;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount, 3600, undefined, undefined, granularity);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeAmount = 50000n; // 50k
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(chargeAmount, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      // With granularity=3, scaled down by 1000
      const expectedScaled = calculateScaledAmount(totalAmount - chargeAmount, granularity);
      expect(state.remainingAmount).to.equal(expectedScaled); // (1000000 - 50000) / 1000 = 950
      expect(state.chargedAmountPending).to.equal(calculateScaledAmount(chargeAmount, granularity)); // 50000 / 1000 = 50
    });

    it("should settle with amountGranularity = 6 (USDC-like)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 1000000000n; // 1 billion (divisible by 1 million)
      const granularity = 6;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount, 3600, undefined, undefined, granularity);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeAmount = 100000000n; // 100 million
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(chargeAmount, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      // With granularity=6, scaled down by 1 million
      expect(state.remainingAmount).to.equal(calculateScaledAmount(totalAmount - chargeAmount, granularity)); // 900
      expect(state.chargedAmountPending).to.equal(calculateScaledAmount(chargeAmount, granularity)); // 100
    });

    it("should return unscaled amounts from getAgentPendingAmount", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 1000000n;
      const granularity = 3;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount, 3600, undefined, undefined, granularity);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeAmount = 50000n;
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(chargeAmount, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await zeroLC.settleCharges([chargeBatch]);

      // getAgentPendingAmount should return unscaled amount
      const agentPending = await zeroLC.getAgentPendingAmount(scope);
      expect(agentPending).to.equal(chargeAmount); // Should be 50000, not 50
    });

    it("should handle max uint32 scaled amount", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const granularity = 3;
      const maxScaled = (1n << 32n) - 1n; // max uint32
      const totalAmount = maxScaled * (10n ** BigInt(granularity)); // Unscaled version

      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount, 3600, undefined, undefined, granularity);
      await time.increase(1);
      const currentTime = await time.latest();

      // Charge the full amount
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(totalAmount, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await expect(zeroLC.settleCharges([chargeBatch])).to.not.be.reverted;

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      expect(state.chargedAmountPending).to.equal(maxScaled);
    });
  });

  describe("5.11 Three-State Pipeline", function () {
    it("should add new charges to chargedAmountPending", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);

      await zeroLC.settleCharges([chargeBatch]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      // New charges go to pending
      expect(state.chargedAmountPending).to.equal(1000n);
      expect(state.chargedAmountFinalizing).to.equal(0);
      expect(state.chargedAmountWithdrawable).to.equal(0);
    });

    it("should accumulate multiple settlements in chargedAmountPending", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // First settlement
      const batch1 = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);
      await zeroLC.settleCharges([batch1]);

      // Second settlement
      // NOTE: Second settlement triggers finalization (epoch + disputeWindow has passed)
      // so first charge moves to finalizing, second charge goes to pending
      await time.increase(10);
      const laterTime = await time.latest();
      const batch2 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: laterTime + 3600 }],
        laterTime
      );
      await zeroLC.settleCharges([batch2]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      // After second settlement: first charge in finalizing, second in pending
      expect(state.chargedAmountPending).to.equal(2000n);
      expect(state.chargedAmountFinalizing).to.equal(1000n);
      expect(state.chargedAmountWithdrawable).to.equal(0);
    });

    it("should verify getAgentPendingAmount returns pending + finalizing", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      const disputeWindow = 3600; // Use default dispute window
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);
      await time.increase(1);
      const currentTime = await time.latest();

      // First settlement
      const batch1 = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 86400 },
      ]);
      await zeroLC.settleCharges([batch1]);

      // Second settlement (before dispute window passes)
      // This triggers finalization from epoch → first settlement moves to finalizing
      await time.increase(10);
      const laterTime = await time.latest();
      const batch2 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: laterTime + 86400 }],
        laterTime
      );
      await zeroLC.settleCharges([batch2]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      // After second settlement: 1000 in finalizing, 2000 in pending
      expect(state.chargedAmountFinalizing).to.equal(1000n);
      expect(state.chargedAmountPending).to.equal(2000n);
      expect(state.chargedAmountWithdrawable).to.equal(0);

      // getAgentPendingAmount should return sum of pending + finalizing (not withdrawable)
      const agentPending = await zeroLC.getAgentPendingAmount(scope);
      expect(agentPending).to.equal(3000n); // 1000 (finalizing) + 2000 (pending)
    });
  });

  describe("5.12 Timestamp Offset Validation", function () {
    it("should store lastChargeTimestamp as offset from notAfter", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 }],
        currentTime
      );

      await zeroLC.settleCharges([chargeBatch]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      // lastChargeTimestamp is stored as offset: notAfter - timestamp
      const expectedOffset = scope.notAfter - currentTime;
      expect(state.lastChargeTimestamp).to.equal(expectedOffset);
    });

    it("should update lastChargeTimestamp offset on each settlement", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const currentTime = await time.latest();

      // First settlement
      const batch1 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 }],
        currentTime
      );
      await zeroLC.settleCharges([batch1]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      let state = await zeroLC.authorizationScopes(scopeHash);
      let expectedOffset = scope.notAfter - currentTime;
      expect(state.lastChargeTimestamp).to.equal(expectedOffset);

      // Second settlement with different timestamp
      await time.increase(50);
      const laterTime = await time.latest();
      const batch2 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: laterTime + 3600 }],
        laterTime
      );
      await zeroLC.settleCharges([batch2]);

      state = await zeroLC.authorizationScopes(scopeHash);
      expectedOffset = scope.notAfter - laterTime;
      expect(state.lastChargeTimestamp).to.equal(expectedOffset);
    });
  });

  describe("5.13 Contract Helper Functions", function () {
    it("should return correct nonce via getScopeNonce after settlements", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Initial nonce should be 1
      let nonce = await zeroLC.getScopeNonce(scopeHash);
      expect(nonce).to.equal(1);

      // After first settlement
      const currentTime = await time.latest();
      const batch1 = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);
      await zeroLC.settleCharges([batch1]);

      nonce = await zeroLC.getScopeNonce(scopeHash);
      expect(nonce).to.equal(2);

      // After second settlement
      await time.increase(10);
      const laterTime = await time.latest();
      const batch2 = await createChargeBatch(
        scope,
        agent1,
        [{ scaledAmount: calculateScaledAmount(2000n, granularity), nonce: 2, notAfter: laterTime + 3600 }],
        laterTime
      );
      await zeroLC.settleCharges([batch2]);

      nonce = await zeroLC.getScopeNonce(scopeHash);
      expect(nonce).to.equal(3);
    });

    it("should return correct flags via getScopeFlags", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const granularity = 0;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      await time.increase(1);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED should be 0 initially
      const FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED = BigInt(1 << 23);
      let flags = await zeroLC.getScopeFlags(scopeHash);
      expect(Number(flags) & Number(FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED)).to.equal(0);

      // Settle a charge
      const currentTime = await time.latest();
      const batch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(1000n, granularity), nonce: 1, notAfter: currentTime + 3600 },
      ]);
      await zeroLC.settleCharges([batch]);

      // Flag should still be 0 until compaction
      flags = await zeroLC.getScopeFlags(scopeHash);
      expect(Number(flags) & Number(FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED)).to.equal(0);
    });
  });
});
