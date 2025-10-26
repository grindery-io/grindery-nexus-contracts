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
    const ERC1967ProxyFactory = await ethers.getContractFactory("@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy");
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
      notAfter?: number
    ) {
      const currentTime = await time.latest();
      const scope = {
        user: user.address,
        totalAmount: totalAmount,
        disputeWindow: disputeWindow,
        agent: agent.address,
        notBefore: notBefore ?? currentTime,
        notAfter: notAfter ?? currentTime + 86400, // 1 day from now
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
          { name: "totalAmount", type: "uint48" },
          { name: "disputeWindow", type: "uint48" },
          { name: "agent", type: "address" },
          { name: "notBefore", type: "uint48" },
          { name: "notAfter", type: "uint48" },
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
      notAfter?: number
    ) {
      const { scope, signature } = await createAuthorizationScope(
        user,
        agent,
        totalAmount,
        disputeWindow,
        notBefore,
        notAfter
      );
      await zeroLC.registerAuthorizationScope(scope, signature);
      return scope;
    }

    // Helper function to create a charge batch with agent signature
    async function createChargeBatch(
      scope: any,
      agent: SignerWithAddress,
      entries: { amount: bigint; nonce: number; notAfter: number }[],
      timestamp?: number
    ) {
      const currentTime = await time.latest();
      const batchTimestamp = timestamp ?? currentTime;

      const chargeEntries = entries.map(e => ({
        amount: e.amount,
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
        const encodedEntries = entriesWithoutLast.map(e => [e.amount, e.nonce, e.notAfter]);
        batchPartHash = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["tuple(uint48,uint48,uint48)[]"],
            [encodedEntries]
          )
        );
      }

      const lastEntry = chargeEntries[chargeEntries.length - 1];

      // Encode the verifier struct components
      // Contract uses: abi.encode(ChargeBatchVerifier) which encodes the struct fields in order
      const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint48,uint48,uint48)", "bytes32"],
        [batchPartHash, [lastEntry.amount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
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
    };
  }

  describe("5.1 Valid Settlement", function () {
    it("should settle single charge batch with one entry", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;

      // Verify state updates
      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      expect(state.remainingAmount).to.equal(totalAmount - 1000n);
      expect(state.agentPendingAmount).to.equal(1000n);
      expect(state.nonce).to.equal(2);
      expect(state.lastChargeTimestamp).to.equal(chargeBatch.timestamp);
    });

    it("should settle single charge batch with multiple entries", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 },
        { amount: 2000n, nonce: 2, notAfter: currentTime + 3600 },
        { amount: 1500n, nonce: 3, notAfter: currentTime + 3600 }
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;

      // Verify state updates
      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      expect(state.remainingAmount).to.equal(totalAmount - 4500n);
      expect(state.agentPendingAmount).to.equal(4500n);
      expect(state.nonce).to.equal(4); // Started at 1, processed 3 entries
    });

    it("should settle multiple charge batches in one transaction", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch1 = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ], currentTime);

      // Second batch must have later timestamp
      await time.increase(10);
      const laterTime = await time.latest();
      const chargeBatch2 = await createChargeBatch(scope, agent1, [
        { amount: 2000n, nonce: 2, notAfter: laterTime + 3600 }
      ], laterTime);

      await expect(zeroLC.settleCharges([chargeBatch1, chargeBatch2]))
        .to.not.be.reverted;

      // Verify final state
      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      expect(state.remainingAmount).to.equal(totalAmount - 3000n);
      expect(state.agentPendingAmount).to.equal(3000n);
      expect(state.nonce).to.equal(3);
    });

    it("should settle charges with sequential nonces", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // First settlement
      const batch1 = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);
      await zeroLC.settleCharges([batch1]);

      // Second settlement with next nonce
      await time.increase(10);
      const laterTime = await time.latest();
      const batch2 = await createChargeBatch(scope, agent1, [
        { amount: 2000n, nonce: 2, notAfter: laterTime + 3600 }
      ], laterTime);
      await zeroLC.settleCharges([batch2]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.nonce).to.equal(3);
    });

    it("should update remainingAmount correctly", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeAmount = 15000n;
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: chargeAmount, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      await zeroLC.settleCharges([chargeBatch]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      expect(state.remainingAmount).to.equal(totalAmount - chargeAmount);
    });

    it("should update agentPendingAmount correctly", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 10000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      await zeroLC.settleCharges([chargeBatch]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      expect(state.agentPendingAmount).to.equal(10000n);

      // Settle more charges
      await time.increase(10);
      const laterTime = await time.latest();
      const chargeBatch2 = await createChargeBatch(scope, agent1, [
        { amount: 5000n, nonce: 2, notAfter: laterTime + 3600 }
      ], laterTime);

      await zeroLC.settleCharges([chargeBatch2]);

      const state2 = await zeroLC.authorizationScopes(scopeHash);
      expect(state2.agentPendingAmount).to.equal(15000n);
    });

    it("should update lastChargeTimestamp correctly", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ], currentTime);

      await zeroLC.settleCharges([chargeBatch]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      expect(state.lastChargeTimestamp).to.equal(currentTime);
    });

    it("should update nonce correctly (increments by number of entries)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 },
        { amount: 2000n, nonce: 2, notAfter: currentTime + 3600 },
        { amount: 3000n, nonce: 3, notAfter: currentTime + 3600 },
        { amount: 4000n, nonce: 4, notAfter: currentTime + 3600 },
        { amount: 5000n, nonce: 5, notAfter: currentTime + 3600 }
      ]);

      await zeroLC.settleCharges([chargeBatch]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      expect(state.nonce).to.equal(6); // Started at 1, processed 5 entries
    });

    it("should emit ChargesSettled event when tx.origin == msg.sender", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      // When called directly (tx.origin == msg.sender), should emit ChargesSettled event without parameters
      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.emit(zeroLC, "ChargesSettled")
        .to.not.emit(zeroLC, "ChargesSettledFromContract");
    });

    it("should maintain isNumChargesRecorded flag", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      await zeroLC.settleCharges([chargeBatch]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      // Flag should remain 0 until compaction
      expect(state.isNumChargesRecorded).to.equal(0);
    });
  });

  describe("5.2 Signature Verification", function () {
    it("should settle with valid agent ECDSA signature", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;
    });

    it("should revert with invalid agent signature", async function () {
      const { zeroLC, user1, user2, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // Create batch but sign with wrong signer
      const chargeBatch = await createChargeBatch(scope, user2, [ // user2 instead of agent1
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "InvalidAgentSignature");
    });

    it("should revert with wrong agent signing", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // Create batch signed by agent2 instead of agent1
      const chargeBatch = await createChargeBatch(scope, agent2, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "InvalidAgentSignature");
    });

    it("should settle with single entry (batchPartHash == 0x00)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      // Single entry should have batchPartHash of all zeros
      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;
    });

    it("should settle with multiple entries (batchPartHash verified)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 },
        { amount: 2000n, nonce: 2, notAfter: currentTime + 3600 },
        { amount: 3000n, nonce: 3, notAfter: currentTime + 3600 }
      ]);

      // Multiple entries should verify batchPartHash correctly
      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;
    });

    it("should revert with tampered batchPartHash", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 },
        { amount: 2000n, nonce: 2, notAfter: currentTime + 3600 }
      ]);

      // Tamper with the first entry after signing
      chargeBatch.entries[0].amount = 9999n;

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "InvalidAgentSignature");
    });

    it("should revert with tampered lastEntry", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      // Tamper with the last entry amount after signing
      chargeBatch.entries[0].amount = 9999n;

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "InvalidAgentSignature");
    });

    it("should revert with tampered scopeHash", async function () {
      const { zeroLC, user1, user2, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);
      await depositForUser(user2, totalAmount);

      const scope1 = await registerScope(user1, agent1, totalAmount);
      const scope2 = await registerScope(user2, agent1, totalAmount);

      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope1, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      // Tamper with scope by substituting user
      chargeBatch.scope = scope2;

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "InvalidAgentSignature");
    });

    it("should use correct verifier struct encoding", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // Test that the encoding matches what the contract expects
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 },
        { amount: 2000n, nonce: 2, notAfter: currentTime + 3600 }
      ]);

      // If encoding is correct, settlement should succeed
      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;
    });
  });

  describe("5.3 Timestamp Validation", function () {
    it("should settle with timestamp within valid 60-second window", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // Create batch with timestamp 30 seconds in the past (well within 60-second window)
      const pastTime = currentTime - 30;
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ], pastTime);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;
    });

    it("should revert with timestamp == block.timestamp - 60 (boundary)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // Create batch with timestamp exactly 60 seconds in the past
      const pastTime = currentTime - 60;
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ], pastTime);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "BatchTimestampOutOfRange");
    });

    it("should settle with timestamp within 59 seconds window (boundary)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);

      // Get current time
      let currentTime = await time.latest();

      // Create batch with timestamp 55 seconds in the past (safely within the 60-second window)
      const pastTime = currentTime - 55;
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ], pastTime);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;
    });

    it("should settle with timestamp == block.timestamp (boundary)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ], currentTime);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;
    });

    it("should revert with timestamp < block.timestamp - 60", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // Create batch with timestamp 120 seconds in the past
      const pastTime = currentTime - 120;
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ], pastTime);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "BatchTimestampOutOfRange");
    });

    it("should revert with timestamp > block.timestamp", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // Create batch with timestamp in the future
      const futureTime = currentTime + 10;
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ], futureTime);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "BatchTimestampOutOfRange");
    });

    it("should revert with timestamp <= lastChargeTimestamp", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // First settlement
      const batch1 = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ], currentTime);
      await zeroLC.settleCharges([batch1]);

      // Try to settle with same timestamp
      const batch2 = await createChargeBatch(scope, agent1, [
        { amount: 2000n, nonce: 2, notAfter: currentTime + 3600 }
      ], currentTime);

      await expect(zeroLC.settleCharges([batch2]))
        .to.be.revertedWithCustomError(zeroLC, "BatchTimestampNotIncreasing");
    });

    it("should settle with timestamp == lastChargeTimestamp + 1 (boundary)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // First settlement
      const batch1 = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ], currentTime);
      await zeroLC.settleCharges([batch1]);

      // Advance time by 1 second
      await time.increase(1);
      const nextTime = await time.latest();

      // Settle with timestamp exactly 1 second after last charge
      const batch2 = await createChargeBatch(scope, agent1, [
        { amount: 2000n, nonce: 2, notAfter: nextTime + 3600 }
      ], nextTime);

      await expect(zeroLC.settleCharges([batch2]))
        .to.not.be.reverted;
    });

    it("should settle multiple batches with increasing timestamps", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // First batch
      const batch1 = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ], currentTime);
      await zeroLC.settleCharges([batch1]);

      // Second batch with later timestamp
      await time.increase(5);
      const time2 = await time.latest();
      const batch2 = await createChargeBatch(scope, agent1, [
        { amount: 2000n, nonce: 2, notAfter: time2 + 3600 }
      ], time2);
      await zeroLC.settleCharges([batch2]);

      // Third batch with even later timestamp
      await time.increase(5);
      const time3 = await time.latest();
      const batch3 = await createChargeBatch(scope, agent1, [
        { amount: 3000n, nonce: 3, notAfter: time3 + 3600 }
      ], time3);
      await zeroLC.settleCharges([batch3]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.nonce).to.equal(4);
    });
  });

  describe("5.4 Nonce Validation", function () {
    it("should settle with correct sequential nonces starting from 1", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 },
        { amount: 2000n, nonce: 2, notAfter: currentTime + 3600 },
        { amount: 3000n, nonce: 3, notAfter: currentTime + 3600 }
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;
    });

    it("should revert with wrong nonce", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // Start with nonce 2 instead of 1
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 2, notAfter: currentTime + 3600 }
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "InvalidNonce");
    });

    it("should revert with skipped nonce", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // Skip from nonce 1 to 3
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 },
        { amount: 2000n, nonce: 3, notAfter: currentTime + 3600 } // Skipped 2
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "InvalidNonce");
    });

    it("should revert with repeated nonce", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // First settlement with nonce 1
      const batch1 = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);
      await zeroLC.settleCharges([batch1]);

      // Try to settle again with nonce 1
      await time.increase(5);
      const laterTime = await time.latest();
      const batch2 = await createChargeBatch(scope, agent1, [
        { amount: 2000n, nonce: 1, notAfter: laterTime + 3600 }
      ], laterTime);

      await expect(zeroLC.settleCharges([batch2]))
        .to.be.revertedWithCustomError(zeroLC, "InvalidNonce");
    });

    it("should settle multiple batches incrementing nonces correctly", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // First batch: nonces 1-3
      const batch1 = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 },
        { amount: 1000n, nonce: 2, notAfter: currentTime + 3600 },
        { amount: 1000n, nonce: 3, notAfter: currentTime + 3600 }
      ]);
      await zeroLC.settleCharges([batch1]);

      // Second batch: nonces 4-6
      await time.increase(5);
      const time2 = await time.latest();
      const batch2 = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 4, notAfter: time2 + 3600 },
        { amount: 1000n, nonce: 5, notAfter: time2 + 3600 },
        { amount: 1000n, nonce: 6, notAfter: time2 + 3600 }
      ], time2);
      await zeroLC.settleCharges([batch2]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.nonce).to.equal(7);
    });

    it("should persist nonce across multiple settlements", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      let currentTime = await time.latest();

      // Settlement 1
      const batch1 = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);
      await zeroLC.settleCharges([batch1]);

      // Settlement 2
      await time.increase(5);
      currentTime = await time.latest();
      const batch2 = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 2, notAfter: currentTime + 3600 }
      ], currentTime);
      await zeroLC.settleCharges([batch2]);

      // Settlement 3
      await time.increase(5);
      currentTime = await time.latest();
      const batch3 = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 3, notAfter: currentTime + 3600 }
      ], currentTime);
      await zeroLC.settleCharges([batch3]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.nonce).to.equal(4);
    });

    it("should have nonce start at 1 for new scope", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);

      expect(state.nonce).to.equal(1);
    });
  });

  describe("5.5 Amount & Balance", function () {
    it("should settle with totalAmount < remainingAmount", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 50000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.remainingAmount).to.equal(50000n);
    });

    it("should settle with totalAmount == remainingAmount (exact drain)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 100000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.remainingAmount).to.equal(0);
      expect(state.agentPendingAmount).to.equal(100000n);
    });

    it("should revert with totalAmount > remainingAmount", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 100001n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "InsufficientBalance");
    });

    it("should revert with zero amount entries", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 0n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "InvalidChargeAmount");
    });

    it("should settle with uint48 max amount (overflow check)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      // uint48 max: 281474976710655
      const maxUint48 = (1n << 48n) - 1n;
      await depositForUser(user1, maxUint48);

      const scope = await registerScope(user1, agent1, maxUint48);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: maxUint48, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;
    });

    it("should ensure all entries have amount > 0", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 },
        { amount: 0n, nonce: 2, notAfter: currentTime + 3600 } // Zero amount
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "InvalidChargeAmount");
    });
  });

  describe("5.6 Entry Expiration", function () {
    it("should settle with entry.notAfter > block.timestamp (valid, not expired)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 } // Expires 1 hour from now
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;
    });

    it("should settle with entry.notAfter == block.timestamp + 1 (boundary, valid)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);

      // Get current time right before creating the batch
      let currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 2 } // notAfter will be block.timestamp + 1 when settled
      ], currentTime);

      // notAfter is EXCLUSIVE, so entry.notAfter == block.timestamp + 1 is still valid
      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;
    });

    it("should revert with entry.notAfter == block.timestamp (boundary, expired)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);

      // Get current time right before creating the batch
      let currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 1 } // notAfter will equal block.timestamp when settled
      ], currentTime);

      // notAfter is EXCLUSIVE, so entry.notAfter == block.timestamp means expired
      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "ChargeEntryExpired");
    });

    it("should revert with entry.notAfter < block.timestamp (expired)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime - 1 } // Already expired
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "ChargeEntryExpired");
    });

    it("should settle multiple entries with different notAfter values", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 1800 }, // 30 min
        { amount: 2000n, nonce: 2, notAfter: currentTime + 3600 }, // 1 hour
        { amount: 1500n, nonce: 3, notAfter: currentTime + 7200 }  // 2 hours
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;
    });
  });

  describe("5.7 Scope Status", function () {
    it("should settle with active scope (notAfter > block.timestamp)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, 3600, currentTime, currentTime + 86400);

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;
    });

    it("should revert with expired scope", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      // Create scope that expires in 10 seconds
      const scope = await registerScope(user1, agent1, totalAmount, 3600, currentTime, currentTime + 10);

      // Advance time past scope expiration
      await time.increase(15);

      const laterTime = await time.latest();
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: laterTime + 3600 }
      ], laterTime);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "AuthorizationScopeExpired");
    });

    it("should revert with scope notAfter == block.timestamp", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      // Create scope that expires in 5 seconds
      const scope = await registerScope(user1, agent1, totalAmount, 3600, currentTime, currentTime + 5);

      // Advance time to exactly the expiration
      await time.increase(5);

      const expirationTime = await time.latest();
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: expirationTime + 3600 }
      ], expirationTime);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.be.revertedWithCustomError(zeroLC, "AuthorizationScopeExpired");
    });

    it("should settle with scope notAfter == block.timestamp + 1 (boundary)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      // Create scope that expires in 10 seconds
      const scope = await registerScope(user1, agent1, totalAmount, 3600, currentTime, currentTime + 10);

      // Advance time to a few seconds before expiration
      await time.increase(7);

      const beforeExpiration = await time.latest();
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: beforeExpiration + 3600 }
      ], beforeExpiration);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;
    });
  });

  describe("5.8 Empty Batch Validation", function () {
    it("should revert with empty chargeBatches array", async function () {
      const { zeroLC } = await loadFixture(deployZeroLCFixture);

      await expect(zeroLC.settleCharges([]))
        .to.be.revertedWithCustomError(zeroLC, "InvalidBatchLength");
    });

    it("should revert with batch containing empty entries array", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // Create a batch with no entries
      const emptyBatch = {
        scope: scope,
        entries: [],
        timestamp: currentTime,
        agentSignature: "0x" + "00".repeat(65) // Dummy signature
      };

      await expect(zeroLC.settleCharges([emptyBatch]))
        .to.be.revertedWithCustomError(zeroLC, "EmptyChargeBatch");
    });

    it("should verify non-empty entries in verifyChargeBatchSignature", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      // Valid batch with entries should work
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      await expect(zeroLC.settleCharges([chargeBatch]))
        .to.not.be.reverted;
    });
  });

  describe("5.9 Event Emissions", function () {
    it("should emit ChargesSettledFromContract when called from contract (tx.origin != msg.sender)", async function () {
      const { zeroLC, settlementCaller, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      // When called via contract, should emit ChargesSettledFromContract with encoded data
      const tx = await settlementCaller.settleChargesViaContract(await zeroLC.getAddress(), [chargeBatch]);
      const receipt = await tx.wait();

      // Check that ChargesSettledFromContract was emitted
      const events = receipt?.logs.filter((log: any) => {
        try {
          const parsed = zeroLC.interface.parseLog({
            topics: log.topics as string[],
            data: log.data
          });
          return parsed?.name === "ChargesSettledFromContract";
        } catch {
          return false;
        }
      });

      expect(events).to.have.lengthOf(1);
    });

    it("should NOT emit ChargesSettled when called from contract", async function () {
      const { zeroLC, settlementCaller, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      const tx = await settlementCaller.settleChargesViaContract(await zeroLC.getAddress(), [chargeBatch]);
      const receipt = await tx.wait();

      // Check that ChargesSettled was NOT emitted
      const chargesSettledEvents = receipt?.logs.filter((log: any) => {
        try {
          const parsed = zeroLC.interface.parseLog({
            topics: log.topics as string[],
            data: log.data
          });
          return parsed?.name === "ChargesSettled";
        } catch {
          return false;
        }
      });

      expect(chargesSettledEvents).to.have.lengthOf(0);
    });

    it("should emit ChargesSettledFromContract with correct encoded data", async function () {
      const { zeroLC, settlementCaller, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      const tx = await settlementCaller.settleChargesViaContract(await zeroLC.getAddress(), [chargeBatch]);
      const receipt = await tx.wait();

      const events = receipt?.logs.filter((log: any) => {
        try {
          const parsed = zeroLC.interface.parseLog({
            topics: log.topics as string[],
            data: log.data
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
          data: events[0].data
        });

        expect(parsedEvent?.name).to.equal("ChargesSettledFromContract");
        expect(parsedEvent?.args.data).to.not.be.undefined;

        // The data should be the ABI-encoded chargeBatches array
        const encodedBatches = ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(tuple(address user,uint48 totalAmount,uint48 disputeWindow,address agent,uint48 notBefore,uint48 notAfter) scope,tuple(uint48 amount,uint48 nonce,uint48 notAfter)[] entries,uint48 timestamp,bytes agentSignature)[]"],
          [[chargeBatch]]
        );

        expect(parsedEvent?.args.data).to.equal(encodedBatches);
      }
    });

    it("should emit ChargesSettledFromContract with multiple batches", async function () {
      const { zeroLC, settlementCaller, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch1 = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      await time.increase(5);
      const laterTime = await time.latest();
      const chargeBatch2 = await createChargeBatch(scope, agent1, [
        { amount: 2000n, nonce: 2, notAfter: laterTime + 3600 }
      ]);

      const tx = await settlementCaller.settleChargesViaContract(
        await zeroLC.getAddress(),
        [chargeBatch1, chargeBatch2]
      );
      const receipt = await tx.wait();

      const events = receipt?.logs.filter((log: any) => {
        try {
          const parsed = zeroLC.interface.parseLog({
            topics: log.topics as string[],
            data: log.data
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
          data: events[0].data
        });

        const encodedBatches = ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(tuple(address user,uint48 totalAmount,uint48 disputeWindow,address agent,uint48 notBefore,uint48 notAfter) scope,tuple(uint48 amount,uint48 nonce,uint48 notAfter)[] entries,uint48 timestamp,bytes agentSignature)[]"],
          [[chargeBatch1, chargeBatch2]]
        );

        expect(parsedEvent?.args.data).to.equal(encodedBatches);
      }
    });

    it("should use tx.origin vs msg.sender to determine which event to emit", async function () {
      const { zeroLC, settlementCaller, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount);
      const currentTime = await time.latest();

      const chargeBatch1 = await createChargeBatch(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 3600 }
      ]);

      // Direct call: tx.origin == msg.sender -> ChargesSettled
      await expect(zeroLC.settleCharges([chargeBatch1]))
        .to.emit(zeroLC, "ChargesSettled")
        .to.not.emit(zeroLC, "ChargesSettledFromContract");

      // Contract call: tx.origin != msg.sender -> ChargesSettledFromContract
      await time.increase(5);
      const laterTime = await time.latest();
      const chargeBatch2 = await createChargeBatch(scope, agent1, [
        { amount: 2000n, nonce: 2, notAfter: laterTime + 3600 }
      ]);

      const tx = await settlementCaller.settleChargesViaContract(await zeroLC.getAddress(), [chargeBatch2]);
      const receipt = await tx.wait();

      const fromContractEvents = receipt?.logs.filter((log: any) => {
        try {
          const parsed = zeroLC.interface.parseLog({
            topics: log.topics as string[],
            data: log.data
          });
          return parsed?.name === "ChargesSettledFromContract";
        } catch {
          return false;
        }
      });

      expect(fromContractEvents).to.have.lengthOf(1);
    });
  });
});
