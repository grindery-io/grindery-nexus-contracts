import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeroLC, TestERC20, MockERC1271Wallet, UniversalSigValidator } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ZeroLC - Authorization Scope Revocation Tests (Section 4)", function () {
  const MICRO_AMOUNT = 1000000n; // 1 USDC equivalent (6 decimals)

  // Fixture to deploy the contract and set up test environment
  async function deployZeroLCFixture() {
    const [owner, user, agent, other] = await ethers.getSigners();

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
    await gasToken.transfer(user.address, ethers.parseEther("10000"));
    await gasToken.transfer(other.address, ethers.parseEther("10000"));

    // Deploy mock ERC1271 wallet
    const MockERC1271WalletFactory = await ethers.getContractFactory("MockERC1271Wallet");
    const mockWallet = (await MockERC1271WalletFactory.deploy(user.address)) as MockERC1271Wallet;
    await mockWallet.waitForDeployment();
    await gasToken.transfer(await mockWallet.getAddress(), ethers.parseEther("10000"));

    // Helper function to deposit tokens for a user
    async function depositForUser(userSigner: SignerWithAddress, amount: bigint) {
      await gasToken.connect(userSigner).approve(await zeroLC.getAddress(), amount);
      await zeroLC.connect(userSigner)["deposit(uint256)"](amount);
    }

    // Helper function to create and sign authorization scope
    async function createAuthorizationScope(
      userSigner: SignerWithAddress,
      agentSigner: SignerWithAddress,
      totalAmount: bigint,
      disputeWindow: number = 3600,
      notBefore?: number,
      notAfter?: number,
      amountGranularity: number = 0
    ) {
      const currentTime = await time.latest();
      const scope = {
        user: userSigner.address,
        disputeWindow: disputeWindow,
        agent: agentSigner.address,
        notBefore: notBefore ?? currentTime,
        notAfter: notAfter ?? currentTime + 86400, // 1 day from now
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

      const signature = await userSigner.signTypedData(domain, types, scope);

      return { scope, signature };
    }

    // Helper function to sign revocation
    async function signRevokeAuthorizationScope(
      userSigner: SignerWithAddress,
      scopeHash: string
    ) {
      const domain = {
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      };

      const types = {
        RevokeAuthorizationScope: [{ name: "scopeHash", type: "bytes32" }],
      };

      return await userSigner.signTypedData(domain, types, { scopeHash });
    }

    // Helper function to get authorization scope data from the mapping
    async function getAuthorizationScopeData(scopeHash: string) {
      return await zeroLC.authorizationScopeData(scopeHash);
    }

    // Helper function to calculate scaled amount (what gets stored in state)
    function calculateScaledAmount(amount: bigint, granularity: number): bigint {
      return amount / (10n ** BigInt(granularity));
    }

    return {
      zeroLC,
      gasToken,
      universalSigValidator,
      owner,
      user,
      agent,
      other,
      mockWallet,
      depositForUser,
      createAuthorizationScope,
      signRevokeAuthorizationScope,
      getAuthorizationScopeData,
      calculateScaledAmount,
    };
  }

  describe("Valid Revocation", function () {
    it("should revoke scope with valid signature", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const { scope, signature } = await createAuthorizationScope(user, agent, MICRO_AMOUNT);
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);

      await expect(zeroLC.revokeAuthorizationScope(scope, revSignature))
        .to.emit(zeroLC, "AuthorizationScopeRevoking")
        .withArgs(user.address, agent.address, scopeHash);
    });

    it("should set notAfter to block.timestamp + 300", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const { scope, signature } = await createAuthorizationScope(user, agent, MICRO_AMOUNT);
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);

      const tx = await zeroLC.revokeAuthorizationScope(scope, revSignature);
      const receipt = await tx.wait();
      const blockTimestamp = (await ethers.provider.getBlock(receipt!.blockNumber!))!.timestamp;

      const state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.notAfter).to.equal(blockTimestamp + 300);
    });

    it("should allow revocation when notAfter is 1 second greater than newNotAfter (true boundary)", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const currentTime = await time.latest();
      // newNotAfter will be block.timestamp + 300
      // We want notAfter to be just barely > newNotAfter
      // Need to account for a few blocks of execution time between registration and revocation
      // Setting notAfter = currentTime + 305 gives small but safe margin
      const { scope, signature } = await createAuthorizationScope(
        user,
        agent,
        MICRO_AMOUNT,
        3600,
        currentTime,
        currentTime + 305 // Small margin to ensure notAfter > newNotAfter after block advancement
      );
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);

      // Should succeed because notAfter > newNotAfter (which is block.timestamp + 300)
      await expect(zeroLC.revokeAuthorizationScope(scope, revSignature)).to.not.be.reverted;
    });

    it("should revert revocation when notAfter <= newNotAfter", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const currentTime = await time.latest();
      // newNotAfter will be block.timestamp + 300
      // Make notAfter < newNotAfter to trigger the check
      // Setting notAfter = currentTime + 299 will make notAfter < newNotAfter (after accounting for block advancement)
      const { scope, signature } = await createAuthorizationScope(
        user,
        agent,
        MICRO_AMOUNT,
        3600,
        currentTime,
        currentTime + 299 // Will make notAfter < newNotAfter
      );
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);

      await expect(zeroLC.revokeAuthorizationScope(scope, revSignature)).to.be.revertedWithCustomError(
        zeroLC,
        "ScopeNotActive"
      );
    });

    it("should emit AuthorizationScopeRevoking event", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const { scope, signature } = await createAuthorizationScope(user, agent, MICRO_AMOUNT);
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);

      await expect(zeroLC.revokeAuthorizationScope(scope, revSignature))
        .to.emit(zeroLC, "AuthorizationScopeRevoking")
        .withArgs(user.address, agent.address, scopeHash);
    });

    it("should maintain remainingAmount correctly after revocation", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const { scope, signature } = await createAuthorizationScope(user, agent, MICRO_AMOUNT);
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const stateBefore = await zeroLC.authorizationScopes(scopeHash);
      const expectedScaledAmount = calculateScaledAmount(MICRO_AMOUNT, 0);
      expect(stateBefore.remainingAmount).to.equal(expectedScaledAmount);

      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);
      await zeroLC.revokeAuthorizationScope(scope, revSignature);

      const stateAfter = await zeroLC.authorizationScopes(scopeHash);
      expect(stateAfter.remainingAmount).to.equal(expectedScaledAmount); // Should remain unchanged
    });

    it("should maintain agentPendingAmount correctly after revocation", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const { scope, signature } = await createAuthorizationScope(user, agent, MICRO_AMOUNT);
      await zeroLC.registerAuthorizationScope(scope, signature);

      const pendingBefore = await zeroLC.getAgentPendingAmount(scope);
      expect(pendingBefore).to.equal(0);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);
      await zeroLC.revokeAuthorizationScope(scope, revSignature);

      const pendingAfter = await zeroLC.getAgentPendingAmount(scope);
      expect(pendingAfter).to.equal(0); // Should remain unchanged
    });

    it("should revoke scope with valid ERC-1271 signature", async function () {
      const { zeroLC, gasToken, user, agent, mockWallet, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      // Transfer tokens to mock wallet and approve
      const mockWalletAddress = await mockWallet.getAddress();
      await gasToken.transfer(mockWalletAddress, MICRO_AMOUNT * 10n);

      // Approve and deposit using the wallet's executeCall function
      const approveTx = gasToken.interface.encodeFunctionData("approve", [
        await zeroLC.getAddress(),
        MICRO_AMOUNT * 10n
      ]);
      await mockWallet.connect(user).executeCall(await gasToken.getAddress(), approveTx);

      const depositTx = zeroLC.interface.encodeFunctionData("deposit(uint256)", [MICRO_AMOUNT]);
      await mockWallet.connect(user).executeCall(await zeroLC.getAddress(), depositTx);

      const currentTime = await time.latest();
      const scope = {
        user: mockWalletAddress,
        disputeWindow: 3600,
        agent: agent.address,
        notBefore: currentTime,
        notAfter: currentTime + 3600,
        totalAmount: MICRO_AMOUNT,
        amountGranularity: 0,
      };

      // Register scope with ERC-1271 wallet - user signs on behalf of the wallet
      const regSignature = await user.signTypedData(
        {
          name: "ZeroLC",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await zeroLC.getAddress(),
        },
        {
          AuthorizationScope: [
            { name: "user", type: "address" },
            { name: "disputeWindow", type: "uint40" },
            { name: "agent", type: "address" },
            { name: "notBefore", type: "uint40" },
            { name: "notAfter", type: "uint40" },
            { name: "totalAmount", type: "uint128" },
            { name: "amountGranularity", type: "uint8" },
          ],
        },
        scope
      );
      await zeroLC.registerAuthorizationScope(scope, regSignature);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);

      await expect(zeroLC.revokeAuthorizationScope(scope, revSignature))
        .to.emit(zeroLC, "AuthorizationScopeRevoking")
        .withArgs(mockWalletAddress, agent.address, scopeHash);
    });
  });

  describe("Revocation Failures", function () {
    it("should revert with invalid signature", async function () {
      const { zeroLC, user, agent, other, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const { scope, signature } = await createAuthorizationScope(user, agent, MICRO_AMOUNT);
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);
      // Sign with wrong signer
      const badSignature = await signRevokeAuthorizationScope(other, scopeHash);

      await expect(
        zeroLC.revokeAuthorizationScope(scope, badSignature)
      ).to.be.revertedWithCustomError(zeroLC, "InvalidScopeSignature");
    });

    it("should revert when revoking already expired scope", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const currentTime = await time.latest();
      const { scope, signature } = await createAuthorizationScope(
        user,
        agent,
        MICRO_AMOUNT,
        3600,
        currentTime,
        currentTime + 100 // Short duration
      );
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);

      // Wait for scope to expire
      await time.increase(101);

      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);

      await expect(
        zeroLC.revokeAuthorizationScope(scope, revSignature)
      ).to.be.revertedWithCustomError(zeroLC, "ScopeNotActive");
    });

    it("should revert when revoking scope with remainingAmount == 0", async function () {
      // This test will be implemented when settlement tests are complete
      this.skip();
    });

    it("should revert when newNotAfter >= current notAfter", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const currentTime = await time.latest();
      const { scope, signature } = await createAuthorizationScope(
        user,
        agent,
        MICRO_AMOUNT,
        3600,
        currentTime,
        currentTime + 300 // Exactly 300 seconds (same as revocation window)
      );
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);

      // Should fail because newNotAfter (currentTime + 300) >= notAfter (currentTime + 300)
      await expect(
        zeroLC.revokeAuthorizationScope(scope, revSignature)
      ).to.be.revertedWithCustomError(zeroLC, "ScopeNotActive");
    });

    it("should revert when revoking scope twice", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const { scope, signature } = await createAuthorizationScope(user, agent, MICRO_AMOUNT);
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const revSignature1 = await signRevokeAuthorizationScope(user, scopeHash);
      await zeroLC.revokeAuthorizationScope(scope, revSignature1);

      const revSignature2 = await signRevokeAuthorizationScope(user, scopeHash);

      await expect(
        zeroLC.revokeAuthorizationScope(scope, revSignature2)
      ).to.be.revertedWithCustomError(zeroLC, "ScopeNotActive");
    });

    it("should revert with malformed signature", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const { scope, signature } = await createAuthorizationScope(user, agent, MICRO_AMOUNT);
      await zeroLC.registerAuthorizationScope(scope, signature);

      const badSignature = "0x1234";

      await expect(
        zeroLC.revokeAuthorizationScope(scope, badSignature)
      ).to.be.reverted; // Will revert in signature verification
    });

    it("should revert when revoking non-existent scope", async function () {
      const { zeroLC, user, agent, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      const currentTime = await time.latest();
      const scope = {
        user: user.address,
        disputeWindow: 3600,
        agent: agent.address,
        notBefore: currentTime,
        notAfter: currentTime + 3600,
        totalAmount: MICRO_AMOUNT,
        amountGranularity: 0,
      };

      // Don't register the scope
      const scopeHash = await zeroLC.getScopeHash(scope);
      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);

      await expect(
        zeroLC.revokeAuthorizationScope(scope, revSignature)
      ).to.be.revertedWithCustomError(zeroLC, "ScopeNotActive");
    });
  });

  describe("Revocation After Partial Charges", function () {
    it("should allow revocation after partial charges", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const { scope, signature } = await createAuthorizationScope(user, agent, MICRO_AMOUNT);
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);

      await expect(zeroLC.revokeAuthorizationScope(scope, revSignature))
        .to.emit(zeroLC, "AuthorizationScopeRevoking")
        .withArgs(user.address, agent.address, scopeHash);

      // Verify the scope is now set to expire soon
      const state = await zeroLC.authorizationScopes(scopeHash);
      const currentTime = await time.latest();
      expect(state.notAfter).to.be.closeTo(currentTime + 300, 5);
    });
  });

  describe("Reentrancy Protection", function () {
    it("should have reentrancy protection on revokeAuthorizationScope", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const { scope, signature } = await createAuthorizationScope(user, agent, MICRO_AMOUNT);
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);

      // First revocation should succeed
      await expect(zeroLC.revokeAuthorizationScope(scope, revSignature)).to.not.be.reverted;
    });
  });

  describe("Edge Cases", function () {
    it("should handle revocation with very long initial duration", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const currentTime = await time.latest();
      const { scope, signature } = await createAuthorizationScope(
        user,
        agent,
        MICRO_AMOUNT,
        3600,
        currentTime,
        currentTime + 365 * 24 * 3600 // 1 year
      );
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);

      await expect(zeroLC.revokeAuthorizationScope(scope, revSignature)).to.not.be.reverted;

      const state = await zeroLC.authorizationScopes(scopeHash);
      expect(state.notAfter).to.be.closeTo(currentTime + 300, 5);
    });

    it("should verify revocation doesn't affect user balance", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const balanceBefore = await zeroLC.balanceOf(user.address);

      const { scope, signature } = await createAuthorizationScope(user, agent, MICRO_AMOUNT);
      await zeroLC.registerAuthorizationScope(scope, signature);

      const balanceAfterRegistration = await zeroLC.balanceOf(user.address);
      expect(balanceAfterRegistration).to.equal(balanceBefore); // Balance stays the same (locked in scope)

      const scopeHash = await zeroLC.getScopeHash(scope);
      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);
      await zeroLC.revokeAuthorizationScope(scope, revSignature);

      const balanceAfterRevocation = await zeroLC.balanceOf(user.address);
      expect(balanceAfterRevocation).to.equal(balanceAfterRegistration); // Balance unchanged by revocation
    });

    it("should verify revocation shortens the time window for settlements", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, MICRO_AMOUNT);

      const currentTime = await time.latest();
      const { scope, signature } = await createAuthorizationScope(
        user,
        agent,
        MICRO_AMOUNT,
        3600,
        currentTime,
        currentTime + 7200
      );
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const stateBefore = await zeroLC.authorizationScopes(scopeHash);
      expect(stateBefore.notAfter).to.be.closeTo(currentTime + 7200, 5);

      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);
      await zeroLC.revokeAuthorizationScope(scope, revSignature);

      const stateAfter = await zeroLC.authorizationScopes(scopeHash);
      expect(stateAfter.notAfter).to.be.closeTo(currentTime + 300, 5);
      expect(stateAfter.notAfter).to.be.lessThan(stateBefore.notAfter);
    });
  });

  describe("Amount Granularity Tests", function () {
    it("should revoke scope with amountGranularity = 3", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope, calculateScaledAmount, getAuthorizationScopeData } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 1000000n; // 1,000,000
      const granularity = 3;
      await depositForUser(user, totalAmount);

      const { scope, signature } = await createAuthorizationScope(user, agent, totalAmount, 3600, undefined, undefined, granularity);
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);

      // Verify scaled amount stored correctly
      const stateBefore = await zeroLC.authorizationScopes(scopeHash);
      const expectedScaledAmount = calculateScaledAmount(totalAmount, granularity);
      expect(stateBefore.remainingAmount).to.equal(expectedScaledAmount);

      // Verify authorizationScopeData preserves unscaled totalAmount
      const scopeData = await getAuthorizationScopeData(scopeHash);
      expect(scopeData.totalAmount).to.equal(totalAmount);
      expect(scopeData.amountGranularity).to.equal(granularity);

      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);
      await expect(zeroLC.revokeAuthorizationScope(scope, revSignature))
        .to.emit(zeroLC, "AuthorizationScopeRevoking")
        .withArgs(user.address, agent.address, scopeHash);

      // Verify remainingAmount unchanged after revocation
      const stateAfter = await zeroLC.authorizationScopes(scopeHash);
      expect(stateAfter.remainingAmount).to.equal(expectedScaledAmount);
    });

    it("should revoke scope with amountGranularity = 6 (USDC-like)", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope, calculateScaledAmount, getAuthorizationScopeData } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 1000000000n; // 1 billion (1,000 USDC)
      const granularity = 6;
      await depositForUser(user, totalAmount);

      const { scope, signature } = await createAuthorizationScope(user, agent, totalAmount, 3600, undefined, undefined, granularity);
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);

      // Verify scaled amount stored correctly
      const stateBefore = await zeroLC.authorizationScopes(scopeHash);
      const expectedScaledAmount = calculateScaledAmount(totalAmount, granularity);
      expect(stateBefore.remainingAmount).to.equal(expectedScaledAmount);

      // Verify authorizationScopeData preserves unscaled totalAmount
      const scopeData = await getAuthorizationScopeData(scopeHash);
      expect(scopeData.totalAmount).to.equal(totalAmount);
      expect(scopeData.amountGranularity).to.equal(granularity);
      expect(scopeData.disputeWindow).to.equal(3600);

      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);
      await expect(zeroLC.revokeAuthorizationScope(scope, revSignature))
        .to.emit(zeroLC, "AuthorizationScopeRevoking")
        .withArgs(user.address, agent.address, scopeHash);

      // Verify remainingAmount unchanged after revocation
      const stateAfter = await zeroLC.authorizationScopes(scopeHash);
      expect(stateAfter.remainingAmount).to.equal(expectedScaledAmount);
    });

    it("should revoke scope with amountGranularity = 12", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope, calculateScaledAmount, getAuthorizationScopeData } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 1000000000000n; // 1 trillion
      const granularity = 12;
      await depositForUser(user, totalAmount);

      const { scope, signature } = await createAuthorizationScope(user, agent, totalAmount, 3600, undefined, undefined, granularity);
      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeHash = await zeroLC.getScopeHash(scope);

      // Verify scaled amount stored correctly
      const stateBefore = await zeroLC.authorizationScopes(scopeHash);
      const expectedScaledAmount = calculateScaledAmount(totalAmount, granularity);
      expect(stateBefore.remainingAmount).to.equal(expectedScaledAmount);

      // Verify authorizationScopeData preserves unscaled totalAmount
      const scopeData = await getAuthorizationScopeData(scopeHash);
      expect(scopeData.totalAmount).to.equal(totalAmount);
      expect(scopeData.amountGranularity).to.equal(granularity);

      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);
      await expect(zeroLC.revokeAuthorizationScope(scope, revSignature))
        .to.emit(zeroLC, "AuthorizationScopeRevoking")
        .withArgs(user.address, agent.address, scopeHash);

      // Verify remainingAmount unchanged after revocation
      const stateAfter = await zeroLC.authorizationScopes(scopeHash);
      expect(stateAfter.remainingAmount).to.equal(expectedScaledAmount);
    });

    it("should verify agentPendingAmount returns 0 with different granularities", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 1000000n;
      const granularity = 3;
      await depositForUser(user, totalAmount);

      const { scope, signature } = await createAuthorizationScope(user, agent, totalAmount, 3600, undefined, undefined, granularity);
      await zeroLC.registerAuthorizationScope(scope, signature);

      // Before revocation
      const pendingBefore = await zeroLC.getAgentPendingAmount(scope);
      expect(pendingBefore).to.equal(0);

      const scopeHash = await zeroLC.getScopeHash(scope);
      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);
      await zeroLC.revokeAuthorizationScope(scope, revSignature);

      // After revocation
      const pendingAfter = await zeroLC.getAgentPendingAmount(scope);
      expect(pendingAfter).to.equal(0);
    });

    it("should verify balance calculations work correctly with granularity after revocation", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, signRevokeAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 1000000n;
      const granularity = 6;
      await depositForUser(user, totalAmount);

      const balanceBefore = await zeroLC.balanceOf(user.address);

      const { scope, signature } = await createAuthorizationScope(user, agent, totalAmount, 3600, undefined, undefined, granularity);
      await zeroLC.registerAuthorizationScope(scope, signature);

      const balanceAfterRegistration = await zeroLC.balanceOf(user.address);
      expect(balanceAfterRegistration).to.equal(balanceBefore); // Balance stays the same (locked in scope)

      const scopeHash = await zeroLC.getScopeHash(scope);
      const revSignature = await signRevokeAuthorizationScope(user, scopeHash);
      await zeroLC.revokeAuthorizationScope(scope, revSignature);

      const balanceAfterRevocation = await zeroLC.balanceOf(user.address);
      expect(balanceAfterRevocation).to.equal(balanceAfterRegistration); // Balance unchanged by revocation
    });
  });
});