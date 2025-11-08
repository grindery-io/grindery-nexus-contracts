import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeroLC, TestERC20, UniversalSigValidator } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

// Flag constants matching contract
const FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED = 1 << 23;

describe("ZeroLC - Compact User Authorization States", function () {
  // Fixture to deploy the contract and set up test environment
  async function deployZeroLCFixture() {
    const [owner, user1, user2, agent1, agent2, agent3] = await ethers.getSigners();

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
      const currentTime = await time.latest();
      const scope = {
        user: user.address,
        disputeWindow: disputeWindow,
        agent: agent.address,
        notBefore: notBefore ?? currentTime,
        notAfter: notAfter ?? currentTime + 86400,
        totalAmount: totalAmount,
        amountGranularity: amountGranularity,
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
          { name: "disputeWindow", type: "uint40" },
          { name: "agent", type: "address" },
          { name: "notBefore", type: "uint40" },
          { name: "notAfter", type: "uint40" },
          { name: "totalAmount", type: "uint128" },
          { name: "amountGranularity", type: "uint8" },
        ],
      };

      const signature = await user.signTypedData(domain, types, scope);
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

      const scopeHash = await zeroLC.getScopeHash(scope);

      let batchPartHash = "0x0000000000000000000000000000000000000000000000000000000000000000";
      if (chargeEntries.length > 1) {
        const entriesWithoutLast = chargeEntries.slice(0, -1);
        const encodedEntries = entriesWithoutLast.map((e) => [e.scaledAmount, e.nonce, e.notAfter]);
        batchPartHash = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(["tuple(uint32,uint24,uint48)[]"], [encodedEntries])
        );
      }

      const lastEntry = chargeEntries[chargeEntries.length - 1];

      const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint32,uint24,uint48)", "bytes32"],
        [batchPartHash, [lastEntry.scaledAmount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
      );

      const verifierBytes = ethers.getBytes(verifierEncoded);
      const agentSignature = await agent.signMessage(verifierBytes);

      return {
        scope: scope,
        entries: chargeEntries,
        timestamp: batchTimestamp,
        agentSignature: agentSignature,
      };
    }

    // Helper function to calculate scaled amount
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
      owner,
      user1,
      user2,
      agent1,
      agent2,
      agent3,
      depositForUser,
      registerScope,
      createChargeBatch,
      calculateScaledAmount,
      getAuthorizationScopeData,
    };
  }

  describe("8.1 Compaction Logic", function () {
    it("should return remainingAmount to balance when compacting expired scopes", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      // Deposit and create two scopes - one will expire, one won't
      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope1 = await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100, 0); // Will expire
      await registerScope(user1, agent2, 200n, 3600, currentTime, currentTime + 7200, 0); // Won't expire

      // Check initial balance
      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.balance).to.equal(500n); // 1000 - 300 - 200

      // Wait for first scope to expire
      await time.increase(150);

      // Register a new scope to trigger compaction
      await depositForUser(user1, 300n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Check that balance increased by the expired scope's remaining amount
      const userState2 = await zeroLC.userStates(user1.address);
      // Should be: 500 (initial free) + 300 (from expired scope1) + 300 (new deposit) - 100 (new scope) = 1000
      expect(userState2.balance).to.equal(1000n);
    });

    it("should update numCharges from nonce (nonce - 1) when compacting", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 500n, 3600, currentTime, currentTime + 100, 0);

      // Settle some charges to increment nonce
      await time.increase(1); // Ensure charge timestamp is after scope registration
      const chargeBatch1 = await createChargeBatch(scope, agent1, [
        { scaledAmount: 50n, nonce: 1, notAfter: currentTime + 100 },
        { scaledAmount: 50n, nonce: 2, notAfter: currentTime + 100 },
      ]);
      await zeroLC.settleCharges([chargeBatch1]);

      // Now nonce should be 3, so numCharges should be 2 when recorded
      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.numCharges).to.equal(0n); // Not yet recorded

      // Wait for scope to expire
      await time.increase(150);

      // Trigger compaction by registering new scope
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Check that numCharges was recorded
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.numCharges).to.equal(2n); // nonce - 1 = 3 - 1 = 2
    });

    it("should set isNumChargesRecorded flag to 1 after compaction", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 500n, 3600, currentTime, currentTime + 100, 0);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle a charge
      await time.increase(1); // Ensure charge timestamp is after scope registration
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: 50n, nonce: 1, notAfter: currentTime + 100 },
      ]);
      await zeroLC.settleCharges([chargeBatch]);

      // Check flag before compaction
      const flags1 = await zeroLC.getScopeFlags(scopeHash);
      expect(Number(flags1) & FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED).to.equal(0);

      // Wait for scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Check flag after compaction
      const flags2 = await zeroLC.getScopeFlags(scopeHash);
      expect(Number(flags2) & FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED).to.not.equal(0);
    });

    it("should remove expired scopes from array during compaction", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 100, 0); // Will expire
      await registerScope(user1, agent2, 200n, 3600, currentTime, currentTime + 7200, 0); // Won't expire

      // Check initial array length
      const scopeHashes1 = await zeroLC.getUserAuthorizationScopeHashes(user1.address);
      expect(scopeHashes1.length).to.equal(2);

      // Wait for first scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Check array length after compaction - should have removed expired scope
      const scopeHashes2 = await zeroLC.getUserAuthorizationScopeHashes(user1.address);
      // Should be 2: one non-expired from before + one new scope (expired one removed)
      expect(scopeHashes2.length).to.equal(2);
    });

    it("should handle empty scope array during compaction", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 500n);

      // User has no scopes yet
      const userState1 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(0);

      // Register a scope - this triggers compaction on empty array
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Should complete successfully
      const userState2 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(1);
    });

    it("should call compaction during registerAuthorizationScope", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      // Create a scope that will expire
      await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100, 0);

      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.balance).to.equal(700n); // 1000 - 300

      // Wait for scope to expire
      await time.increase(150);

      // Register new scope - should trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent2, 200n, 3600, undefined, undefined, 0);

      // Balance should include the expired scope's remaining amount
      const userState2 = await zeroLC.userStates(user1.address);
      // 700 (old free) + 300 (expired scope) + 100 (new deposit) - 200 (new scope) = 900
      expect(userState2.balance).to.equal(900n);
    });

    it("should compact multiple expired scopes at once", async function () {
      const { zeroLC, user1, agent1, agent2, agent3, depositForUser, registerScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 2000n);
      const currentTime = await time.latest();

      // Create three scopes that will all expire
      await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 100, 0);
      await registerScope(user1, agent2, 300n, 3600, currentTime, currentTime + 100, 0);
      await registerScope(user1, agent3, 250n, 3600, currentTime, currentTime + 100, 0);

      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.balance).to.equal(1250n); // 2000 - 200 - 300 - 250
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3);

      // Wait for all to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // All three expired scopes should be removed and balances restored
      const userState2 = await zeroLC.userStates(user1.address);
      // 1250 + 200 + 300 + 250 + 100 - 100 = 2000
      expect(userState2.balance).to.equal(2000n);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(1); // Only new scope
    });

    it("should compact scopes even with no charges settled (nonce == 1)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100, 0);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Don't settle any charges - nonce remains 1 (initial value)
      // nonce == 0 means uninitialized scope (safety check), nonce == 1 means no charges yet
      // Wait for scope to expire
      await time.increase(150);

      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.numCharges).to.equal(0n);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Since nonce was not 0 (it was 1), it should have been compacted
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.balance).to.equal(1000n); // Got the 300 back from expired scope
    });

    it("should not affect active scopes during compaction", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const expiredScope = await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 100, 0);
      const activeScope = await registerScope(user1, agent2, 300n, 3600, currentTime, currentTime + 7200, 0);

      const expiredScopeHash = await zeroLC.getScopeHash(expiredScope);
      const activeScopeHash = await zeroLC.getScopeHash(activeScope);

      // Wait for first scope to expire
      await time.increase(150);

      // Get active scope state before compaction
      const activeState1 = await zeroLC.authorizationScopes(activeScopeHash);
      expect(activeState1.remainingAmount).to.equal(300n);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Active scope should remain unchanged
      const activeState2 = await zeroLC.authorizationScopes(activeScopeHash);
      expect(activeState2.remainingAmount).to.equal(300n);
      expect(activeState2.notAfter).to.equal(activeState1.notAfter);
    });

    it("should compact scope at exact expiration boundary (notAfter == block.timestamp)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100, 0);

      // Move to exact expiration time
      await time.increaseTo(currentTime + 100);

      // At exact boundary where block.timestamp == notAfter:
      // The condition uint48(block.timestamp) < state.notAfter evaluates to FALSE
      // Therefore the scope IS EXPIRED and SHOULD be compacted (notAfter is EXCLUSIVE)

      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.balance).to.equal(700n);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // At exact boundary, scope is expired and should be compacted
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.balance).to.equal(1000n); // 700 + 300 (expired) + 100 - 100
    });

    it("should handle compaction when scope has remainingAmount == 0", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100, 0);

      // Fully drain the scope
      await time.increase(1); // Ensure charge timestamp is after scope registration
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: 300n, nonce: 1, notAfter: currentTime + 100 },
      ]);
      await zeroLC.settleCharges([chargeBatch]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const authScope1 = await zeroLC.authorizationScopes(scopeHash);
      expect(authScope1.remainingAmount).to.equal(0n);

      // Wait for scope to expire
      await time.increase(150);

      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.balance).to.equal(700n);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // No balance should be returned (remainingAmount was 0)
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.balance).to.equal(700n); // 700 + 0 (nothing to return) + 100 - 100
    });

    it("should only record numCharges once (isNumChargesRecorded prevents duplicate)", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope1 = await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100, 0);

      // Settle charges
      await time.increase(1); // Ensure charge timestamp is after scope registration
      const chargeBatch = await createChargeBatch(scope1, agent1, [
        { scaledAmount: 50n, nonce: 1, notAfter: currentTime + 100 },
        { scaledAmount: 50n, nonce: 2, notAfter: currentTime + 100 },
      ]);
      await zeroLC.settleCharges([chargeBatch]);

      // Wait for scope to expire
      await time.increase(150);

      // First compaction - should record numCharges
      await depositForUser(user1, 100n);
      const newTime = await time.latest();
      const scope2 = await registerScope(user1, agent2, 100n, 3600, newTime, newTime + 100, 0);

      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.numCharges).to.equal(2n);

      // Wait for second scope to expire
      await time.increase(150);

      // Second compaction - should not add numCharges from scope1 again
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.numCharges).to.equal(2n); // Still 2, not doubled
    });
  });

  describe("8.2 Array Manipulation", function () {
    it("should correctly remove and pack array (swap with last, then pop)", async function () {
      const { zeroLC, user1, agent1, agent2, agent3, depositForUser, registerScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 2000n);
      const currentTime = await time.latest();

      // Create 3 scopes
      const scope1 = await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 100, 0); // Will expire
      const scope2 = await registerScope(user1, agent2, 300n, 3600, currentTime, currentTime + 7200, 0); // Active
      const scope3 = await registerScope(user1, agent3, 250n, 3600, currentTime, currentTime + 7200, 0); // Active

      const scopeHash1 = await zeroLC.getScopeHash(scope1);
      const scopeHash2 = await zeroLC.getScopeHash(scope2);
      const scopeHash3 = await zeroLC.getScopeHash(scope3);

      const userState1 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address))[0]).to.equal(scopeHash1);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address))[1]).to.equal(scopeHash2);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address))[2]).to.equal(scopeHash3);

      // Wait for first scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // First scope should be removed, array should be packed
      const userState2 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3); // 2 active + 1 new

      // The expired scope (scopeHash1) should not be in the array
      const hashes = await zeroLC.getUserAuthorizationScopeHashes(user1.address);
      expect(hashes).to.not.include(scopeHash1);
    });

    it("should handle single element array removal", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100, 0);

      const userState1 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(1);

      // Wait for scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Array should have only the new scope
      const userState2 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(1);
    });

    it("should handle last element removal", async function () {
      const { zeroLC, user1, agent1, agent2, agent3, depositForUser, registerScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 2000n);
      const currentTime = await time.latest();

      await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 7200, 0); // Active
      await registerScope(user1, agent2, 300n, 3600, currentTime, currentTime + 7200, 0); // Active
      const scope3 = await registerScope(user1, agent3, 250n, 3600, currentTime, currentTime + 100, 0); // Will expire

      const userState1 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3);

      // Wait for last scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Last element should be removed
      const userState2 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3); // 2 active + 1 new
    });

    it("should handle first element removal", async function () {
      const { zeroLC, user1, agent1, agent2, agent3, depositForUser, registerScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 2000n);
      const currentTime = await time.latest();

      const scope1 = await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 100, 0); // Will expire
      await registerScope(user1, agent2, 300n, 3600, currentTime, currentTime + 7200, 0); // Active
      await registerScope(user1, agent3, 250n, 3600, currentTime, currentTime + 7200, 0); // Active

      const scopeHash1 = await zeroLC.getScopeHash(scope1);

      const userState1 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address))[0]).to.equal(scopeHash1);

      // Wait for first scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // First element should be removed
      const userState2 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3); // 2 active + 1 new
      expect(await zeroLC.getUserAuthorizationScopeHashes(user1.address)).to.not.include(scopeHash1);
    });

    it("should handle middle element removal", async function () {
      const { zeroLC, user1, agent1, agent2, agent3, depositForUser, registerScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 2000n);
      const currentTime = await time.latest();

      await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 7200, 0); // Active
      const scope2 = await registerScope(user1, agent2, 300n, 3600, currentTime, currentTime + 100, 0); // Will expire
      await registerScope(user1, agent3, 250n, 3600, currentTime, currentTime + 7200, 0); // Active

      const scopeHash2 = await zeroLC.getScopeHash(scope2);

      const userState1 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address))[1]).to.equal(scopeHash2);

      // Wait for middle scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Middle element should be removed
      const userState2 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3); // 2 active + 1 new
      expect(await zeroLC.getUserAuthorizationScopeHashes(user1.address)).to.not.include(scopeHash2);
    });

    it("should empty array when all scopes are expired", async function () {
      const { zeroLC, user1, agent1, agent2, agent3, depositForUser, registerScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 2000n);
      const currentTime = await time.latest();

      // Create all scopes that will expire
      await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 100, 0);
      await registerScope(user1, agent2, 300n, 3600, currentTime, currentTime + 100, 0);
      await registerScope(user1, agent3, 250n, 3600, currentTime, currentTime + 100, 0);

      const userState1 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3);

      // Wait for all to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // All expired scopes removed, only new scope remains
      const userState2 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(1);
    });

    it("should correctly decrement array length after removal", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 2000n);
      const currentTime = await time.latest();

      await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 100, 0); // Will expire
      await registerScope(user1, agent2, 300n, 3600, currentTime, currentTime + 100, 0); // Will expire

      const userState1 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(2);

      // Wait for both to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Both expired scopes removed, length should be 1 (new scope)
      const userState2 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(1);
    });
  });

  describe("8.3 State Updates", function () {
    it("should update userState.balance in storage after compaction", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100, 0);

      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.balance).to.equal(700n);

      // Wait for scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Balance should be updated in storage
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.balance).to.equal(1000n); // 700 + 300 + 100 - 100
    });

    it("should update userState.numCharges in storage after compaction", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 500n, 3600, currentTime, currentTime + 100, 0);

      // Settle charges
      await time.increase(1); // Ensure charge timestamp is after scope registration
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: 50n, nonce: 1, notAfter: currentTime + 100 },
        { scaledAmount: 50n, nonce: 2, notAfter: currentTime + 100 },
        { scaledAmount: 50n, nonce: 3, notAfter: currentTime + 100 },
      ]);
      await zeroLC.settleCharges([chargeBatch]);

      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.numCharges).to.equal(0n);

      // Wait for scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // numCharges should be updated
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.numCharges).to.equal(3n); // nonce - 1 = 4 - 1 = 3
    });

    it("should clear remainingAmount in authorizationScopes after compaction", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100, 0);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const authScope1 = await zeroLC.authorizationScopes(scopeHash);
      expect(authScope1.remainingAmount).to.equal(300n);

      // Wait for scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // remainingAmount should be cleared
      const authScope2 = await zeroLC.authorizationScopes(scopeHash);
      expect(authScope2.remainingAmount).to.equal(0n);
    });

    it("should preserve other scope state during compaction (pending amounts, notAfter, etc.)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 500n, 3600, currentTime, currentTime + 100, 0);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle some charges to set pending amounts
      await time.increase(1); // Ensure charge timestamp is after scope registration
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: 100n, nonce: 1, notAfter: currentTime + 100 },
      ]);
      await zeroLC.settleCharges([chargeBatch]);

      const authScope1 = await zeroLC.authorizationScopes(scopeHash);
      const pendingAmount1 = await zeroLC.getAgentPendingAmount(scope);
      expect(pendingAmount1).to.equal(100n);
      const nonce1 = await zeroLC.getScopeNonce(scopeHash);
      expect(nonce1).to.equal(2n);
      const originalNotAfter = authScope1.notAfter;
      const originalLastChargeTimestamp = authScope1.lastChargeTimestamp;

      // Wait for scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Other fields should be preserved
      const authScope2 = await zeroLC.authorizationScopes(scopeHash);
      const pendingAmount2 = await zeroLC.getAgentPendingAmount(scope);
      expect(pendingAmount2).to.equal(100n); // Preserved
      const nonce2 = await zeroLC.getScopeNonce(scopeHash);
      expect(nonce2).to.equal(2n); // Preserved
      expect(authScope2.notAfter).to.equal(originalNotAfter); // Preserved
      expect(authScope2.lastChargeTimestamp).to.equal(originalLastChargeTimestamp); // Preserved
      const flags2 = await zeroLC.getScopeFlags(scopeHash);
      expect(Number(flags2) & FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED).to.not.equal(0); // Updated
      expect(authScope2.remainingAmount).to.equal(0n); // Cleared
    });
  });

  describe("8.4 Amount Granularity", function () {
    it("should compact correctly with granularity 3 (1000x scaling)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const granularity = 3;
      const totalAmount = 300000n; // Will be stored as 300 (scaled down by 10^3)

      await depositForUser(user1, 1000000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, totalAmount, 3600, currentTime, currentTime + 100, granularity);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Verify scope is stored with scaled amount
      const scopeState1 = await zeroLC.authorizationScopes(scopeHash);
      expect(scopeState1.remainingAmount).to.equal(calculateScaledAmount(totalAmount, granularity));

      // Wait for scope to expire
      await time.increase(150);

      const userState1 = await zeroLC.userStates(user1.address);
      const initialBalance = userState1.balance;

      // Trigger compaction
      await depositForUser(user1, 100000n);
      await registerScope(user1, agent1, 100000n, 3600, undefined, undefined, granularity);

      // Check that balance increased by the expired scope's remaining amount (unscaled)
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.balance).to.equal(initialBalance + totalAmount + 100000n - 100000n);
    });

    it("should compact correctly with granularity 6 (USDC-like, 1M scaling)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const granularity = 6;
      const totalAmount = 300000000n; // Will be stored as 300 (scaled down by 10^6)

      await depositForUser(user1, 1000000000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, totalAmount, 3600, currentTime, currentTime + 100, granularity);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Verify scope is stored with scaled amount
      const scopeState1 = await zeroLC.authorizationScopes(scopeHash);
      expect(scopeState1.remainingAmount).to.equal(calculateScaledAmount(totalAmount, granularity));

      // Wait for scope to expire
      await time.increase(150);

      const userState1 = await zeroLC.userStates(user1.address);
      const initialBalance = userState1.balance;

      // Trigger compaction
      await depositForUser(user1, 100000000n);
      await registerScope(user1, agent1, 100000000n, 3600, undefined, undefined, granularity);

      // Check that balance increased by the expired scope's remaining amount (unscaled)
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.balance).to.equal(initialBalance + totalAmount + 100000000n - 100000000n);
    });

    it("should compact correctly with granularity 12 (high precision)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const granularity = 12;
      const totalAmount = 300000000000000n; // Will be stored as 300 (scaled down by 10^12)

      await depositForUser(user1, ethers.parseEther("10"));
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, totalAmount, 3600, currentTime, currentTime + 100, granularity);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Verify scope is stored with scaled amount
      const scopeState1 = await zeroLC.authorizationScopes(scopeHash);
      expect(scopeState1.remainingAmount).to.equal(calculateScaledAmount(totalAmount, granularity));

      // Wait for scope to expire
      await time.increase(150);

      const userState1 = await zeroLC.userStates(user1.address);
      const initialBalance = userState1.balance;

      // Trigger compaction
      await depositForUser(user1, 100000000000000n);
      await registerScope(user1, agent1, 100000000000000n, 3600, undefined, undefined, granularity);

      // Check that balance increased by the expired scope's remaining amount (unscaled)
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.balance).to.equal(initialBalance + totalAmount + 100000000000000n - 100000000000000n);
    });

    it("should handle mixed granularities during compaction", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, ethers.parseEther("10"));
      const currentTime = await time.latest();

      // Create scopes with different granularities that will all expire
      const scope1 = await registerScope(user1, agent1, 300000n, 3600, currentTime, currentTime + 100, 3); // granularity 3
      const scope2 = await registerScope(user1, agent2, 200000000n, 3600, currentTime, currentTime + 100, 6); // granularity 6

      const userState1 = await zeroLC.userStates(user1.address);
      const initialBalance = userState1.balance;

      // Wait for both to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100000n);
      await registerScope(user1, agent1, 100000n, 3600, undefined, undefined, 0);

      // Both expired scopes should have their remainingAmount returned (unscaled)
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.balance).to.equal(initialBalance + 300000n + 200000000n + 100000n - 100000n);
    });

    it("should verify authorizationScopeData is preserved during compaction", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, getAuthorizationScopeData } =
        await loadFixture(deployZeroLCFixture);

      const granularity = 6;
      const totalAmount = 300000000n;
      const disputeWindow = 7200;

      await depositForUser(user1, 1000000000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow, currentTime, currentTime + 100, granularity);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Verify scope data is stored correctly
      const scopeData1 = await getAuthorizationScopeData(scopeHash);
      expect(scopeData1.totalAmount).to.equal(totalAmount); // Unscaled
      expect(scopeData1.disputeWindow).to.equal(disputeWindow);
      expect(scopeData1.amountGranularity).to.equal(granularity);

      // Wait for scope to expire and compact
      await time.increase(150);
      await depositForUser(user1, 100000000n);
      await registerScope(user1, agent1, 100000000n, 3600, undefined, undefined, 0);

      // Verify scope data is still intact after compaction
      const scopeData2 = await getAuthorizationScopeData(scopeHash);
      expect(scopeData2.totalAmount).to.equal(totalAmount);
      expect(scopeData2.disputeWindow).to.equal(disputeWindow);
      expect(scopeData2.amountGranularity).to.equal(granularity);
    });

    it("should compact with remainingAmount == 0 and granularity > 0", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const granularity = 3;
      const totalAmount = 300000n;

      await depositForUser(user1, 1000000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, totalAmount, 3600, currentTime, currentTime + 100, granularity);

      // Fully drain the scope with scaled amount
      await time.increase(1);
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(totalAmount, granularity), nonce: 1, notAfter: currentTime + 100 },
      ]);
      await zeroLC.settleCharges([chargeBatch]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const authScope1 = await zeroLC.authorizationScopes(scopeHash);
      expect(authScope1.remainingAmount).to.equal(0n);

      // Wait for scope to expire
      await time.increase(150);

      const userState1 = await zeroLC.userStates(user1.address);
      const initialBalance = userState1.balance;

      // Trigger compaction
      await depositForUser(user1, 100000n);
      await registerScope(user1, agent1, 100000n, 3600, undefined, undefined, 0);

      // No balance should be returned (remainingAmount was 0)
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.balance).to.equal(initialBalance + 100000n - 100000n);
    });
  });

  describe("8.5 Three-State Amount Fields", function () {
    it("should initialize three-state amounts to zero on registration", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const scope = await registerScope(user1, agent1, 300n, 3600, undefined, undefined, 0);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const scopeState = await zeroLC.authorizationScopes(scopeHash);

      // All amount buckets should be empty/zero after registration
      expect(scopeState.chargedAmountWithdrawable).to.equal(0n);
      expect(scopeState.chargedAmountFinalizing).to.equal(0n);
      expect(scopeState.chargedAmountPending).to.equal(0n);
      expect(scopeState.remainingAmount).to.equal(300n); // Full scope amount available
    });

    it("should preserve chargedAmountPending during compaction", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 500n, 3600, currentTime, currentTime + 200, 0);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle charges (goes to pending)
      await time.increase(1);
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: 100n, nonce: 1, notAfter: currentTime + 200 },
      ]);
      await zeroLC.settleCharges([chargeBatch]);

      const scopeState1 = await zeroLC.authorizationScopes(scopeHash);
      expect(scopeState1.chargedAmountPending).to.equal(100n);

      // Create another scope that will expire first
      const scope2 = await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 50, 0);

      // Wait for second scope to expire
      await time.increase(60);

      // Trigger compaction (first scope still active)
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Verify pending amount is preserved in first scope
      const scopeState2 = await zeroLC.authorizationScopes(scopeHash);
      expect(scopeState2.chargedAmountPending).to.equal(100n);
    });

    it("should preserve chargedAmountFinalizing during compaction", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const disputeWindow = 10; // Short dispute window
      const scope = await registerScope(user1, agent1, 500n, disputeWindow, currentTime, currentTime + 200, 0);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle charges
      await time.increase(1);
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: 100n, nonce: 1, notAfter: currentTime + 200 },
      ]);
      await zeroLC.settleCharges([chargeBatch]);

      // Advance time past dispute window to move pending to finalizing
      await time.increase(disputeWindow + 5);

      // Create another scope that will expire
      const scope2 = await registerScope(user1, agent1, 200n, 3600, currentTime + 15, currentTime + 30, 0);

      // Wait for second scope to expire
      await time.increase(20);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Verify amounts are preserved
      const pendingAmount = await zeroLC.getAgentPendingAmount(scope);
      expect(pendingAmount).to.be.gt(0n); // Should have finalizing or pending amounts
    });

    it("should preserve chargedAmountWithdrawable during compaction", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const disputeWindow = 5;
      const scope = await registerScope(user1, agent1, 500n, disputeWindow, currentTime, currentTime + 300, 0);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle charges
      await time.increase(1);
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: 100n, nonce: 1, notAfter: currentTime + 300 },
      ]);
      await zeroLC.settleCharges([chargeBatch]);

      // Advance time past one dispute window
      await time.increase(disputeWindow + 2);

      // Settle another batch to move pending → finalizing
      await time.increase(1);
      const chargeBatch2 = await createChargeBatch(scope, agent1, [
        { scaledAmount: 50n, nonce: 2, notAfter: currentTime + 300 },
      ]);
      await zeroLC.settleCharges([chargeBatch2]);

      // Advance time past another dispute window
      await time.increase(disputeWindow + 2);

      // Settle a third batch to move finalizing → withdrawable
      await time.increase(1);
      const chargeBatch3 = await createChargeBatch(scope, agent1, [
        { scaledAmount: 25n, nonce: 3, notAfter: currentTime + 300 },
      ]);
      await zeroLC.settleCharges([chargeBatch3]);

      // Create a scope that will expire
      const newTime = await time.latest();
      const scope2 = await registerScope(user1, agent1, 200n, 3600, newTime, newTime + 15, 0);

      // Wait for second scope to expire
      await time.increase(15);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Verify withdrawable amount exists
      const scopeState = await zeroLC.authorizationScopes(scopeHash);
      expect(scopeState.chargedAmountWithdrawable).to.be.gt(0n);
    });

    it("should compact expired scope with pending charges correctly", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 500n, 3600, currentTime, currentTime + 100, 0);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle charges
      await time.increase(1);
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: 100n, nonce: 1, notAfter: currentTime + 100 },
      ]);
      await zeroLC.settleCharges([chargeBatch]);

      const scopeState1 = await zeroLC.authorizationScopes(scopeHash);
      expect(scopeState1.chargedAmountPending).to.equal(100n);
      expect(scopeState1.remainingAmount).to.equal(400n);

      // Wait for scope to expire
      await time.increase(150);

      const userState1 = await zeroLC.userStates(user1.address);
      const initialBalance = userState1.balance;

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // remainingAmount returns to balance, but pending stays
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.balance).to.equal(initialBalance + 400n + 100n - 100n); // Only remaining amount returned

      // Pending amount should still exist
      const scopeState2 = await zeroLC.authorizationScopes(scopeHash);
      expect(scopeState2.chargedAmountPending).to.equal(100n);
      expect(scopeState2.remainingAmount).to.equal(0n); // Cleared
    });
  });

  describe("8.6 Helper View Methods", function () {
    it("should return correct nonce via getScopeNonce", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 500n, 3600, currentTime, currentTime + 100, 0);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Initial nonce should be 1
      const nonce1 = await zeroLC.getScopeNonce(scopeHash);
      expect(nonce1).to.equal(1);

      // Settle charges to increment nonce
      await time.increase(1);
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: 50n, nonce: 1, notAfter: currentTime + 100 },
        { scaledAmount: 50n, nonce: 2, notAfter: currentTime + 100 },
        { scaledAmount: 50n, nonce: 3, notAfter: currentTime + 100 },
      ]);
      await zeroLC.settleCharges([chargeBatch]);

      // Nonce should now be 4
      const nonce2 = await zeroLC.getScopeNonce(scopeHash);
      expect(nonce2).to.equal(4);
    });

    it("should return correct flags via getScopeFlags", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 500n, 3600, currentTime, currentTime + 100, 0);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Initially flag should be 0
      const flags1 = await zeroLC.getScopeFlags(scopeHash);
      expect(Number(flags1) & FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED).to.equal(0);

      // Settle charges
      await time.increase(1);
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: 50n, nonce: 1, notAfter: currentTime + 100 },
      ]);
      await zeroLC.settleCharges([chargeBatch]);

      // Wait for scope to expire and trigger compaction
      await time.increase(150);
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600, undefined, undefined, 0);

      // Flag should now be set
      const flags2 = await zeroLC.getScopeFlags(scopeHash);
      expect(Number(flags2) & FLAG_SCOPE_STATUS_NUM_CHARGES_RECORDED).to.not.equal(0);
    });
  });
});

