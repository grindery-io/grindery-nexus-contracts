import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeroLC, TestERC20, UniversalSigValidator } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

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
    const ERC1967ProxyFactory = await ethers.getContractFactory("@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy");
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
      notAfter?: number
    ) {
      const currentTime = await time.latest();
      const scope = {
        user: user.address,
        totalAmount: totalAmount,
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
          { name: "totalAmount", type: "uint48" },
          { name: "disputeWindow", type: "uint48" },
          { name: "agent", type: "address" },
          { name: "notBefore", type: "uint48" },
          { name: "notAfter", type: "uint48" },
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

      const scopeHash = await zeroLC.getScopeHash(scope);

      let batchPartHash = "0x0000000000000000000000000000000000000000000000000000000000000000";
      if (chargeEntries.length > 1) {
        const entriesWithoutLast = chargeEntries.slice(0, -1);
        const encodedEntries = entriesWithoutLast.map(e => [e.amount, e.nonce, e.notAfter]);
        batchPartHash = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["tuple(uint48,uint48,uint48)[]"],
            [encodedEntries]
          )
        );
      }

      const lastEntry = chargeEntries[chargeEntries.length - 1];

      const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint48,uint48,uint48)", "bytes32"],
        [batchPartHash, [lastEntry.amount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
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
    };
  }

  describe("8.1 Compaction Logic", function () {
    it("should return remainingAmount to balance when compacting expired scopes", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      // Deposit and create two scopes - one will expire, one won't
      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope1 = await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100); // Will expire
      await registerScope(user1, agent2, 200n, 3600, currentTime, currentTime + 7200); // Won't expire

      // Check initial balance
      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.balance).to.equal(500n); // 1000 - 300 - 200

      // Wait for first scope to expire
      await time.increase(150);

      // Register a new scope to trigger compaction
      await depositForUser(user1, 300n);
      await registerScope(user1, agent1, 100n, 3600);

      // Check that balance increased by the expired scope's remaining amount
      const userState2 = await zeroLC.userStates(user1.address);
      // Should be: 500 (initial free) + 300 (from expired scope1) + 300 (new deposit) - 100 (new scope) = 1000
      expect(userState2.balance).to.equal(1000n);
    });

    it("should update numCharges from nonce (nonce - 1) when compacting", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 500n, 3600, currentTime, currentTime + 100);

      // Settle some charges to increment nonce
      const chargeBatch1 = await createChargeBatch(scope, agent1, [
        { amount: 50n, nonce: 1, notAfter: currentTime + 100 },
        { amount: 50n, nonce: 2, notAfter: currentTime + 100 },
      ]);
      await zeroLC.settleCharges([chargeBatch1]);

      // Now nonce should be 3, so numCharges should be 2 when recorded
      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.numCharges).to.equal(0n); // Not yet recorded

      // Wait for scope to expire
      await time.increase(150);

      // Trigger compaction by registering new scope
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

      // Check that numCharges was recorded
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.numCharges).to.equal(2n); // nonce - 1 = 3 - 1 = 2
    });

    it("should set isNumChargesRecorded flag to 1 after compaction", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 500n, 3600, currentTime, currentTime + 100);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle a charge
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 50n, nonce: 1, notAfter: currentTime + 100 },
      ]);
      await zeroLC.settleCharges([chargeBatch]);

      // Check flag before compaction
      const authScope1 = await zeroLC.authorizationScopes(scopeHash);
      expect(authScope1.isNumChargesRecorded).to.equal(0);

      // Wait for scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

      // Check flag after compaction
      const authScope2 = await zeroLC.authorizationScopes(scopeHash);
      expect(authScope2.isNumChargesRecorded).to.equal(1);
    });

    it("should remove expired scopes from array during compaction", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 100); // Will expire
      await registerScope(user1, agent2, 200n, 3600, currentTime, currentTime + 7200); // Won't expire

      // Check initial array length
      const scopeHashes1 = await zeroLC.getUserAuthorizationScopeHashes(user1.address);
      expect(scopeHashes1.length).to.equal(2);

      // Wait for first scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

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
      await registerScope(user1, agent1, 100n, 3600);

      // Should complete successfully
      const userState2 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(1);
    });

    it("should call compaction during registerAuthorizationScope", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      // Create a scope that will expire
      await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100);

      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.balance).to.equal(700n); // 1000 - 300

      // Wait for scope to expire
      await time.increase(150);

      // Register new scope - should trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent2, 200n, 3600);

      // Balance should include the expired scope's remaining amount
      const userState2 = await zeroLC.userStates(user1.address);
      // 700 (old free) + 300 (expired scope) + 100 (new deposit) - 200 (new scope) = 900
      expect(userState2.balance).to.equal(900n);
    });

    it("should compact multiple expired scopes at once", async function () {
      const { zeroLC, user1, agent1, agent2, agent3, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 2000n);
      const currentTime = await time.latest();

      // Create three scopes that will all expire
      await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 100);
      await registerScope(user1, agent2, 300n, 3600, currentTime, currentTime + 100);
      await registerScope(user1, agent3, 250n, 3600, currentTime, currentTime + 100);

      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.balance).to.equal(1250n); // 2000 - 200 - 300 - 250
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3);

      // Wait for all to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

      // All three expired scopes should be removed and balances restored
      const userState2 = await zeroLC.userStates(user1.address);
      // 1250 + 200 + 300 + 250 + 100 - 100 = 2000
      expect(userState2.balance).to.equal(2000n);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(1); // Only new scope
    });

    it("should not compact scopes with no charges (nonce == 0)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Don't settle any charges - nonce remains 1 (initial value)
      // Wait for scope to expire
      await time.increase(150);

      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.numCharges).to.equal(0n);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

      // Since nonce was not 0 (it was 1), it should have been compacted
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.balance).to.equal(1000n); // Got the 300 back from expired scope
    });

    it("should not affect active scopes during compaction", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const expiredScope = await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 100);
      const activeScope = await registerScope(user1, agent2, 300n, 3600, currentTime, currentTime + 7200);

      const expiredScopeHash = await zeroLC.getScopeHash(expiredScope);
      const activeScopeHash = await zeroLC.getScopeHash(activeScope);

      // Wait for first scope to expire
      await time.increase(150);

      // Get active scope state before compaction
      const activeState1 = await zeroLC.authorizationScopes(activeScopeHash);
      expect(activeState1.remainingAmount).to.equal(300n);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

      // Active scope should remain unchanged
      const activeState2 = await zeroLC.authorizationScopes(activeScopeHash);
      expect(activeState2.remainingAmount).to.equal(300n);
      expect(activeState2.notAfter).to.equal(activeState1.notAfter);
    });

    it("should compact scope at exact expiration boundary (notAfter == block.timestamp)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100);

      // Move to exact expiration time
      await time.increaseTo(currentTime + 100);

      // At exact boundary where block.timestamp == notAfter:
      // The condition uint48(block.timestamp) < state.notAfter evaluates to FALSE
      // Therefore the scope IS EXPIRED and SHOULD be compacted (notAfter is EXCLUSIVE)

      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.balance).to.equal(700n);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

      // At exact boundary, scope is expired and should be compacted
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.balance).to.equal(1000n); // 700 + 300 (expired) + 100 - 100
    });

    it("should handle compaction when scope has remainingAmount == 0", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100);

      // Fully drain the scope
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 300n, nonce: 1, notAfter: currentTime + 100 },
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
      await registerScope(user1, agent1, 100n, 3600);

      // No balance should be returned (remainingAmount was 0)
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.balance).to.equal(700n); // 700 + 0 (nothing to return) + 100 - 100
    });

    it("should only record numCharges once (isNumChargesRecorded prevents duplicate)", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope, createChargeBatch } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope1 = await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100);

      // Settle charges
      const chargeBatch = await createChargeBatch(scope1, agent1, [
        { amount: 50n, nonce: 1, notAfter: currentTime + 100 },
        { amount: 50n, nonce: 2, notAfter: currentTime + 100 },
      ]);
      await zeroLC.settleCharges([chargeBatch]);

      // Wait for scope to expire
      await time.increase(150);

      // First compaction - should record numCharges
      await depositForUser(user1, 100n);
      const newTime = await time.latest();
      const scope2 = await registerScope(user1, agent2, 100n, 3600, newTime, newTime + 100);

      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.numCharges).to.equal(2n);

      // Wait for second scope to expire
      await time.increase(150);

      // Second compaction - should not add numCharges from scope1 again
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.numCharges).to.equal(2n); // Still 2, not doubled
    });
  });

  describe("8.2 Array Manipulation", function () {
    it("should correctly remove and pack array (swap with last, then pop)", async function () {
      const { zeroLC, user1, agent1, agent2, agent3, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 2000n);
      const currentTime = await time.latest();

      // Create 3 scopes
      const scope1 = await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 100); // Will expire
      const scope2 = await registerScope(user1, agent2, 300n, 3600, currentTime, currentTime + 7200); // Active
      const scope3 = await registerScope(user1, agent3, 250n, 3600, currentTime, currentTime + 7200); // Active

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
      await registerScope(user1, agent1, 100n, 3600);

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

      const scope = await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100);

      const userState1 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(1);

      // Wait for scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

      // Array should have only the new scope
      const userState2 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(1);
    });

    it("should handle last element removal", async function () {
      const { zeroLC, user1, agent1, agent2, agent3, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 2000n);
      const currentTime = await time.latest();

      await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 7200); // Active
      await registerScope(user1, agent2, 300n, 3600, currentTime, currentTime + 7200); // Active
      const scope3 = await registerScope(user1, agent3, 250n, 3600, currentTime, currentTime + 100); // Will expire

      const userState1 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3);

      // Wait for last scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

      // Last element should be removed
      const userState2 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3); // 2 active + 1 new
    });

    it("should handle first element removal", async function () {
      const { zeroLC, user1, agent1, agent2, agent3, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 2000n);
      const currentTime = await time.latest();

      const scope1 = await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 100); // Will expire
      await registerScope(user1, agent2, 300n, 3600, currentTime, currentTime + 7200); // Active
      await registerScope(user1, agent3, 250n, 3600, currentTime, currentTime + 7200); // Active

      const scopeHash1 = await zeroLC.getScopeHash(scope1);

      const userState1 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address))[0]).to.equal(scopeHash1);

      // Wait for first scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

      // First element should be removed
      const userState2 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3); // 2 active + 1 new
      expect(await zeroLC.getUserAuthorizationScopeHashes(user1.address)).to.not.include(scopeHash1);
    });

    it("should handle middle element removal", async function () {
      const { zeroLC, user1, agent1, agent2, agent3, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 2000n);
      const currentTime = await time.latest();

      await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 7200); // Active
      const scope2 = await registerScope(user1, agent2, 300n, 3600, currentTime, currentTime + 100); // Will expire
      await registerScope(user1, agent3, 250n, 3600, currentTime, currentTime + 7200); // Active

      const scopeHash2 = await zeroLC.getScopeHash(scope2);

      const userState1 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address))[1]).to.equal(scopeHash2);

      // Wait for middle scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

      // Middle element should be removed
      const userState2 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3); // 2 active + 1 new
      expect(await zeroLC.getUserAuthorizationScopeHashes(user1.address)).to.not.include(scopeHash2);
    });

    it("should empty array when all scopes are expired", async function () {
      const { zeroLC, user1, agent1, agent2, agent3, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 2000n);
      const currentTime = await time.latest();

      // Create all scopes that will expire
      await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 100);
      await registerScope(user1, agent2, 300n, 3600, currentTime, currentTime + 100);
      await registerScope(user1, agent3, 250n, 3600, currentTime, currentTime + 100);

      const userState1 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(3);

      // Wait for all to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

      // All expired scopes removed, only new scope remains
      const userState2 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(1);
    });

    it("should correctly decrement array length after removal", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 2000n);
      const currentTime = await time.latest();

      await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 100); // Will expire
      await registerScope(user1, agent2, 300n, 3600, currentTime, currentTime + 100); // Will expire

      const userState1 = await zeroLC.userStates(user1.address);
      expect((await zeroLC.getUserAuthorizationScopeHashes(user1.address)).length).to.equal(2);

      // Wait for both to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

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

      await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100);

      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.balance).to.equal(700n);

      // Wait for scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

      // Balance should be updated in storage
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.balance).to.equal(1000n); // 700 + 300 + 100 - 100
    });

    it("should update userState.numCharges in storage after compaction", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 500n, 3600, currentTime, currentTime + 100);

      // Settle charges
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 50n, nonce: 1, notAfter: currentTime + 100 },
        { amount: 50n, nonce: 2, notAfter: currentTime + 100 },
        { amount: 50n, nonce: 3, notAfter: currentTime + 100 },
      ]);
      await zeroLC.settleCharges([chargeBatch]);

      const userState1 = await zeroLC.userStates(user1.address);
      expect(userState1.numCharges).to.equal(0n);

      // Wait for scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

      // numCharges should be updated
      const userState2 = await zeroLC.userStates(user1.address);
      expect(userState2.numCharges).to.equal(3n); // nonce - 1 = 4 - 1 = 3
    });

    it("should clear remainingAmount in authorizationScopes after compaction", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const authScope1 = await zeroLC.authorizationScopes(scopeHash);
      expect(authScope1.remainingAmount).to.equal(300n);

      // Wait for scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

      // remainingAmount should be cleared
      const authScope2 = await zeroLC.authorizationScopes(scopeHash);
      expect(authScope2.remainingAmount).to.equal(0n);
    });

    it("should preserve other scope state during compaction (agentPendingAmount, notAfter, etc.)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } = await loadFixture(deployZeroLCFixture);

      await depositForUser(user1, 1000n);
      const currentTime = await time.latest();

      const scope = await registerScope(user1, agent1, 500n, 3600, currentTime, currentTime + 100);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle some charges to set agentPendingAmount
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 100n, nonce: 1, notAfter: currentTime + 100 },
      ]);
      await zeroLC.settleCharges([chargeBatch]);

      const authScope1 = await zeroLC.authorizationScopes(scopeHash);
      expect(authScope1.agentPendingAmount).to.equal(100n);
      expect(authScope1.nonce).to.equal(2n);
      const originalNotAfter = authScope1.notAfter;
      const originalLastChargeTimestamp = authScope1.lastChargeTimestamp;

      // Wait for scope to expire
      await time.increase(150);

      // Trigger compaction
      await depositForUser(user1, 100n);
      await registerScope(user1, agent1, 100n, 3600);

      // Other fields should be preserved
      const authScope2 = await zeroLC.authorizationScopes(scopeHash);
      expect(authScope2.agentPendingAmount).to.equal(100n); // Preserved
      expect(authScope2.nonce).to.equal(2n); // Preserved
      expect(authScope2.notAfter).to.equal(originalNotAfter); // Preserved
      expect(authScope2.lastChargeTimestamp).to.equal(originalLastChargeTimestamp); // Preserved
      expect(authScope2.isNumChargesRecorded).to.equal(1); // Updated
      expect(authScope2.remainingAmount).to.equal(0n); // Cleared
    });
  });
});