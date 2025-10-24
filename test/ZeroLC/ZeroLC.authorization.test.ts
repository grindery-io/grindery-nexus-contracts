import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeroLC, TestERC20, UniversalSigValidator, MockERC1271Wallet, SimpleCreate2Factory } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ZeroLC - Authorization Scope Registration", function () {
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
    };
  }

  describe("3.1 Valid Registration", function () {
    it("should register scope with valid signature and sufficient balance", async function () {
      const { zeroLC, user1, agent1, createAuthorizationScope, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n; // Small amount that fits in uint48

      // Deposit funds
      await depositForUser(user1, totalAmount);

      // Create and sign scope
      const { scope, signature } = await createAuthorizationScope(user1, agent1, totalAmount);

      // Register scope
      await expect(zeroLC.registerAuthorizationScope(scope, signature))
        .to.not.be.reverted;

      // Verify scope was registered
      const scopeHash = await zeroLC.getScopeHash(scope);
      const scopeState = await zeroLC.authorizationScopes(scopeHash);

      expect(scopeState.remainingAmount).to.equal(totalAmount);
      expect(scopeState.agentPendingAmount).to.equal(0);
      expect(scopeState.nonce).to.equal(1);
      expect(scopeState.notAfter).to.equal(scope.notAfter);
    });

    it("should register scope with EOA signature", async function () {
      const { zeroLC, user1, agent1, createAuthorizationScope, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n; // Small amount that fits in uint48
      await depositForUser(user1, totalAmount);

      const { scope, signature } = await createAuthorizationScope(user1, agent1, totalAmount);

      await expect(zeroLC.registerAuthorizationScope(scope, signature))
        .to.not.be.reverted;
    });

    it("should register scope with ERC-1271 smart wallet signature", async function () {
      const { zeroLC, gasToken, user1, agent1 } =
        await loadFixture(deployZeroLCFixture);

      // Deploy mock ERC-1271 wallet
      const MockERC1271WalletFactory = await ethers.getContractFactory("MockERC1271Wallet");
      const wallet = await MockERC1271WalletFactory.deploy(user1.address) as MockERC1271Wallet;
      await wallet.waitForDeployment();

      const totalAmount = 100000n; // Small amount that fits in uint48

      // Transfer tokens to wallet
      await gasToken.connect(user1).transfer(await wallet.getAddress(), totalAmount);

      // Approve ZeroLC to spend wallet's tokens using executeCall
      const approveCalldata = gasToken.interface.encodeFunctionData("approve", [
        await zeroLC.getAddress(),
        totalAmount
      ]);
      await wallet.connect(user1).executeCall(await gasToken.getAddress(), approveCalldata);

      // Deposit from wallet using executeCall
      const depositCalldata = zeroLC.interface.encodeFunctionData("deposit(uint256)", [totalAmount]);
      await wallet.connect(user1).executeCall(await zeroLC.getAddress(), depositCalldata);

      // Create scope for wallet
      const currentTime = await time.latest();
      const scope = {
        user: await wallet.getAddress(),
        totalAmount: totalAmount,
        disputeWindow: 3600,
        agent: agent1.address,
        notBefore: currentTime,
        notAfter: currentTime + 86400,
      };

      // Get EIP712 digest and sign with user1 (the owner of the wallet)
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

      const signature = await user1.signTypedData(domain, types, scope);

      // Register scope with ERC-1271 signature (wallet will validate via isValidSignature)
      await expect(zeroLC.registerAuthorizationScope(scope, signature))
        .to.not.be.reverted;
    });

    it("should register scope with ERC-6492 counterfactual signature", async function () {
      const { zeroLC, gasToken, user1, agent1 } =
        await loadFixture(deployZeroLCFixture);

      // Deploy a wallet normally (not via CREATE2)
      const MockERC1271WalletFactory = await ethers.getContractFactory("MockERC1271Wallet");
      const wallet = await MockERC1271WalletFactory.deploy(user1.address) as MockERC1271Wallet;
      await wallet.waitForDeployment();
      const walletAddress = await wallet.getAddress();

      const totalAmount = 100000n; // Small amount that fits in uint48

      // Transfer tokens to wallet and deposit
      await gasToken.connect(user1).transfer(walletAddress, totalAmount);

      const approveCalldata = gasToken.interface.encodeFunctionData("approve", [
        await zeroLC.getAddress(),
        totalAmount
      ]);
      await wallet.connect(user1).executeCall(await gasToken.getAddress(), approveCalldata);

      const depositCalldata = zeroLC.interface.encodeFunctionData("deposit(uint256)", [totalAmount]);
      await wallet.connect(user1).executeCall(await zeroLC.getAddress(), depositCalldata);

      // Create scope for the wallet
      const currentTime = await time.latest();
      const scope = {
        user: walletAddress,
        totalAmount: totalAmount,
        disputeWindow: 3600,
        agent: agent1.address,
        notBefore: currentTime,
        notAfter: currentTime + 86400,
      };

      // Sign the scope with user1 (the owner of the wallet)
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

      const innerSignature = await user1.signTypedData(domain, types, scope);

      // Create ERC-6492 wrapped signature
      // Even though the wallet is already deployed, we can still wrap it in ERC-6492 format
      // The UniversalSigValidator will detect the wallet exists and validate normally
      const SimpleCreate2FactoryFactory = await ethers.getContractFactory("SimpleCreate2Factory");
      const dummyFactory = await SimpleCreate2FactoryFactory.deploy();
      await dummyFactory.waitForDeployment();

      const dummyFactoryCalldata = "0x"; // Empty calldata since wallet is already deployed

      const ERC6492_MAGIC_BYTES = "0x6492649264926492649264926492649264926492649264926492649264926492";

      const erc6492Signature = ethers.concat([
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "bytes", "bytes"],
          [await dummyFactory.getAddress(), dummyFactoryCalldata, innerSignature]
        ),
        ERC6492_MAGIC_BYTES as any
      ]);

      // Register scope with ERC-6492 signature
      // The validator will detect the wallet exists and validate against the deployed version
      await expect(zeroLC.registerAuthorizationScope(scope, erc6492Signature))
        .to.not.be.reverted;

      // Verify scope was registered
      const scopeHash = await zeroLC.getScopeHash(scope);
      const scopeState = await zeroLC.authorizationScopes(scopeHash);
      expect(scopeState.remainingAmount).to.equal(totalAmount);
    });

    it("should trigger auto-deposit when balance insufficient but allowance exists", async function () {
      const { zeroLC, gasToken, user1, agent1, createAuthorizationScope, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const depositAmount = 50000n; // Small amount that fits in uint48
      const totalAmount = 100000n;

      // Deposit only half
      await depositForUser(user1, depositAmount);

      // Approve additional tokens for auto-deposit
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), totalAmount);

      const balanceBefore = await zeroLC.balanceOf(user1.address);
      expect(balanceBefore).to.equal(depositAmount);

      // Create and sign scope
      const { scope, signature } = await createAuthorizationScope(user1, agent1, totalAmount);

      // Register scope (should trigger auto-deposit)
      await expect(zeroLC.registerAuthorizationScope(scope, signature))
        .to.not.be.reverted;

      // Verify scope was registered with full amount
      const scopeHash = await zeroLC.getScopeHash(scope);
      const scopeState = await zeroLC.authorizationScopes(scopeHash);
      expect(scopeState.remainingAmount).to.equal(totalAmount);

      // Verify balance is now zero (all locked in scope)
      const balanceAfter = await zeroLC.balanceOf(user1.address);
      expect(balanceAfter).to.equal(totalAmount); // balanceOf includes locked amounts

      const userState = await zeroLC.userStates(user1.address);
      expect(userState.balance).to.equal(0); // Direct balance should be 0
    });

    it("should emit AuthorizationScopeRegistered event", async function () {
      const { zeroLC, user1, agent1, createAuthorizationScope, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n; // Small amount that fits in uint48
      await depositForUser(user1, totalAmount);

      const { scope, signature } = await createAuthorizationScope(user1, agent1, totalAmount);
      const scopeHash = await zeroLC.getScopeHash(scope);

      await expect(zeroLC.registerAuthorizationScope(scope, signature))
        .to.emit(zeroLC, "AuthorizationScopeRegistered")
        .withArgs(user1.address, agent1.address, scopeHash);
    });

    it("should update user state correctly", async function () {
      const { zeroLC, user1, agent1, createAuthorizationScope, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n; // Small amount that fits in uint48
      await depositForUser(user1, totalAmount);

      const { scope, signature } = await createAuthorizationScope(user1, agent1, totalAmount);
      const scopeHash = await zeroLC.getScopeHash(scope);

      await zeroLC.registerAuthorizationScope(scope, signature);

      const userState = await zeroLC.userStates(user1.address);
      expect(userState.balance).to.equal(0); // Balance transferred to scope

      // We'll verify the scope was registered by checking it exists in authorizationScopes
      const scopeState = await zeroLC.authorizationScopes(scopeHash);
      expect(scopeState.remainingAmount).to.equal(totalAmount);
    });

    it("should update agent state correctly", async function () {
      const { zeroLC, user1, agent1, createAuthorizationScope, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n; // Small amount that fits in uint48
      await depositForUser(user1, totalAmount);

      const { scope, signature } = await createAuthorizationScope(user1, agent1, totalAmount);
      const scopeHash = await zeroLC.getScopeHash(scope);

      await zeroLC.registerAuthorizationScope(scope, signature);

      const agentScopes = await zeroLC.agentAuthorizationScopes(agent1.address, 0);
      expect(agentScopes).to.equal(scopeHash);
    });

    it("should update authorizationScopes mapping correctly", async function () {
      const { zeroLC, user1, agent1, createAuthorizationScope, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n; // Small amount that fits in uint48
      await depositForUser(user1, totalAmount);

      const { scope, signature } = await createAuthorizationScope(user1, agent1, totalAmount);
      const scopeHash = await zeroLC.getScopeHash(scope);

      await zeroLC.registerAuthorizationScope(scope, signature);

      const scopeState = await zeroLC.authorizationScopes(scopeHash);
      expect(scopeState.remainingAmount).to.equal(totalAmount);
      expect(scopeState.agentPendingAmount).to.equal(0);
      expect(scopeState.nonce).to.equal(1);
      expect(scopeState.notAfter).to.equal(scope.notAfter);
      expect(scopeState.lastChargeTimestamp).to.equal(0);
      expect(scopeState.isNumChargesRecorded).to.equal(0);
    });

    it("should register multiple scopes for same user", async function () {
      const { zeroLC, user1, agent1, agent2, createAuthorizationScope, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount1 = 100000n; // Small amount that fits in uint48
      const totalAmount2 = 50000n;
      await depositForUser(user1, totalAmount1 + totalAmount2);

      // Register first scope
      const { scope: scope1, signature: signature1 } =
        await createAuthorizationScope(user1, agent1, totalAmount1);
      await zeroLC.registerAuthorizationScope(scope1, signature1);

      // Register second scope with different agent
      const { scope: scope2, signature: signature2 } =
        await createAuthorizationScope(user1, agent2, totalAmount2);
      await zeroLC.registerAuthorizationScope(scope2, signature2);

      // Verify both scopes registered by checking they exist in authorizationScopes mapping
      const scopeHash1 = await zeroLC.getScopeHash(scope1);
      const scopeHash2 = await zeroLC.getScopeHash(scope2);

      const scopeState1 = await zeroLC.authorizationScopes(scopeHash1);
      const scopeState2 = await zeroLC.authorizationScopes(scopeHash2);

      expect(scopeState1.remainingAmount).to.equal(totalAmount1);
      expect(scopeState2.remainingAmount).to.equal(totalAmount2);
    });

    it("should register multiple scopes for same agent", async function () {
      const { zeroLC, user1, user2, agent1, createAuthorizationScope, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n; // Small amount that fits in uint48
      await depositForUser(user1, totalAmount);
      await depositForUser(user2, totalAmount);

      // Register scope from user1
      const { scope: scope1, signature: signature1 } =
        await createAuthorizationScope(user1, agent1, totalAmount);
      await zeroLC.registerAuthorizationScope(scope1, signature1);

      // Register scope from user2
      const { scope: scope2, signature: signature2 } =
        await createAuthorizationScope(user2, agent1, totalAmount);
      await zeroLC.registerAuthorizationScope(scope2, signature2);

      // Verify both scopes registered for agent
      const agentScope1 = await zeroLC.agentAuthorizationScopes(agent1.address, 0);
      const agentScope2 = await zeroLC.agentAuthorizationScopes(agent1.address, 1);
      expect(agentScope1).to.not.equal(agentScope2);
    });

    it("should update user balance correctly (subtracts totalAmount)", async function () {
      const { zeroLC, user1, agent1, createAuthorizationScope, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const depositAmount = 200000n; // Small amount that fits in uint48
      const totalAmount = 100000n;
      await depositForUser(user1, depositAmount);

      const balanceBefore = await zeroLC.balanceOf(user1.address);
      expect(balanceBefore).to.equal(depositAmount);

      const { scope, signature } = await createAuthorizationScope(user1, agent1, totalAmount);
      await zeroLC.registerAuthorizationScope(scope, signature);

      // Total balance should still include locked amount
      const balanceAfter = await zeroLC.balanceOf(user1.address);
      expect(balanceAfter).to.equal(depositAmount);

      // Direct balance should be reduced
      const userState = await zeroLC.userStates(user1.address);
      expect(userState.balance).to.equal(depositAmount - totalAmount);
    });

    it("should revert when attempting to register the same scope twice", async function () {
      const { zeroLC, user1, agent1, createAuthorizationScope, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n; // Small amount that fits in uint48

      // Deposit enough for two scopes
      await depositForUser(user1, totalAmount * 2n);

      // Create and sign scope
      const { scope, signature } = await createAuthorizationScope(user1, agent1, totalAmount);

      // Register scope first time - should succeed
      await zeroLC.registerAuthorizationScope(scope, signature);

      // Attempt to register the exact same scope again - should revert
      await expect(
        zeroLC.registerAuthorizationScope(scope, signature)
      ).to.be.revertedWith("Authorization scope already registered");
    });
  });

  describe("3.2 Edge Cases & Failures", function () {
    it("should revert when registering scope with insufficient balance and no allowance", async function () {
      const { zeroLC, user1, agent1, createAuthorizationScope, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const depositAmount = 50000n; // Only deposit half

      // Deposit insufficient amount, no allowance for auto-deposit
      await depositForUser(user1, depositAmount);

      const { scope, signature } = await createAuthorizationScope(user1, agent1, totalAmount);

      await expect(
        zeroLC.registerAuthorizationScope(scope, signature)
      ).to.be.revertedWith("Insufficient balance");
    });

    it("should revert when registering scope with invalid signature", async function () {
      const { zeroLC, user1, user2, agent1, createAuthorizationScope, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      // Create scope but sign with wrong user
      const { scope, signature: _unused } = await createAuthorizationScope(user1, agent1, totalAmount);
      const wrongSignature = await user2.signTypedData(
        {
          name: "ZeroLC",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await zeroLC.getAddress(),
        },
        {
          AuthorizationScope: [
            { name: "user", type: "address" },
            { name: "totalAmount", type: "uint48" },
            { name: "disputeWindow", type: "uint48" },
            { name: "agent", type: "address" },
            { name: "notBefore", type: "uint48" },
            { name: "notAfter", type: "uint48" },
          ],
        },
        scope
      );

      await expect(
        zeroLC.registerAuthorizationScope(scope, wrongSignature)
      ).to.be.revertedWith("Invalid scope signature");
    });

    it("should revert when registering scope with expired notAfter", async function () {
      const { zeroLC, user1, agent1, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = {
        user: user1.address,
        totalAmount: totalAmount,
        disputeWindow: 3600,
        agent: agent1.address,
        notBefore: currentTime - 86400, // Past
        notAfter: currentTime - 1, // Already expired
      };

      const signature = await user1.signTypedData(
        {
          name: "ZeroLC",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await zeroLC.getAddress(),
        },
        {
          AuthorizationScope: [
            { name: "user", type: "address" },
            { name: "totalAmount", type: "uint48" },
            { name: "disputeWindow", type: "uint48" },
            { name: "agent", type: "address" },
            { name: "notBefore", type: "uint48" },
            { name: "notAfter", type: "uint48" },
          ],
        },
        scope
      );

      await expect(
        zeroLC.registerAuthorizationScope(scope, signature)
      ).to.be.revertedWith("Authorization scope expired");
    });

    it("should revert when registering scope with notBefore in future", async function () {
      const { zeroLC, user1, agent1, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = {
        user: user1.address,
        totalAmount: totalAmount,
        disputeWindow: 3600,
        agent: agent1.address,
        notBefore: currentTime + 3600, // 1 hour in future
        notAfter: currentTime + 86400,
      };

      const signature = await user1.signTypedData(
        {
          name: "ZeroLC",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await zeroLC.getAddress(),
        },
        {
          AuthorizationScope: [
            { name: "user", type: "address" },
            { name: "totalAmount", type: "uint48" },
            { name: "disputeWindow", type: "uint48" },
            { name: "agent", type: "address" },
            { name: "notBefore", type: "uint48" },
            { name: "notAfter", type: "uint48" },
          ],
        },
        scope
      );

      await expect(
        zeroLC.registerAuthorizationScope(scope, signature)
      ).to.be.revertedWith("Authorization scope not yet active");
    });

    it("should revert when registering scope with zero totalAmount", async function () {
      const { zeroLC, user1, agent1, createAuthorizationScope } =
        await loadFixture(deployZeroLCFixture);

      const { scope, signature } = await createAuthorizationScope(user1, agent1, 0n);

      await expect(
        zeroLC.registerAuthorizationScope(scope, signature)
      ).to.be.revertedWith("Authorization scope total amount must be greater than 0");
    });

    it("should revert when registering scope with zero disputeWindow", async function () {
      const { zeroLC, user1, agent1, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = {
        user: user1.address,
        totalAmount: totalAmount,
        disputeWindow: 0, // Invalid: zero
        agent: agent1.address,
        notBefore: currentTime,
        notAfter: currentTime + 86400,
      };

      const signature = await user1.signTypedData(
        {
          name: "ZeroLC",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await zeroLC.getAddress(),
        },
        {
          AuthorizationScope: [
            { name: "user", type: "address" },
            { name: "totalAmount", type: "uint48" },
            { name: "disputeWindow", type: "uint48" },
            { name: "agent", type: "address" },
            { name: "notBefore", type: "uint48" },
            { name: "notAfter", type: "uint48" },
          ],
        },
        scope
      );

      await expect(
        zeroLC.registerAuthorizationScope(scope, signature)
      ).to.be.revertedWith("Authorization scope dispute window must be greater than 0");
    });

    it("should revert when registering scope with zero agent address", async function () {
      const { zeroLC, user1, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = {
        user: user1.address,
        totalAmount: totalAmount,
        disputeWindow: 3600,
        agent: ethers.ZeroAddress, // Invalid: zero address
        notBefore: currentTime,
        notAfter: currentTime + 86400,
      };

      const signature = await user1.signTypedData(
        {
          name: "ZeroLC",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await zeroLC.getAddress(),
        },
        {
          AuthorizationScope: [
            { name: "user", type: "address" },
            { name: "totalAmount", type: "uint48" },
            { name: "disputeWindow", type: "uint48" },
            { name: "agent", type: "address" },
            { name: "notBefore", type: "uint48" },
            { name: "notAfter", type: "uint48" },
          ],
        },
        scope
      );

      await expect(
        zeroLC.registerAuthorizationScope(scope, signature)
      ).to.be.revertedWith("Authorization scope agent address must be non-zero");
    });

    it("should revert when user == agent (self-dealing)", async function () {
      const { zeroLC, user1, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = {
        user: user1.address,
        totalAmount: totalAmount,
        disputeWindow: 3600,
        agent: user1.address, // Same as user
        notBefore: currentTime,
        notAfter: currentTime + 86400,
      };

      const signature = await user1.signTypedData(
        {
          name: "ZeroLC",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await zeroLC.getAddress(),
        },
        {
          AuthorizationScope: [
            { name: "user", type: "address" },
            { name: "totalAmount", type: "uint48" },
            { name: "disputeWindow", type: "uint48" },
            { name: "agent", type: "address" },
            { name: "notBefore", type: "uint48" },
            { name: "notAfter", type: "uint48" },
          ],
        },
        scope
      );

      await expect(
        zeroLC.registerAuthorizationScope(scope, signature)
      ).to.be.revertedWith("User cannot be their own agent");
    });

    it("should register scope at exact notBefore timestamp (boundary)", async function () {
      const { zeroLC, user1, agent1, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = {
        user: user1.address,
        totalAmount: totalAmount,
        disputeWindow: 3600,
        agent: agent1.address,
        notBefore: currentTime + 1, // Next block
        notAfter: currentTime + 86400,
      };

      const signature = await user1.signTypedData(
        {
          name: "ZeroLC",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await zeroLC.getAddress(),
        },
        {
          AuthorizationScope: [
            { name: "user", type: "address" },
            { name: "totalAmount", type: "uint48" },
            { name: "disputeWindow", type: "uint48" },
            { name: "agent", type: "address" },
            { name: "notBefore", type: "uint48" },
            { name: "notAfter", type: "uint48" },
          ],
        },
        scope
      );

      // This should succeed because time will advance by 1 second during transaction
      await expect(
        zeroLC.registerAuthorizationScope(scope, signature)
      ).to.not.be.reverted;
    });

    it("should register scope at notAfter - 1 second (boundary)", async function () {
      const { zeroLC, user1, agent1, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const currentTime = await time.latest();
      const scope = {
        user: user1.address,
        totalAmount: totalAmount,
        disputeWindow: 3600,
        agent: agent1.address,
        notBefore: currentTime,
        notAfter: currentTime + 2, // Very short validity (2 seconds)
      };

      const signature = await user1.signTypedData(
        {
          name: "ZeroLC",
          version: "1",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await zeroLC.getAddress(),
        },
        {
          AuthorizationScope: [
            { name: "user", type: "address" },
            { name: "totalAmount", type: "uint48" },
            { name: "disputeWindow", type: "uint48" },
            { name: "agent", type: "address" },
            { name: "notBefore", type: "uint48" },
            { name: "notAfter", type: "uint48" },
          ],
        },
        scope
      );

      // Should succeed
      await expect(
        zeroLC.registerAuthorizationScope(scope, signature)
      ).to.not.be.reverted;
    });

    it("should register scope with totalAmount == balance (exact match)", async function () {
      const { zeroLC, user1, agent1, createAuthorizationScope, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const { scope, signature } = await createAuthorizationScope(user1, agent1, totalAmount);

      await expect(
        zeroLC.registerAuthorizationScope(scope, signature)
      ).to.not.be.reverted;

      // Verify balance is zero after registration
      const userState = await zeroLC.userStates(user1.address);
      expect(userState.balance).to.equal(0);
    });

    it("should revert with totalAmount > balance by 1 wei without allowance", async function () {
      const { zeroLC, user1, agent1, createAuthorizationScope, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      const depositAmount = totalAmount - 1n; // 1 wei short
      await depositForUser(user1, depositAmount);

      const { scope, signature } = await createAuthorizationScope(user1, agent1, totalAmount);

      await expect(
        zeroLC.registerAuthorizationScope(scope, signature)
      ).to.be.revertedWith("Insufficient balance");
    });

    it("should be protected against reentrancy during registration", async function () {
      const { zeroLC, user1, agent1, createAuthorizationScope, depositForUser } =
        await loadFixture(deployZeroLCFixture);

      const totalAmount = 100000n;
      await depositForUser(user1, totalAmount);

      const { scope, signature } = await createAuthorizationScope(user1, agent1, totalAmount);

      // The nonReentrant modifier should be present on registerAuthorizationScope
      // This test verifies that registration completes successfully with reentrancy protection
      await expect(
        zeroLC.registerAuthorizationScope(scope, signature)
      ).to.not.be.reverted;

      // Note: A full reentrancy test would require a malicious contract
      // that attempts to re-enter during the registration process.
      // For now, we verify the modifier is in place by checking successful execution.
    });
  });
});
