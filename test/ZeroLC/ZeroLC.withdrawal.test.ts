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
});
