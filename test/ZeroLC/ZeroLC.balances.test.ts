import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeroLC, TestERC20, UniversalSigValidator } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ZeroLC - Balance View Functions", function () {
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
      depositForUser,
      registerScope,
      createChargeBatch,
      calculateScaledAmount,
      getAuthorizationScopeData,
    };
  }

  describe("7.1 balanceOf", function () {
    it("should return correct total (balance + all remainingAmounts)", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      // Deposit some tokens
      const depositAmount = 1000n;
      await depositForUser(user1, depositAmount);

      // Register two scopes
      const currentTime = await time.latest();
      await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 7200);
      await registerScope(user1, agent2, 200n, 3600, currentTime, currentTime + 7200);

      // balanceOf should return: (1000 - 300 - 200) + 300 + 200 = 1000
      const balance = await zeroLC.balanceOf(user1.address);
      expect(balance).to.equal(depositAmount);
    });

    it("should return only balance when no scopes exist", async function () {
      const { zeroLC, user1, depositForUser } = await loadFixture(deployZeroLCFixture);

      const depositAmount = 100n;
      await depositForUser(user1, depositAmount);

      const balance = await zeroLC.balanceOf(user1.address);
      expect(balance).to.equal(depositAmount);
    });

    it("should return correct balance with multiple active scopes", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      const depositAmount = 1000n;
      await depositForUser(user1, depositAmount);

      const currentTime = await time.latest();

      // Create 3 different scopes
      await registerScope(user1, agent1, 100n, 3600, currentTime, currentTime + 7200);
      await registerScope(user1, agent2, 200n, 3600, currentTime, currentTime + 7200);
      await time.increase(15);
      await registerScope(user1, agent1, 150n, 3600, currentTime + 10, currentTime + 14400);

      // Total should still be 1000 (100 + 200 + 150 in scopes + 550 free balance)
      const balance = await zeroLC.balanceOf(user1.address);
      expect(balance).to.equal(depositAmount);
    });

    it("should include expired scope amounts in total balance", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      const depositAmount = 500n;
      await depositForUser(user1, depositAmount);

      const currentTime = await time.latest();
      await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 100);

      // Before expiration
      let balance = await zeroLC.balanceOf(user1.address);
      expect(balance).to.equal(depositAmount);

      // After expiration - balance should still include the expired scope amount
      await time.increase(150);
      balance = await zeroLC.balanceOf(user1.address);
      expect(balance).to.equal(depositAmount); // Still 500 total
    });

    it("should return correct balance after partial settlements", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const depositAmount = 500n;
      await depositForUser(user1, depositAmount);

      const currentTime = await time.latest();
      const granularity = 0; // No scaling for simplicity
      const scope = await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 7200, granularity);

      // Advance time to ensure charge batch timestamp is after scope registration
      await time.increase(1);
      const chargeTime = await time.latest();

      // Settle some charges
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(50n, granularity), nonce: 1, notAfter: currentTime + 7200 },
      ], chargeTime);

      await zeroLC.settleCharges([chargeBatch]);

      // Balance should now be: 200 (free) + 250 (remaining in scope) = 450
      const balance = await zeroLC.balanceOf(user1.address);
      expect(balance).to.equal(450n);
    });

    it("should return correct balance after deposits", async function () {
      const { zeroLC, user1, depositForUser } = await loadFixture(deployZeroLCFixture);

      const depositAmount1 = 100n;
      await depositForUser(user1, depositAmount1);

      let balance = await zeroLC.balanceOf(user1.address);
      expect(balance).to.equal(depositAmount1);

      // Second deposit
      const depositAmount2 = 50n;
      await depositForUser(user1, depositAmount2);

      balance = await zeroLC.balanceOf(user1.address);
      expect(balance).to.equal(depositAmount1 + depositAmount2);
    });

    it("should return correct balance after disputes", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const depositAmount = 500n;
      await depositForUser(user1, depositAmount);

      const currentTime = await time.latest();
      const granularity = 0; // No scaling for simplicity
      const scope = await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 7200, granularity);

      // Advance time to ensure charge batch timestamp is after scope registration
      await time.increase(1);
      const chargeTime = await time.latest();

      // Settle some charges
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(100n, granularity), nonce: 1, notAfter: currentTime + 7200 },
      ], chargeTime);

      await zeroLC.settleCharges([chargeBatch]);

      // Now dispute
      const scopeHash = await zeroLC.getScopeHash(scope);
      const domain = {
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      };

      const types = {
        Dispute: [
          { name: "scopeHash", type: "bytes32" },
          { name: "amountToClawback", type: "uint32" },
        ],
      };

      const value = {
        scopeHash: scopeHash,
        amountToClawback: Number(calculateScaledAmount(50n, granularity)),
      };

      const disputeSignature = await user1.signTypedData(domain, types, value);

      const dispute = {
        chargeBatch: chargeBatch,
        amountToClawback: Number(calculateScaledAmount(50n, granularity)),
        signature: disputeSignature,
      };

      await zeroLC.dispute([dispute]);

      // Balance after dispute: 200 (free) + 50 (clawed back) + 200 (remaining in scope) = 450
      // Note: balanceOf includes ALL remainingAmount regardless of expiration
      const balance = await zeroLC.balanceOf(user1.address);
      expect(balance).to.equal(450n);
    });

    it("should return correct unscaled balance with granularity 3", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      const depositAmount = 1000000n; // Must be divisible by 10^3
      await depositForUser(user1, depositAmount);

      const currentTime = await time.latest();
      const granularity = 3; // Divides amounts by 1000
      const scopeAmount = 300000n; // Will be stored as 300 internally
      await registerScope(user1, agent1, scopeAmount, 3600, currentTime, currentTime + 7200, granularity);

      // balanceOf should return UNSCALED amounts: (1000000 - 300000) + 300000 = 1000000
      const balance = await zeroLC.balanceOf(user1.address);
      expect(balance).to.equal(depositAmount);
    });

    it("should return correct unscaled balance with granularity 6", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      const depositAmount = 10000000n; // Must be divisible by 10^6
      await depositForUser(user1, depositAmount);

      const currentTime = await time.latest();
      const granularity = 6; // USDC-like, divides by 1,000,000
      const scopeAmount1 = 3000000n; // Will be stored as 3 internally
      const scopeAmount2 = 2000000n; // Will be stored as 2 internally

      await registerScope(user1, agent1, scopeAmount1, 3600, currentTime, currentTime + 7200, granularity);
      await registerScope(user1, agent2, scopeAmount2, 3600, currentTime, currentTime + 7200, granularity);

      // balanceOf should return UNSCALED amounts: (10000000 - 3000000 - 2000000) + 3000000 + 2000000 = 10000000
      const balance = await zeroLC.balanceOf(user1.address);
      expect(balance).to.equal(depositAmount);
    });

    it("should return correct unscaled balance after settlements with granularity", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      const depositAmount = 5000000n;
      await depositForUser(user1, depositAmount);

      const currentTime = await time.latest();
      const granularity = 3;
      const scopeAmount = 3000000n;
      const scope = await registerScope(user1, agent1, scopeAmount, 3600, currentTime, currentTime + 7200, granularity);

      // Advance time to ensure charge batch timestamp is after scope registration
      await time.increase(1);
      const chargeTime = await time.latest();

      // Settle some charges (500,000 unscaled = 500 scaled)
      const chargeAmount = 500000n;
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { scaledAmount: calculateScaledAmount(chargeAmount, granularity), nonce: 1, notAfter: currentTime + 7200 },
      ], chargeTime);

      await zeroLC.settleCharges([chargeBatch]);

      // Balance should be UNSCALED: 2000000 (free) + 2500000 (remaining) = 4500000
      const balance = await zeroLC.balanceOf(user1.address);
      expect(balance).to.equal(4500000n);
    });

    it("should return zero for address with no state", async function () {
      const { zeroLC, user2 } = await loadFixture(deployZeroLCFixture);

      const balance = await zeroLC.balanceOf(user2.address);
      expect(balance).to.equal(0);
    });

    it("should return zero for zero address", async function () {
      const { zeroLC } = await loadFixture(deployZeroLCFixture);

      const balance = await zeroLC.balanceOf(ethers.ZeroAddress);
      expect(balance).to.equal(0);
    });
  });

  describe("7.2 unlockedBalanceOf", function () {
    it("should return balance + expired scope amounts only", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      const depositAmount = 1000n;
      await depositForUser(user1, depositAmount);

      const currentTime = await time.latest();

      // One active scope
      await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 7200);

      // One scope that will expire soon
      await registerScope(user1, agent2, 200n, 3600, currentTime, currentTime + 100);

      // Before expiration - only free balance
      let unlockedBalance = await zeroLC.unlockedBalanceOf(user1.address);
      expect(unlockedBalance).to.equal(500n); // 1000 - 300 - 200

      // After second scope expires
      await time.increase(150);
      unlockedBalance = await zeroLC.unlockedBalanceOf(user1.address);
      expect(unlockedBalance).to.equal(700n); // 500 + 200 (expired)
    });

    it("should return only balance when no scopes exist", async function () {
      const { zeroLC, user1, depositForUser } = await loadFixture(deployZeroLCFixture);

      const depositAmount = 100n;
      await depositForUser(user1, depositAmount);

      const unlockedBalance = await zeroLC.unlockedBalanceOf(user1.address);
      expect(unlockedBalance).to.equal(depositAmount);
    });

    it("should return only balance when all scopes are active", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      const depositAmount = 1000n;
      await depositForUser(user1, depositAmount);

      const currentTime = await time.latest();

      await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 7200);
      await registerScope(user1, agent2, 200n, 3600, currentTime, currentTime + 7200);

      // All scopes active - unlocked should only be free balance
      const unlockedBalance = await zeroLC.unlockedBalanceOf(user1.address);
      expect(unlockedBalance).to.equal(500n); // 1000 - 300 - 200
    });

    it("should return balance + all amounts when all scopes are expired", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      const depositAmount = 1000n;
      await depositForUser(user1, depositAmount);

      const currentTime = await time.latest();

      await registerScope(user1, agent1, 300n, 3600, currentTime, currentTime + 100);
      await registerScope(user1, agent2, 200n, 3600, currentTime, currentTime + 100);

      // Expire all scopes
      await time.increase(150);

      // All scopes expired - unlocked should be everything
      const unlockedBalance = await zeroLC.unlockedBalanceOf(user1.address);
      expect(unlockedBalance).to.equal(depositAmount); // All 1000
    });

    it("should correctly handle mixed active/expired scopes", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      const depositAmount = 1000n;
      await depositForUser(user1, depositAmount);

      const currentTime = await time.latest();

      // Mix of expiration times
      await registerScope(user1, agent1, 100n, 3600, currentTime, currentTime + 50); // Expires first
      await registerScope(user1, agent2, 200n, 3600, currentTime, currentTime + 7200); // Still active
      await registerScope(user1, agent1, 150n, 3600, currentTime, currentTime + 100); // Expires second

      // After 75 seconds: only first expired (currentTime + 50), second still active, third not yet expired
      await time.increase(75);

      // Unlocked: 550 (free) + 100 (expired at currentTime + 50) = 650
      const unlockedBalance = await zeroLC.unlockedBalanceOf(user1.address);
      expect(unlockedBalance).to.equal(650n);
    });

    it("should include expired scope at exact boundary (notAfter == block.timestamp)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      const depositAmount = 500n;
      await depositForUser(user1, depositAmount);

      const currentTime = await time.latest();
      await registerScope(user1, agent1, 200n, 3600, currentTime, currentTime + 100);

      // Move to exact expiration time
      await time.increaseTo(currentTime + 100);

      // At exact boundary, scope IS expired (notAfter is EXCLUSIVE: block.timestamp < notAfter is false when notAfter == block.timestamp)
      // So unlocked includes the expired scope amount
      const unlockedBalance = await zeroLC.unlockedBalanceOf(user1.address);
      expect(unlockedBalance).to.equal(500n); // Free balance + expired scope
    });

    it("should return correct unscaled unlocked balance with granularity 3", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      const depositAmount = 10000000n;
      await depositForUser(user1, depositAmount);

      const currentTime = await time.latest();
      const granularity = 3;

      // One active scope, one expired scope
      await registerScope(user1, agent1, 3000000n, 3600, currentTime, currentTime + 7200, granularity); // Active
      await registerScope(user1, agent2, 2000000n, 3600, currentTime, currentTime + 100, granularity); // Will expire

      // Before expiration - only free balance is unlocked
      let unlockedBalance = await zeroLC.unlockedBalanceOf(user1.address);
      expect(unlockedBalance).to.equal(5000000n); // 10000000 - 3000000 - 2000000

      // After second scope expires
      await time.increase(150);
      unlockedBalance = await zeroLC.unlockedBalanceOf(user1.address);
      expect(unlockedBalance).to.equal(7000000n); // 5000000 + 2000000 (expired, UNSCALED)
    });

    it("should return correct unscaled unlocked balance with granularity 6", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      const depositAmount = 100000000n; // 100 million (100 USDC if this were USDC)
      await depositForUser(user1, depositAmount);

      const currentTime = await time.latest();
      const granularity = 6; // USDC-like

      // All scopes expired
      await registerScope(user1, agent1, 30000000n, 3600, currentTime, currentTime + 100, granularity);

      // Expire scope
      await time.increase(150);

      // All expired - unlocked should be everything, UNSCALED
      const unlockedBalance = await zeroLC.unlockedBalanceOf(user1.address);
      expect(unlockedBalance).to.equal(depositAmount); // Full 100000000
    });

    it("should return correct unlocked balance with mixed granularities", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      const depositAmount = 10000000n;
      await depositForUser(user1, depositAmount);

      const currentTime = await time.latest();

      // Mix of granularities: one with granularity 3, one with granularity 6
      await registerScope(user1, agent1, 3000000n, 3600, currentTime, currentTime + 100, 3); // Expires, granularity 3
      await registerScope(user1, agent2, 2000000n, 3600, currentTime, currentTime + 7200, 6); // Active, granularity 6

      // After first scope expires
      await time.increase(150);

      // Unlocked: 5000000 (free) + 3000000 (expired with granularity 3, UNSCALED) = 8000000
      const unlockedBalance = await zeroLC.unlockedBalanceOf(user1.address);
      expect(unlockedBalance).to.equal(8000000n);
    });

    it("should return zero for address with no state", async function () {
      const { zeroLC, user2 } = await loadFixture(deployZeroLCFixture);

      const unlockedBalance = await zeroLC.unlockedBalanceOf(user2.address);
      expect(unlockedBalance).to.equal(0);
    });

    it("should return zero for zero address", async function () {
      const { zeroLC } = await loadFixture(deployZeroLCFixture);

      const unlockedBalance = await zeroLC.unlockedBalanceOf(ethers.ZeroAddress);
      expect(unlockedBalance).to.equal(0);
    });
  });
});
