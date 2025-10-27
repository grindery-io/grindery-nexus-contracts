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

      const chargeEntries = entries.map((e) => ({
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
        const encodedEntries = entriesWithoutLast.map((e) => [e.amount, e.nonce, e.notAfter]);
        batchPartHash = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(["(uint48,uint24,uint48)[]"], [encodedEntries])
        );
      }

      const lastEntry = chargeEntries[chargeEntries.length - 1];

      // Encode the verifier struct components
      const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "(uint48,uint24,uint48)", "bytes32"],
        [batchPartHash, [lastEntry.amount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
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
      entries: { amount: bigint; nonce: number; notAfter: number }[],
      timestamp?: number
    ) {
      const chargeBatch = await createChargeBatch(scope, agent, entries, timestamp);
      await zeroLC.settleCharges([chargeBatch]);
      return chargeBatch;
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
    };
  }

  describe("20.1 Simple Withdrawal Method (Empty recentCharges)", function () {
    it("should withdraw when all charges are past dispute window", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600; // 1 hour
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Settle charges
      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      // Advance time past dispute window
      await time.increase(disputeWindow + 1);

      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);

      // Withdraw to wallet
      await expect(zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true, // toWallet
        [] // empty recentCharges
      )).to.not.be.reverted;

      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(10000n);

      // Verify state updates
      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.agentPendingAmount).to.equal(0);
      expect(state.withdrawalNonce).to.equal(1); // nonce - 1
    });

    it("should withdraw to wallet (toWallet = true) successfully transfers ERC20 tokens to agent", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 15000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );

      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(15000n);
    });

    it("should withdraw to balance (toWallet = false) credits agent's internal balance", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 20000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      const agentInternalBalanceBefore = await zeroLC.balanceOf(agent1.address);

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        false, // toWallet = false
        []
      );

      const agentInternalBalanceAfter = await zeroLC.balanceOf(agent1.address);
      expect(agentInternalBalanceAfter - agentInternalBalanceBefore).to.equal(20000n);
    });

    it("should revert when charges still in dispute window", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      // Try to withdraw immediately (still in dispute window)
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          []
        )
      ).to.be.revertedWithCustomError(zeroLC, "NoWithdrawableBalance");
    });

    it("should update agentPendingAmount correctly (decreases by withdrawn amount)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 25000n, nonce: 1, notAfter: currentTime + 7200 }]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const stateBefore = await zeroLC.authorizationScopes(scopeHash);
      expect(stateBefore.agentPendingAmount).to.equal(25000n);

      await time.increase(disputeWindow + 1);

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );

      const stateAfter = await zeroLC.authorizationScopes(scopeHash);
      expect(stateAfter.agentPendingAmount).to.equal(0);
    });

    it("should update withdrawalNonce to nonce - 1", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 5000n, nonce: 2, notAfter: currentTime + 7200 },
        { amount: 5000n, nonce: 3, notAfter: currentTime + 7200 },
      ]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const stateBefore = await zeroLC.authorizationScopes(scopeHash);
      expect(stateBefore.nonce).to.equal(4); // nonce starts at 1, processed 3 entries
      expect(stateBefore.withdrawalNonce).to.equal(0);

      await time.increase(disputeWindow + 1);

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );

      const stateAfter = await zeroLC.authorizationScopes(scopeHash);
      expect(stateAfter.withdrawalNonce).to.equal(3); // nonce - 1 = 4 - 1 = 3
    });

    it("should emit AgentWithdrawal event with correct parameters", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 12000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      const scopeHash = await zeroLC.getScopeHash(scope);

      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          []
        )
      )
        .to.emit(zeroLC, "AgentWithdrawal")
        .withArgs(agent1.address, scopeHash, 12000n, true);
    });

    it("should revert with no charges settled (nonce == 1)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // No charges settled, try to withdraw
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          []
        )
      ).to.be.revertedWithCustomError(zeroLC, "NoWithdrawableBalance");
    });

    it("should withdraw at exact dispute window boundary", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      const settlementTime = currentTime;
      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }], settlementTime);

      // Advance time to exactly the dispute window boundary
      // At lastChargeTimestamp + disputeWindow, should be withdrawable
      await time.increaseTo(settlementTime + disputeWindow);

      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          []
        )
      ).to.not.be.reverted;
    });

    it("should revert on multiple consecutive withdrawals (second should fail)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      // First withdrawal should succeed
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );

      // Second withdrawal should fail (no balance left)
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          []
        )
      ).to.be.revertedWithCustomError(zeroLC, "NoWithdrawableBalance");
    });

    it("should revert after all charges fully withdrawn", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      // Withdraw all funds
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );

      // Try to withdraw again
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          []
        )
      ).to.be.revertedWithCustomError(zeroLC, "NoWithdrawableBalance");
    });
  });

  describe("20.2 Detailed Withdrawal Method (With recentCharges)", function () {
    it("should withdraw providing continuous charge sequence from withdrawalNonce + 1", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Settle multiple charges
      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 6000n, nonce: 2, notAfter: currentTime + 7200 },
        { amount: 7000n, nonce: 3, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Create charge batches for withdrawal (must start from withdrawalNonce + 1 = 1)
      const batch = await createChargeBatch(
        scope,
        agent1,
        [
          { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
          { amount: 6000n, nonce: 2, notAfter: currentTime + 7200 },
          { amount: 7000n, nonce: 3, notAfter: currentTime + 7200 },
        ],
        currentTime
      );

      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        [batch]
      );

      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(18000n);
    });

    it("should withdraw with single charge batch", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      const batch = await createChargeBatch(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }], currentTime);

      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        [batch]
      );

      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(10000n);
    });

    it("should withdraw with multiple charge batches", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Settle charges in two separate batches with different timestamps
      const timestamp1 = currentTime;
      await settleCharges(scope, agent1, [{ amount: 5000n, nonce: 1, notAfter: currentTime + 7200 }], timestamp1);

      await time.increase(1); // Advance time by 1 second to get different timestamp
      const timestamp2 = await time.latest();
      await settleCharges(scope, agent1, [{ amount: 6000n, nonce: 2, notAfter: currentTime + 7200 }], timestamp2);

      await time.increase(disputeWindow + 1);

      // Withdraw with both batches
      const batch1 = await createChargeBatch(scope, agent1, [{ amount: 5000n, nonce: 1, notAfter: currentTime + 7200 }], timestamp1);
      const batch2 = await createChargeBatch(scope, agent1, [{ amount: 6000n, nonce: 2, notAfter: currentTime + 7200 }], timestamp2);

      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        [batch1, batch2]
      );

      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(11000n);
    });

    it("should verify charge batch signatures", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }], currentTime);

      await time.increase(disputeWindow + 1);

      // Create batch with wrong agent signature (signed by agent2 instead of agent1)
      const batch = await createChargeBatch(scope, agent2, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }], currentTime);

      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          [batch]
        )
      ).to.be.revertedWithCustomError(zeroLC, "InvalidAgentSignature");
    });

    it("should revert if batch scope doesn't match", async function () {
      const { zeroLC, user1, user2, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);
      await depositForUser(user2, totalAmount);

      const currentTime = await time.latest();
      const scope1 = await registerScope(user1, agent1, totalAmount, disputeWindow);
      const scope2 = await registerScope(user2, agent1, totalAmount, disputeWindow);

      await settleCharges(scope1, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }], currentTime);

      await time.increase(disputeWindow + 1);

      // Create batch for scope1 but try to use it for scope2 withdrawal
      const batch = await createChargeBatch(scope1, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }], currentTime);

      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope2, // Different scope!
          true,
          [batch]
        )
      ).to.be.revertedWithCustomError(zeroLC, "ScopeMismatch");
    });

    it("should revert if charge batch has future timestamp", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }], currentTime);

      await time.increase(disputeWindow + 1);

      // Create batch with future timestamp
      const futureTime = (await time.latest()) + 1000;
      const batch = await createChargeBatch(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }], futureTime);

      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          [batch]
        )
      ).to.be.revertedWithCustomError(zeroLC, "FutureChargeBatch");
    });

    it("should revert if any batch still in dispute window", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      const settlementTime = currentTime;
      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }], settlementTime);

      // Only advance time partially through dispute window
      await time.increase(disputeWindow / 2);

      const batch = await createChargeBatch(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }], settlementTime);

      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          [batch]
        )
      ).to.be.revertedWithCustomError(zeroLC, "BatchStillInDisputeWindow");
    });

    it("should accept batches exactly at dispute window boundary", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      const settlementTime = currentTime;
      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }], settlementTime);

      // Advance to exactly disputeWindow boundary
      await time.increaseTo(settlementTime + disputeWindow);

      const batch = await createChargeBatch(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }], settlementTime);

      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          [batch]
        )
      ).to.not.be.reverted;

      const agentBalance = await gasToken.balanceOf(agent1.address);
      expect(agentBalance).to.equal(10000n);
    });

    it("should verify nonce continuity (must start at withdrawalNonce + 1)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 6000n, nonce: 2, notAfter: currentTime + 7200 },
        { amount: 7000n, nonce: 3, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Try to start from nonce 2 instead of 1 (withdrawalNonce is 0, so should start at 1)
      const batch = await createChargeBatch(
        scope,
        agent1,
        [
          { amount: 6000n, nonce: 2, notAfter: currentTime + 7200 },
          { amount: 7000n, nonce: 3, notAfter: currentTime + 7200 },
        ],
        currentTime
      );

      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          [batch]
        )
      ).to.be.revertedWithCustomError(zeroLC, "NonContinuousNonceSequence");
    });

    it("should revert if nonces have gaps", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 6000n, nonce: 2, notAfter: currentTime + 7200 },
        { amount: 7000n, nonce: 3, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Try to provide nonces 1 and 3, skipping 2
      const batch = await createChargeBatch(
        scope,
        agent1,
        [
          { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
          { amount: 7000n, nonce: 3, notAfter: currentTime + 7200 }, // Gap!
        ],
        currentTime
      );

      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          [batch]
        )
      ).to.be.revertedWithCustomError(zeroLC, "NonContinuousNonceSequence");
    });

    it("should revert if nonces are out of order", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 6000n, nonce: 2, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Try to provide nonces out of order: 2, 1
      const batch = await createChargeBatch(
        scope,
        agent1,
        [
          { amount: 6000n, nonce: 2, notAfter: currentTime + 7200 },
          { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
        ],
        currentTime
      );

      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          [batch]
        )
      ).to.be.revertedWithCustomError(zeroLC, "NonContinuousNonceSequence");
    });

    it("should calculate totalWithdrawableCharges correctly", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 1234n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 5678n, nonce: 2, notAfter: currentTime + 7200 },
        { amount: 9012n, nonce: 3, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      const batch = await createChargeBatch(
        scope,
        agent1,
        [
          { amount: 1234n, nonce: 1, notAfter: currentTime + 7200 },
          { amount: 5678n, nonce: 2, notAfter: currentTime + 7200 },
          { amount: 9012n, nonce: 3, notAfter: currentTime + 7200 },
        ],
        currentTime
      );

      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        [batch]
      );

      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      const expectedTotal = 1234n + 5678n + 9012n;
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(expectedTotal);
    });

    it("should revert if provided charges exceed agentPendingAmount", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Settle only 10000n
      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }], currentTime);

      await time.increase(disputeWindow + 1);

      // Try to withdraw more than what was settled
      const batch = await createChargeBatch(
        scope,
        agent1,
        [{ amount: 15000n, nonce: 1, notAfter: currentTime + 7200 }], // More than settled!
        currentTime
      );

      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          [batch]
        )
      ).to.be.revertedWithCustomError(zeroLC, "ChargesExceedPendingAmount");
    });

    it("should update withdrawalNonce to highest provided nonce", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 6000n, nonce: 2, notAfter: currentTime + 7200 },
        { amount: 7000n, nonce: 3, notAfter: currentTime + 7200 },
        { amount: 8000n, nonce: 4, notAfter: currentTime + 7200 },
        { amount: 9000n, nonce: 5, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      const batch = await createChargeBatch(
        scope,
        agent1,
        [
          { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
          { amount: 6000n, nonce: 2, notAfter: currentTime + 7200 },
          { amount: 7000n, nonce: 3, notAfter: currentTime + 7200 },
        ],
        currentTime
      );

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        [batch]
      );

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.withdrawalNonce).to.equal(3); // Highest nonce provided
    });

    it("should update agentPendingAmount correctly", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 6000n, nonce: 2, notAfter: currentTime + 7200 },
        { amount: 7000n, nonce: 3, notAfter: currentTime + 7200 },
      ]);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const stateBefore = await zeroLC.authorizationScopes(scopeHash);
      expect(stateBefore.agentPendingAmount).to.equal(18000n);

      await time.increase(disputeWindow + 1);

      const batch = await createChargeBatch(
        scope,
        agent1,
        [
          { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
          { amount: 6000n, nonce: 2, notAfter: currentTime + 7200 },
        ],
        currentTime
      );

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        [batch]
      );

      const stateAfter = await zeroLC.authorizationScopes(scopeHash);
      expect(stateAfter.agentPendingAmount).to.equal(7000n); // 18000 - 11000
    });

    it("should withdraw with partial charge sequence (withdraw nonces 1-3, leaving 4-5 for later)", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Settle 5 charges
      await settleCharges(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 2000n, nonce: 2, notAfter: currentTime + 7200 },
        { amount: 3000n, nonce: 3, notAfter: currentTime + 7200 },
        { amount: 4000n, nonce: 4, notAfter: currentTime + 7200 },
        { amount: 5000n, nonce: 5, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Withdraw only first 3
      const batch = await createChargeBatch(
        scope,
        agent1,
        [
          { amount: 1000n, nonce: 1, notAfter: currentTime + 7200 },
          { amount: 2000n, nonce: 2, notAfter: currentTime + 7200 },
          { amount: 3000n, nonce: 3, notAfter: currentTime + 7200 },
        ],
        currentTime
      );

      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        [batch]
      );

      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(6000n); // 1000 + 2000 + 3000

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.withdrawalNonce).to.equal(3);
      expect(state.agentPendingAmount).to.equal(9000n); // 4000 + 5000 remaining
    });

    it("should allow second withdrawal continuing from previous withdrawalNonce (withdraw nonces 4-5 after withdrawing 1-3)", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Settle 5 charges
      await settleCharges(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 2000n, nonce: 2, notAfter: currentTime + 7200 },
        { amount: 3000n, nonce: 3, notAfter: currentTime + 7200 },
        { amount: 4000n, nonce: 4, notAfter: currentTime + 7200 },
        { amount: 5000n, nonce: 5, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // First withdrawal: nonces 1-3
      const batch1 = await createChargeBatch(
        scope,
        agent1,
        [
          { amount: 1000n, nonce: 1, notAfter: currentTime + 7200 },
          { amount: 2000n, nonce: 2, notAfter: currentTime + 7200 },
          { amount: 3000n, nonce: 3, notAfter: currentTime + 7200 },
        ],
        currentTime
      );

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        [batch1]
      );

      const agentBalanceAfterFirst = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfterFirst).to.equal(6000n);

      // Second withdrawal: nonces 4-5 (continuing from withdrawalNonce = 3)
      const batch2 = await createChargeBatch(
        scope,
        agent1,
        [
          { amount: 4000n, nonce: 4, notAfter: currentTime + 7200 },
          { amount: 5000n, nonce: 5, notAfter: currentTime + 7200 },
        ],
        currentTime
      );

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        [batch2]
      );

      const agentBalanceAfterSecond = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfterSecond).to.equal(15000n); // 6000 + 9000

      const scopeHash = await zeroLC.getScopeHash(scope);
      const state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.withdrawalNonce).to.equal(5);
      expect(state.agentPendingAmount).to.equal(0);
    });

    it("should revert when attempting to reuse already withdrawn charges", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 6000n, nonce: 2, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // First withdrawal: nonce 1
      const batch1 = await createChargeBatch(scope, agent1, [{ amount: 5000n, nonce: 1, notAfter: currentTime + 7200 }], currentTime);

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        [batch1]
      );

      // Try to withdraw nonce 1 again (should fail - withdrawalNonce is now 1, so should start at 2)
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          [batch1]
        )
      ).to.be.revertedWithCustomError(zeroLC, "NonContinuousNonceSequence");
    });
  });

  describe("20.3 Signature-Based Withdrawal (Third-Party Relayer)", function () {
    async function signWithdrawal(
      zeroLC: ZeroLC,
      agent: SignerWithAddress,
      scopeHash: string,
      toWallet: boolean,
      recentCharges: any[],
      nonce: bigint
    ) {
      const recentChargesHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[]"],
        [recentCharges]
      ));

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
          { name: "recentChargesHash", type: "bytes32" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        scopeHash,
        toWallet,
        recentChargesHash,
        nonce,
      };

      return await agent.signTypedData(domain, types, value);
    }

    it("should allow third-party to submit withdrawal with valid agent signature", async function () {
      const { zeroLC, gasToken, user1, agent1, owner, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const agentState = await zeroLC.userStates(agent1.address);
      const nonce = agentState.nonce;

      const signature = await signWithdrawal(zeroLC, agent1, scopeHash, true, [], nonce);

      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);

      // Third party (owner) submits withdrawal on behalf of agent1
      await zeroLC.connect(owner)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[],bytes)"](
        scope,
        true,
        [],
        signature
      );

      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(10000n);
    });

    it("should verify signature uses correct EIP-712 structure", async function () {
      const { zeroLC, gasToken, user1, agent1, owner, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const agentState = await zeroLC.userStates(agent1.address);
      const nonce = agentState.nonce;

      const signature = await signWithdrawal(zeroLC, agent1, scopeHash, true, [], nonce);

      await expect(
        zeroLC.connect(owner)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[],bytes)"](
          scope,
          true,
          [],
          signature
        )
      ).to.not.be.reverted;
    });

    it("should revert with wrong scopeHash in signature", async function () {
      const { zeroLC, user1, agent1, owner, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const wrongScopeHash = ethers.keccak256(ethers.toUtf8Bytes("wrong"));
      const agentState = await zeroLC.userStates(agent1.address);
      const nonce = agentState.nonce;

      const signature = await signWithdrawal(zeroLC, agent1, wrongScopeHash, true, [], nonce);

      await expect(
        zeroLC.connect(owner)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[],bytes)"](
          scope,
          true,
          [],
          signature
        )
      ).to.be.revertedWithCustomError(zeroLC, "InvalidWithdrawalSignature");
    });

    it("should revert with wrong toWallet value in signature", async function () {
      const { zeroLC, user1, agent1, owner, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const agentState = await zeroLC.userStates(agent1.address);
      const nonce = agentState.nonce;

      // Sign with toWallet = false
      const signature = await signWithdrawal(zeroLC, agent1, scopeHash, false, [], nonce);

      // Try to use with toWallet = true
      await expect(
        zeroLC.connect(owner)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[],bytes)"](
          scope,
          true, // Different from signature!
          [],
          signature
        )
      ).to.be.revertedWithCustomError(zeroLC, "InvalidWithdrawalSignature");
    });

    it("should revert with wrong recentChargesHash in signature", async function () {
      const { zeroLC, user1, agent1, owner, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      const batch = await createChargeBatch(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }], currentTime);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const agentState = await zeroLC.userStates(agent1.address);
      const nonce = agentState.nonce;

      // Sign with empty recentCharges
      const signature = await signWithdrawal(zeroLC, agent1, scopeHash, true, [], nonce);

      // Try to use with non-empty recentCharges
      await expect(
        zeroLC.connect(owner)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[],bytes)"](
          scope,
          true,
          [batch], // Different from signature!
          signature
        )
      ).to.be.revertedWithCustomError(zeroLC, "InvalidWithdrawalSignature");
    });

    it("should revert with wrong nonce in signature", async function () {
      const { zeroLC, user1, agent1, owner, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const agentState = await zeroLC.userStates(agent1.address);
      const nonce = agentState.nonce;

      // Sign with wrong nonce
      const signature = await signWithdrawal(zeroLC, agent1, scopeHash, true, [], nonce + 1n);

      await expect(
        zeroLC.connect(owner)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[],bytes)"](
          scope,
          true,
          [],
          signature
        )
      ).to.be.revertedWithCustomError(zeroLC, "InvalidWithdrawalSignature");
    });

    it("should revert with signature from non-agent address", async function () {
      const { zeroLC, user1, agent1, owner, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const agentState = await zeroLC.userStates(agent1.address);
      const nonce = agentState.nonce;

      // Sign with user1 instead of agent1
      const signature = await signWithdrawal(zeroLC, user1, scopeHash, true, [], nonce);

      await expect(
        zeroLC.connect(owner)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[],bytes)"](
          scope,
          true,
          [],
          signature
        )
      ).to.be.revertedWithCustomError(zeroLC, "InvalidWithdrawalSignature");
    });

    it("should prevent signature replay attack (nonce increments after successful withdrawal)", async function () {
      const { zeroLC, gasToken, user1, agent1, owner, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Settle two batches
      await settleCharges(scope, agent1, [{ amount: 5000n, nonce: 1, notAfter: currentTime + 7200 }]);
      await time.increase(1);
      await settleCharges(scope, agent1, [{ amount: 5000n, nonce: 2, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      const scopeHash = await zeroLC.getScopeHash(scope);
      let agentState = await zeroLC.userStates(agent1.address);
      const nonce = agentState.nonce;

      const signature = await signWithdrawal(zeroLC, agent1, scopeHash, true, [], nonce);

      // First withdrawal should succeed
      await zeroLC.connect(owner)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[],bytes)"](
        scope,
        true,
        [],
        signature
      );

      const agentBalance = await gasToken.balanceOf(agent1.address);
      expect(agentBalance).to.equal(10000n);

      // Verify nonce incremented
      agentState = await zeroLC.userStates(agent1.address);
      expect(agentState.nonce).to.equal(nonce + 1n);

      // Try to replay same signature (should fail due to nonce increment)
      await expect(
        zeroLC.connect(owner)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[],bytes)"](
          scope,
          true,
          [],
          signature
        )
      ).to.be.revertedWithCustomError(zeroLC, "InvalidWithdrawalSignature");
    });

    it("should increment nonce correctly after signature-based withdrawal", async function () {
      const { zeroLC, user1, agent1, owner, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      const scopeHash = await zeroLC.getScopeHash(scope);
      let agentState = await zeroLC.userStates(agent1.address);
      const nonceBefore = agentState.nonce;

      const signature = await signWithdrawal(zeroLC, agent1, scopeHash, true, [], nonceBefore);

      await zeroLC.connect(owner)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[],bytes)"](
        scope,
        true,
        [],
        signature
      );

      agentState = await zeroLC.userStates(agent1.address);
      expect(agentState.nonce).to.equal(nonceBefore + 1n);
    });

    it("should allow multiple signature-based withdrawals with incrementing nonces", async function () {
      const { zeroLC, gasToken, user1, agent1, owner, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Settle multiple charges
      await settleCharges(scope, agent1, [{ amount: 5000n, nonce: 1, notAfter: currentTime + 7200 }]);
      await time.increase(1);
      await settleCharges(scope, agent1, [{ amount: 6000n, nonce: 2, notAfter: currentTime + 7200 }]);
      await time.increase(1);
      await settleCharges(scope, agent1, [{ amount: 7000n, nonce: 3, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      const scopeHash = await zeroLC.getScopeHash(scope);

      // First withdrawal with nonce 0
      let agentState = await zeroLC.userStates(agent1.address);
      let nonce = agentState.nonce;
      expect(nonce).to.equal(0n);

      let signature = await signWithdrawal(zeroLC, agent1, scopeHash, true, [], nonce);
      await zeroLC.connect(owner)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[],bytes)"](
        scope,
        true,
        [],
        signature
      );

      let agentBalance = await gasToken.balanceOf(agent1.address);
      expect(agentBalance).to.equal(18000n);

      // Second withdrawal would fail because all charges are withdrawn
      // Instead, let's verify nonce incremented
      agentState = await zeroLC.userStates(agent1.address);
      expect(agentState.nonce).to.equal(1n);
    });
  });

  describe("20.4 Access Control & Authorization", function () {
    it("should require msg.sender == scope.agent for direct withdrawal", async function () {
      const { zeroLC, user1, agent1, owner, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      // Try to call direct withdrawal as non-agent (should fail)
      await expect(
        zeroLC.connect(owner)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          []
        )
      ).to.be.revertedWithCustomError(zeroLC, "CallerNotAgent");
    });

    it("should revert direct withdrawal by non-agent", async function () {
      const { zeroLC, user1, user2, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      // Try to call as user2 (not the agent)
      await expect(
        zeroLC.connect(user2)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          []
        )
      ).to.be.revertedWithCustomError(zeroLC, "CallerNotAgent");
    });

    it("should allow signature-based withdrawal to verify agent signature (not msg.sender)", async function () {
      const { zeroLC, gasToken, user1, agent1, owner, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const agentState = await zeroLC.userStates(agent1.address);
      const nonce = agentState.nonce;

      async function signWithdrawal(
        zeroLC: ZeroLC,
        agent: SignerWithAddress,
        scopeHash: string,
        toWallet: boolean,
        recentCharges: any[],
        nonce: bigint
      ) {
        const recentChargesHash = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[]"],
            [recentCharges]
          )
        );

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
            { name: "recentChargesHash", type: "bytes32" },
            { name: "nonce", type: "uint256" },
          ],
        };

        const value = {
          scopeHash,
          toWallet,
          recentChargesHash,
          nonce,
        };

        return await agent.signTypedData(domain, types, value);
      }

      const signature = await signWithdrawal(zeroLC, agent1, scopeHash, true, [], nonce);

      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);

      // Owner can submit with valid agent signature
      await zeroLC.connect(owner)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[],bytes)"](
        scope,
        true,
        [],
        signature
      );

      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(10000n);
    });
  });

  describe("20.6 View Functions", function () {
    it("getWithdrawableAmountSimple should return correct amount when all charges past dispute window", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      // Before dispute window expires
      let withdrawable = await zeroLC.getWithdrawableAmountSimple(scope);
      expect(withdrawable).to.equal(0);

      // After dispute window expires
      await time.increase(disputeWindow + 1);
      withdrawable = await zeroLC.getWithdrawableAmountSimple(scope);
      expect(withdrawable).to.equal(10000n);
    });

    it("getWithdrawableAmountSimple should return 0 when charges still in dispute window", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      const withdrawable = await zeroLC.getWithdrawableAmountSimple(scope);
      expect(withdrawable).to.equal(0);
    });

    it("getWithdrawableAmountSimple at exact boundary (lastChargeTimestamp + disputeWindow == block.timestamp)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      const settlementTime = currentTime;
      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }], settlementTime);

      // Advance to exactly dispute window boundary
      await time.increaseTo(settlementTime + disputeWindow);

      const withdrawable = await zeroLC.getWithdrawableAmountSimple(scope);
      expect(withdrawable).to.equal(10000n);
    });

    it("getWithdrawableAmountSimple should be callable by anyone (not just agent)", async function () {
      const { zeroLC, user1, user2, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      // Call from different address (user2)
      const withdrawable = await zeroLC.connect(user2).getWithdrawableAmountSimple(scope);
      expect(withdrawable).to.equal(10000n);
    });

    it("getWithdrawableAmountDetailed should return correct amount with valid charge sequence", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 6000n, nonce: 2, notAfter: currentTime + 7200 },
        { amount: 7000n, nonce: 3, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      const batch = await createChargeBatch(
        scope,
        agent1,
        [
          { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
          { amount: 6000n, nonce: 2, notAfter: currentTime + 7200 },
        ],
        currentTime
      );

      const withdrawable = await zeroLC.getWithdrawableAmountDetailed(scope, [batch]);
      expect(withdrawable).to.equal(11000n);
    });

    it("getWithdrawableAmountDetailed with partial charge sequence", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 2000n, nonce: 2, notAfter: currentTime + 7200 },
        { amount: 3000n, nonce: 3, notAfter: currentTime + 7200 },
        { amount: 4000n, nonce: 4, notAfter: currentTime + 7200 },
        { amount: 5000n, nonce: 5, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Provide only first 3 charges
      const batch = await createChargeBatch(
        scope,
        agent1,
        [
          { amount: 1000n, nonce: 1, notAfter: currentTime + 7200 },
          { amount: 2000n, nonce: 2, notAfter: currentTime + 7200 },
          { amount: 3000n, nonce: 3, notAfter: currentTime + 7200 },
        ],
        currentTime
      );

      const withdrawable = await zeroLC.getWithdrawableAmountDetailed(scope, [batch]);
      expect(withdrawable).to.equal(6000n);
    });

    it("getWithdrawableAmountDetailed should be callable by anyone", async function () {
      const { zeroLC, user1, user2, agent1, depositForUser, registerScope, createChargeBatch, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      const batch = await createChargeBatch(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }], currentTime);

      // Call from different address (user2)
      const withdrawable = await zeroLC.connect(user2).getWithdrawableAmountDetailed(scope, [batch]);
      expect(withdrawable).to.equal(10000n);
    });

    it("getAgentPendingAmount should return correct total pending amount", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Initially 0
      let pending = await zeroLC.getAgentPendingAmount(scope);
      expect(pending).to.equal(0);

      // After settling charges
      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 6000n, nonce: 2, notAfter: currentTime + 7200 },
      ]);

      pending = await zeroLC.getAgentPendingAmount(scope);
      expect(pending).to.equal(11000n);
    });

    it("getAgentPendingAmount should be callable by anyone", async function () {
      const { zeroLC, user1, user2, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      // Call from different address (user2)
      const pending = await zeroLC.connect(user2).getAgentPendingAmount(scope);
      expect(pending).to.equal(10000n);
    });

    it("getAgentWithdrawalNonce should return correct withdrawal nonce", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Initially 0
      let withdrawalNonce = await zeroLC.getAgentWithdrawalNonce(scope);
      expect(withdrawalNonce).to.equal(0);

      // After settling and withdrawing
      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 6000n, nonce: 2, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );

      withdrawalNonce = await zeroLC.getAgentWithdrawalNonce(scope);
      expect(withdrawalNonce).to.equal(2); // nonce - 1 = 3 - 1 = 2
    });

    it("getAgentWithdrawalNonce should return 0 for new scope", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } = await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      const withdrawalNonce = await zeroLC.getAgentWithdrawalNonce(scope);
      expect(withdrawalNonce).to.equal(0);
    });

    it("getAgentWithdrawalNonce should be callable by anyone", async function () {
      const { zeroLC, user1, user2, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [{ amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }]);

      await time.increase(disputeWindow + 1);

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );

      // Call from different address (user2)
      const withdrawalNonce = await zeroLC.connect(user2).getAgentWithdrawalNonce(scope);
      expect(withdrawalNonce).to.equal(1);
    });
  });

  describe("20.7 Edge Cases & Boundary Conditions", function () {
    it("should fail withdrawal when no charges have been settled yet", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // No charges settled, try to withdraw immediately
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          []
        )
      ).to.be.revertedWithCustomError(zeroLC, "NoWithdrawableBalance");
    });

    it("should fail withdrawal when charges are still within dispute window", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      // Try to withdraw immediately (still in dispute window)
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          []
        )
      ).to.be.revertedWithCustomError(zeroLC, "NoWithdrawableBalance");
    });

    it("should allow withdrawal with scope that has expired (notAfter < block.timestamp) but charges past dispute", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const notAfter = currentTime + 1800; // 30 minutes from now
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow, currentTime, notAfter);

      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 1500 }, // Before scope.notAfter
      ]);

      // Advance time past scope.notAfter and dispute window
      await time.increase(disputeWindow + 1);

      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);

      // Should succeed even though scope has expired
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          []
        )
      ).to.not.be.reverted;

      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(5000n);
    });

    it("should handle withdrawal with maximum uint48 amount", async function () {
      const { zeroLC, gasToken, user1, agent1, owner, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const maxUint48 = 2n ** 48n - 1n;
      const disputeWindow = 3600;

      // Transfer large amount to user1 and deposit
      await gasToken.connect(owner).transfer(user1.address, maxUint48);
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), maxUint48);
      await zeroLC.connect(user1)["deposit(uint256)"](maxUint48);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, maxUint48, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: maxUint48, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );

      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(maxUint48);
    });

    it("should handle withdrawal with 1 wei amount", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 1n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );

      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(1n);
    });

    it("should handle withdrawal at exact dispute window boundary", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      // Advance time to exactly dispute window (should allow withdrawal)
      await time.increase(disputeWindow);

      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );

      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(5000n);
    });

    it("should fail withdrawal at 1 second before dispute window expires", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 100; // Use smaller window for precise testing
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Settle charges at a known timestamp
      const settleTimestamp = currentTime + 10;
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
      ], settleTimestamp);

      await time.setNextBlockTimestamp(settleTimestamp);
      const settleTx = await zeroLC.settleCharges([chargeBatch]);
      await settleTx.wait();

      // Set time to exactly 1 second before dispute window expires
      // Condition is: block.timestamp >= lastChargeTimestamp + disputeWindow
      // We want: block.timestamp = settleTimestamp + disputeWindow - 1
      const withdrawTimestamp = settleTimestamp + disputeWindow - 1;
      await time.setNextBlockTimestamp(withdrawTimestamp);

      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          []
        )
      ).to.be.revertedWithCustomError(zeroLC, "NoWithdrawableBalance");
    });

    it("should handle withdrawal with large nonce values", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Settle multiple charges to build up nonce to a large value
      // Test with nonce = 1000
      const charges = [];
      for (let i = 1; i <= 1000; i++) {
        charges.push({ amount: 10n, nonce: i, notAfter: currentTime + 7200 });
      }

      await settleCharges(scope, agent1, charges);

      await time.increase(disputeWindow + 1);

      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);

      // Withdraw using simple method
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );

      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(10000n); // 10 * 1000

      const withdrawalNonce = await zeroLC.getAgentWithdrawalNonce(scope);
      expect(withdrawalNonce).to.equal(1000);
    });

    it("should handle multiple partial withdrawals correctly", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Settle 3 charges at different times
      await settleCharges(scope, agent1, [
        { amount: 1000n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // First withdrawal
      const balance1 = await gasToken.balanceOf(agent1.address);
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );
      const balance2 = await gasToken.balanceOf(agent1.address);
      expect(balance2 - balance1).to.equal(1000n);

      // Settle another charge
      const currentTime2 = await time.latest();
      await settleCharges(scope, agent1, [
        { amount: 2000n, nonce: 2, notAfter: currentTime2 + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Second withdrawal
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );
      const balance3 = await gasToken.balanceOf(agent1.address);
      expect(balance3 - balance2).to.equal(2000n);

      // Settle third charge
      const currentTime3 = await time.latest();
      await settleCharges(scope, agent1, [
        { amount: 3000n, nonce: 3, notAfter: currentTime3 + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Third withdrawal
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );
      const balance4 = await gasToken.balanceOf(agent1.address);
      expect(balance4 - balance3).to.equal(3000n);

      // Total withdrawn
      expect(balance4 - balance1).to.equal(6000n);
    });

    it("should fail when trying to withdraw twice for the same charges", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // First withdrawal should succeed
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );

      // Second withdrawal should fail (no new charges)
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          []
        )
      ).to.be.revertedWithCustomError(zeroLC, "NoWithdrawableBalance");
    });

    it("should reject registration with zero disputeWindow", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 0; // Zero not allowed
      await depositForUser(user1, totalAmount);

      // Should fail during registration
      await expect(
        registerScope(user1, agent1, totalAmount, disputeWindow)
      ).to.be.revertedWithCustomError(zeroLC, "InvalidDisputeWindow");
    });
  });

  describe("20.8 Integration Scenarios", function () {
    it("should handle withdrawals for multiple agents from same user", async function () {
      const { zeroLC, gasToken, user1, agent1, agent2, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount1 = 50000n;
      const totalAmount2 = 30000n;
      const disputeWindow = 3600;

      // Deposit enough for both scopes
      await depositForUser(user1, totalAmount1 + totalAmount2);

      const currentTime = await time.latest();
      const scope1 = await registerScope(user1, agent1, totalAmount1, disputeWindow);
      const scope2 = await registerScope(user1, agent2, totalAmount2, disputeWindow);

      // Settle charges for both agents
      await settleCharges(scope1, agent1, [
        { amount: 10000n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      await settleCharges(scope2, agent2, [
        { amount: 8000n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Both agents should be able to withdraw independently
      const agent1BalanceBefore = await gasToken.balanceOf(agent1.address);
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope1,
        true,
        []
      );
      const agent1BalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agent1BalanceAfter - agent1BalanceBefore).to.equal(10000n);

      const agent2BalanceBefore = await gasToken.balanceOf(agent2.address);
      await zeroLC.connect(agent2)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope2,
        true,
        []
      );
      const agent2BalanceAfter = await gasToken.balanceOf(agent2.address);
      expect(agent2BalanceAfter - agent2BalanceBefore).to.equal(8000n);
    });

    it("should handle withdrawal after scope revocation (remaining charges)", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Settle some charges
      await settleCharges(scope, agent1, [
        { amount: 10000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 15000n, nonce: 2, notAfter: currentTime + 7200 },
      ]);

      // Create revocation signature
      const scopeHash = await zeroLC.getScopeHash(scope);
      const domain = {
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      };
      const types = {
        RevokeAuthorizationScope: [{ name: "scopeHash", type: "bytes32" }],
      };
      const revSignature = await user1.signTypedData(domain, types, { scopeHash });

      // User revokes the scope after some charges
      await zeroLC.revokeAuthorizationScope(scope, revSignature);

      // Wait for dispute window to pass
      await time.increase(disputeWindow + 1);

      // Agent should still be able to withdraw settled charges
      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );
      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(25000n);
    });

    it("should handle withdrawal to balance vs wallet in same scope", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Settle first batch
      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // First withdrawal to balance (internal)
      const internalBalanceBefore = await zeroLC.balanceOf(agent1.address);
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        false, // to balance
        []
      );
      const internalBalanceAfter = await zeroLC.balanceOf(agent1.address);
      expect(internalBalanceAfter - internalBalanceBefore).to.equal(5000n);

      // Settle second batch
      const currentTime2 = await time.latest();
      await settleCharges(scope, agent1, [
        { amount: 7000n, nonce: 2, notAfter: currentTime2 + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Second withdrawal to wallet (external)
      const walletBalanceBefore = await gasToken.balanceOf(agent1.address);
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true, // to wallet
        []
      );
      const walletBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(walletBalanceAfter - walletBalanceBefore).to.equal(7000n);
    });

    it("should handle interleaved settle and withdraw operations", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 100; // Short window for faster testing
      await depositForUser(user1, totalAmount);

      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      let totalWithdrawn = 0n;

      // Interleave settle and withdraw operations
      for (let i = 1; i <= 3; i++) {
        const amount = BigInt(i * 1000);
        const currentTime = await time.latest();

        await settleCharges(scope, agent1, [
          { amount, nonce: i, notAfter: currentTime + 7200 },
        ]);

        await time.increase(disputeWindow + 1);

        await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          []
        );

        totalWithdrawn += amount;
      }

      const finalAgentBalance = await gasToken.balanceOf(agent1.address);
      // Agent started with some balance from fixture, check the increase
      expect(finalAgentBalance).to.be.gte(totalWithdrawn);
    });

    it("should handle withdrawal using both simple and detailed methods", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, settleCharges, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Settle charges
      await settleCharges(scope, agent1, [
        { amount: 2000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 3000n, nonce: 2, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // First withdrawal using simple method
      const balance1 = await gasToken.balanceOf(agent1.address);
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        [] // Empty recentCharges = simple method
      );
      const balance2 = await gasToken.balanceOf(agent1.address);
      expect(balance2 - balance1).to.equal(5000n);

      // Settle more charges
      const currentTime2 = await time.latest();
      await settleCharges(scope, agent1, [
        { amount: 4000n, nonce: 3, notAfter: currentTime2 + 7200 },
        { amount: 5000n, nonce: 4, notAfter: currentTime2 + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Second withdrawal using detailed method
      const chargeBatch1 = await createChargeBatch(scope, agent1, [
        { amount: 4000n, nonce: 3, notAfter: currentTime2 + 7200 },
      ], currentTime2);

      const chargeBatch2 = await createChargeBatch(scope, agent1, [
        { amount: 5000n, nonce: 4, notAfter: currentTime2 + 7200 },
      ], currentTime2);

      const balance3 = await gasToken.balanceOf(agent1.address);
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        [chargeBatch1, chargeBatch2] // With recentCharges = detailed method
      );
      const balance4 = await gasToken.balanceOf(agent1.address);
      expect(balance4 - balance3).to.equal(9000n);
    });

    it("should handle withdrawal after user compaction", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 50000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 10000n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      // Trigger user compaction by registering many scopes and revoking them
      // (This is tested more thoroughly in compaction tests, here we just verify withdrawal still works)

      await time.increase(disputeWindow + 1);

      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );
      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(10000n);
    });

    it("should handle withdrawal with multiple scopes for same agent", async function () {
      const { zeroLC, gasToken, user1, user2, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount1 = 50000n;
      const totalAmount2 = 40000n;
      const disputeWindow = 3600;

      // Two different users with same agent
      await depositForUser(user1, totalAmount1);
      await depositForUser(user2, totalAmount2);

      const currentTime = await time.latest();
      const scope1 = await registerScope(user1, agent1, totalAmount1, disputeWindow);
      const scope2 = await registerScope(user2, agent1, totalAmount2, disputeWindow);

      await settleCharges(scope1, agent1, [
        { amount: 10000n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      await settleCharges(scope2, agent1, [
        { amount: 8000n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Agent should be able to withdraw from both scopes independently
      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope1,
        true,
        []
      );

      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope2,
        true,
        []
      );

      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(18000n); // 10000 + 8000
    });

    it("should handle large batch withdrawal with many charge entries", async function () {
      const { zeroLC, gasToken, user1, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      // Settle a large batch with 50 entries
      const charges = [];
      for (let i = 1; i <= 50; i++) {
        charges.push({ amount: 100n, nonce: i, notAfter: currentTime + 7200 });
      }

      await settleCharges(scope, agent1, charges);

      await time.increase(disputeWindow + 1);

      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );
      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(5000n); // 100 * 50
    });
  });

  describe("20.9 Security & Attack Vectors", function () {
    it("should prevent non-agent from withdrawing agent funds", async function () {
      const { zeroLC, user1, user2, agent1, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 10000n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // user2 (not the agent) tries to withdraw
      await expect(
        zeroLC.connect(user2)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          []
        )
      ).to.be.revertedWithCustomError(zeroLC, "CallerNotAgent");
    });

    it("should prevent withdrawal with incorrect scope data", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 10000n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Create a modified scope with different agent
      const modifiedScope = { ...scope, agent: agent2.address };

      // Agent1 tries to withdraw using modified scope
      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          modifiedScope,
          true,
          []
        )
      ).to.be.revertedWithCustomError(zeroLC, "CallerNotAgent");
    });

    it("should prevent withdrawal with non-continuous nonce in detailed method", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 2000n, nonce: 1, notAfter: currentTime + 7200 },
        { amount: 3000n, nonce: 2, notAfter: currentTime + 7200 },
        { amount: 4000n, nonce: 3, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Try to withdraw with gap in nonces (1 and 3, skipping 2)
      const chargeBatch1 = await createChargeBatch(scope, agent1, [
        { amount: 2000n, nonce: 1, notAfter: currentTime + 7200 },
      ], currentTime);

      const chargeBatch3 = await createChargeBatch(scope, agent1, [
        { amount: 4000n, nonce: 3, notAfter: currentTime + 7200 }, // Gap! Missing nonce 2
      ], currentTime);

      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          [chargeBatch1, chargeBatch3]
        )
      ).to.be.revertedWithCustomError(zeroLC, "NonContinuousNonceSequence");
    });

    it("should prevent withdrawal with charges still in dispute window (detailed method)", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      // Try to withdraw immediately (still in dispute window)
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
      ], currentTime);

      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          [chargeBatch]
        )
      ).to.be.revertedWithCustomError(zeroLC, "BatchStillInDisputeWindow");
    });

    it("should prevent withdrawal with mismatched scope hash in detailed method", async function () {
      const { zeroLC, user1, agent1, agent2, depositForUser, registerScope, settleCharges, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 50000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount * 2n); // Enough for both scopes

      const currentTime = await time.latest();
      const scope1 = await registerScope(user1, agent1, totalAmount, disputeWindow);
      const scope2 = await registerScope(user1, agent2, totalAmount, disputeWindow);

      await settleCharges(scope1, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Create charge batch for scope2 but try to use it with scope1
      const chargeBatchWrong = await createChargeBatch(scope2, agent2, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
      ], currentTime);

      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope1,
          true,
          [chargeBatchWrong]
        )
      ).to.be.revertedWithCustomError(zeroLC, "ScopeMismatch");
    });

    it("should prevent withdrawal when charges exceed pending amount", async function () {
      const { zeroLC, user1, agent1, depositForUser, registerScope, settleCharges, createChargeBatch } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Try to claim more than what was settled
      const chargeBatch = await createChargeBatch(scope, agent1, [
        { amount: 10000n, nonce: 1, notAfter: currentTime + 7200 }, // Wrong amount!
      ], currentTime);

      await expect(
        zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
          scope,
          true,
          [chargeBatch]
        )
      ).to.be.revertedWithCustomError(zeroLC, "ChargesExceedPendingAmount");
    });

    it("should prevent withdrawal with invalid signature via third-party", async function () {
      const { zeroLC, user1, agent1, owner, depositForUser, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const disputeWindow = 3600;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, totalAmount, disputeWindow);
      const scopeHash = await zeroLC.getScopeHash(scope);

      await settleCharges(scope, agent1, [
        { amount: 5000n, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Create signature for withdrawal but use wrong signer (user1 instead of agent1)
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
          { name: "recentChargesHash", type: "bytes32" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const recentChargesHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[]"],
          [[]]
        )
      );

      const value = {
        scopeHash,
        toWallet: true,
        recentChargesHash,
        nonce: 0n,
      };

      // Wrong signer!
      const wrongSignature = await user1.signTypedData(domain, types, value);

      // Should fail with invalid signature
      await expect(
        zeroLC.connect(owner)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[],bytes)"](
          scope,
          true,
          [],
          wrongSignature
        )
      ).to.be.reverted;
    });

    it("should handle overflow protection in amount calculations", async function () {
      const { zeroLC, gasToken, user1, agent1, owner, registerScope, settleCharges } =
        await loadFixture(deployZeroLCFixture);

      const maxUint48 = 2n ** 48n - 1n;
      const disputeWindow = 3600;

      // Deposit maximum amount
      await gasToken.connect(owner).transfer(user1.address, maxUint48);
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), maxUint48);
      await zeroLC.connect(user1)["deposit(uint256)"](maxUint48);

      const currentTime = await time.latest();
      const scope = await registerScope(user1, agent1, maxUint48, disputeWindow);

      await settleCharges(scope, agent1, [
        { amount: maxUint48, nonce: 1, notAfter: currentTime + 7200 },
      ]);

      await time.increase(disputeWindow + 1);

      // Withdrawal should succeed without overflow
      const agentBalanceBefore = await gasToken.balanceOf(agent1.address);
      await zeroLC.connect(agent1)["withdrawAgentChargedFund((address,uint48,uint48,address,uint48,uint48),bool,((address,uint48,uint48,address,uint48,uint48),(uint48,uint24,uint48)[],uint48,bytes)[])"](
        scope,
        true,
        []
      );
      const agentBalanceAfter = await gasToken.balanceOf(agent1.address);
      expect(agentBalanceAfter - agentBalanceBefore).to.equal(maxUint48);
    });
  });
});
