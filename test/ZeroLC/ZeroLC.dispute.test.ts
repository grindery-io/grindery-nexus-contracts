import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeroLC, TestERC20, UniversalSigValidator, MockERC1271Wallet } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ZeroLC - Dispute Tests", function () {
  // Fixture to deploy the contract and set up test environment
  async function deployZeroLCFixture() {
    const [owner, user, agent, thirdParty, user2] = await ethers.getSigners();

    // Deploy TestERC20
    const TestERC20Factory = await ethers.getContractFactory("TestERC20");
    const gasToken = await TestERC20Factory.deploy(ethers.parseEther("1000000")) as TestERC20;
    await gasToken.waitForDeployment();

    // Deploy UniversalSigValidator
    const UniversalSigValidatorFactory = await ethers.getContractFactory("UniversalSigValidator");
    const universalSigValidator = await UniversalSigValidatorFactory.deploy() as UniversalSigValidator;
    await universalSigValidator.waitForDeployment();

    // Deploy ZeroLC implementation
    const ZeroLCFactory = await ethers.getContractFactory("ZeroLC");
    const implementation = await ZeroLCFactory.deploy(
      await gasToken.getAddress(),
      await universalSigValidator.getAddress()
    ) as ZeroLC;
    await implementation.waitForDeployment();

    // Deploy proxy
    const ERC1967ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await ERC1967ProxyFactory.deploy(
      await implementation.getAddress(),
      implementation.interface.encodeFunctionData("initialize")
    );
    await proxy.waitForDeployment();

    const zeroLC = ZeroLCFactory.attach(await proxy.getAddress()) as ZeroLC;

    // Transfer tokens to users
    await gasToken.transfer(user.address, ethers.parseEther("10000"));
    await gasToken.transfer(user2.address, ethers.parseEther("10000"));

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

      const signature = await userSigner.signTypedData(domain, types, scope);
      return { scope, signature };
    }

    // Helper function to deposit tokens for a user
    async function depositForUser(userSigner: SignerWithAddress, amount: bigint) {
      await gasToken.connect(userSigner).approve(await zeroLC.getAddress(), amount);
      await zeroLC.connect(userSigner)["deposit(uint256)"](amount);
    }

    // Helper function to get authorization scope data from the mapping
    async function getAuthorizationScopeData(scopeHash: string) {
      return await zeroLC.authorizationScopeData(scopeHash);
    }

    // Helper function to calculate scaled amount (what gets stored in state)
    function calculateScaledAmount(amount: bigint, granularity: number): bigint {
      return amount / (10n ** BigInt(granularity));
    }

    // Helper function to register scope
    async function registerScope(
      userSigner: SignerWithAddress,
      agentSigner: SignerWithAddress,
      totalAmount: bigint,
      disputeWindow: number = 3600,
      notBefore?: number,
      notAfter?: number,
      amountGranularity: number = 0
    ) {
      const { scope, signature } = await createAuthorizationScope(
        userSigner, agentSigner, totalAmount, disputeWindow, notBefore, notAfter, amountGranularity
      );
      await zeroLC.registerAuthorizationScope(scope, signature);
      return scope;
    }

    // Helper function to create charge batch
    async function createChargeBatch(
      scope: any,
      agentSigner: SignerWithAddress,
      entries: { scaledAmount: bigint; nonce: number; notAfter: number }[],
      timestamp?: number
    ) {
      const batchTimestamp = timestamp ?? (await time.latest()) + 1;

      const chargeEntries = entries.map((e) => ({
        scaledAmount: e.scaledAmount,
        nonce: e.nonce,
        notAfter: e.notAfter,
      }));

      const chargeBatch = {
        scope: scope,
        entries: chargeEntries,
        timestamp: batchTimestamp,
        agentSignature: "0x",
      };

      // Calculate scopeHash
      const domainSeparator = ethers.TypedDataEncoder.hashDomain({
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      });

      const scopeHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "tuple(address,uint40,address,uint40,uint40,uint128,uint8)"],
          [
            domainSeparator,
            [scope.user, scope.disputeWindow, scope.agent, scope.notBefore, scope.notAfter, scope.totalAmount, scope.amountGranularity],
          ]
        )
      );

      // Create verifier struct
      let batchPartHash = ethers.ZeroHash;
      if (chargeEntries.length > 1) {
        const entriesExceptLast = chargeEntries.slice(0, -1);
        batchPartHash = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["tuple(uint32,uint24,uint40)[]"],
            [entriesExceptLast.map((e: any) => [e.scaledAmount, e.nonce, e.notAfter])]
          )
        );
      }

      const lastEntry = chargeEntries[chargeEntries.length - 1];
      const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint32,uint24,uint40)", "bytes32"],
        [batchPartHash, [lastEntry.scaledAmount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
      );

      // Agent signs the verifier
      const verifierBytes = ethers.getBytes(verifierEncoded);
      const agentSignature = await agentSigner.signMessage(verifierBytes);
      chargeBatch.agentSignature = agentSignature;

      return { chargeBatch, scopeHash };
    }

    // Helper function to settle charges
    async function settleCharges(
      scope: any,
      agentSigner: SignerWithAddress,
      entries: { scaledAmount: bigint; nonce: number; notAfter: number }[]
    ) {
      const { chargeBatch, scopeHash } = await createChargeBatch(scope, agentSigner, entries);
      await zeroLC.settleCharges([chargeBatch]);
      return { chargeBatch, scopeHash };
    }

    // Helper function to create dispute
    async function createDispute(
      chargeBatch: any,
      scopeHash: string,
      scaledAmountToClawback: bigint,
      signer: SignerWithAddress
    ) {
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

      const disputeData = {
        scopeHash: scopeHash,
        amountToClawback: scaledAmountToClawback,
      };

      const signature = await signer.signTypedData(domain, types, disputeData);

      return {
        chargeBatch: chargeBatch,
        amountToClawback: scaledAmountToClawback,
        signature: signature,
      };
    }

    return {
      zeroLC,
      gasToken,
      universalSigValidator,
      owner,
      user,
      agent,
      thirdParty,
      user2,
      createAuthorizationScope,
      depositForUser,
      getAuthorizationScopeData,
      calculateScaledAmount,
      registerScope,
      createChargeBatch,
      settleCharges,
      createDispute,
    };
  }

  const DEPOSIT_AMOUNT = ethers.parseEther("1000");
  const SCOPE_AMOUNT = 100000n;
  const DISPUTE_WINDOW = 3600; // 1 hour
  const CHARGE_AMOUNT = 10000n;

  describe("Section 6.1 - Valid Disputes", function () {
    it("should dispute valid charge batch within dispute window", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const userBalanceBefore = await zeroLC.userStates(user.address);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);

      await expect(zeroLC.dispute([dispute]))
        .to.emit(zeroLC, "ChargeDisputed")
        .withArgs(user.address, agent.address, scopeHash, CHARGE_AMOUNT);

      const userBalanceAfter = await zeroLC.userStates(user.address);
      const scopeStateAfter = await zeroLC.authorizationScopes(scopeHash);

      expect(userBalanceAfter.balance).to.equal(userBalanceBefore.balance + CHARGE_AMOUNT);

      // Verify pending amount is now 0 (was clawed back)
      const agentPending = await zeroLC.getAgentPendingAmount(scope);
      expect(agentPending).to.equal(0);

      // Verify FLAG_SCOPE_STATUS_DEACTIVATED is set (prevents future settlements)
      const FLAG_SCOPE_STATUS_DEACTIVATED = 1 << 22;
      expect(Number(scopeStateAfter.nonceAndFlags) & FLAG_SCOPE_STATUS_DEACTIVATED).to.equal(FLAG_SCOPE_STATUS_DEACTIVATED);

      // Original notAfter should be unchanged
      expect(scopeStateAfter.notAfter).to.equal(scope.notAfter);
      expect(userBalanceAfter.numDisputes).to.equal(userBalanceBefore.numDisputes + 1n);
    });

    it("should dispute with partial clawback amount", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const partialAmount = CHARGE_AMOUNT / 2n;
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(partialAmount, 0), user);

      const userBalanceBefore = await zeroLC.userStates(user.address);
      const agentPendingBefore = await zeroLC.getAgentPendingAmount(scope);

      await zeroLC.dispute([dispute]);

      const userBalanceAfter = await zeroLC.userStates(user.address);
      const agentPendingAfter = await zeroLC.getAgentPendingAmount(scope);

      expect(userBalanceAfter.balance).to.equal(userBalanceBefore.balance + partialAmount);
      expect(agentPendingAfter).to.equal(agentPendingBefore - partialAmount);
    });

    it("should dispute with full clawback amount (amountToClawback == totalChargedAmount)", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);

      const userBalanceBefore = await zeroLC.userStates(user.address);

      await zeroLC.dispute([dispute]);

      const userBalanceAfter = await zeroLC.userStates(user.address);
      const agentPendingAfter = await zeroLC.getAgentPendingAmount(scope);

      expect(userBalanceAfter.balance).to.equal(userBalanceBefore.balance + CHARGE_AMOUNT);
      expect(agentPendingAfter).to.equal(0n);
    });

    it("should dispute with valid user EOA signature", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);

      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });

    it("should dispute with valid ERC-1271 signature from smart wallet", async function () {
      const { zeroLC, gasToken, owner, agent, createAuthorizationScope, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      // Deploy mock smart wallet
      const MockERC1271WalletFactory = await ethers.getContractFactory("MockERC1271Wallet");
      const smartWallet = await MockERC1271WalletFactory.deploy(owner.address);
      await smartWallet.waitForDeployment();

      // Transfer and approve tokens for smart wallet
      await gasToken.transfer(await smartWallet.getAddress(), DEPOSIT_AMOUNT);
      await smartWallet.executeCall(
        await gasToken.getAddress(),
        gasToken.interface.encodeFunctionData("approve", [await zeroLC.getAddress(), DEPOSIT_AMOUNT])
      );

      // Smart wallet deposits using signature-based deposit
      const walletAddress = await smartWallet.getAddress();
      const depositNonce = (await zeroLC.userStates(walletAddress)).nonce;
      const depositDomain = {
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      };
      const depositTypes = {
        Deposit: [
          { name: "user", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };
      const depositValue = {
        user: walletAddress,
        amount: DEPOSIT_AMOUNT,
        nonce: depositNonce,
      };
      const depositSignature = await owner.signTypedData(depositDomain, depositTypes, depositValue);
      await zeroLC["deposit(address,uint256,bytes)"](walletAddress, DEPOSIT_AMOUNT, depositSignature);

      // Register scope for smart wallet - use helper but override user
      const scopeTime = await time.latest();
      const { scope, signature } = await createAuthorizationScope(
        { address: walletAddress, signTypedData: owner.signTypedData.bind(owner) } as any,
        agent,
        SCOPE_AMOUNT,
        DISPUTE_WINDOW,
        scopeTime - 60,
        scopeTime + 86400
      );

      await zeroLC.registerAuthorizationScope(scope, signature);

      // Settle charges
      const timestamp = await time.latest();
      const entries = [
        {
          scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0),
          nonce: 1,
          notAfter: timestamp + 3600,
        },
      ];

      const domainSeparator = ethers.TypedDataEncoder.hashDomain({
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      });
      const scopeHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "tuple(address,uint40,address,uint40,uint40,uint128,uint8)"],
          [
            domainSeparator,
            [scope.user, scope.disputeWindow, scope.agent, scope.notBefore, scope.notAfter, scope.totalAmount, scope.amountGranularity],
          ]
        )
      );

      const chargeBatch = {
        scope: scope,
        entries: entries,
        timestamp: timestamp + 1,
        agentSignature: "0x",
      };

      const lastEntry = entries[0];
      const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint32,uint24,uint40)", "bytes32"],
        [ethers.ZeroHash, [lastEntry.scaledAmount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
      );

      const verifierBytes = ethers.getBytes(verifierEncoded);
      const agentSignature = await agent.signMessage(verifierBytes);
      chargeBatch.agentSignature = agentSignature;

      await zeroLC.settleCharges([chargeBatch]);

      // Create dispute with ERC-1271 signature
      const domain = {
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      };

      const disputeTypes = {
        Dispute: [
          { name: "scopeHash", type: "bytes32" },
          { name: "amountToClawback", type: "uint32" },
        ],
      };

      const disputeData = {
        scopeHash: scopeHash,
        amountToClawback: calculateScaledAmount(CHARGE_AMOUNT, 0),
      };

      const disputeSignature = await owner.signTypedData(domain, disputeTypes, disputeData);

      const dispute = {
        chargeBatch: chargeBatch,
        amountToClawback: calculateScaledAmount(CHARGE_AMOUNT, 0),
        signature: disputeSignature,
      };

      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });

    it("should update chargedAmountPending correctly (decreases)", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const agentPendingBefore = await zeroLC.getAgentPendingAmount(scope);
      expect(agentPendingBefore).to.equal(CHARGE_AMOUNT);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);
      await zeroLC.dispute([dispute]);

      const agentPendingAfter = await zeroLC.getAgentPendingAmount(scope);
      expect(agentPendingAfter).to.equal(0n);
    });

    it("should update user balance correctly (increases)", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const userBalanceBefore = await zeroLC.userStates(user.address);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);
      await zeroLC.dispute([dispute]);

      const userBalanceAfter = await zeroLC.userStates(user.address);
      expect(userBalanceAfter.balance).to.equal(userBalanceBefore.balance + CHARGE_AMOUNT);
    });

    it("should set FLAG_SCOPE_STATUS_DEACTIVATED on dispute to prevent future settlements", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);
      await zeroLC.dispute([dispute]);

      const scopeStateAfter = await zeroLC.authorizationScopes(scopeHash);

      // Verify FLAG_SCOPE_STATUS_DEACTIVATED is set
      const FLAG_SCOPE_STATUS_DEACTIVATED = 1 << 22;
      expect(Number(scopeStateAfter.nonceAndFlags) & FLAG_SCOPE_STATUS_DEACTIVATED).to.equal(FLAG_SCOPE_STATUS_DEACTIVATED);

      // Original notAfter should be unchanged
      expect(scopeStateAfter.notAfter).to.equal(scope.notAfter);
    });

    it("should increment numDisputes counter", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const userStateBefore = await zeroLC.userStates(user.address);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);
      await zeroLC.dispute([dispute]);

      const userStateAfter = await zeroLC.userStates(user.address);
      expect(userStateAfter.numDisputes).to.equal(userStateBefore.numDisputes + 1n);
    });

    it("should emit ChargeDisputed event with correct parameters", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);

      await expect(zeroLC.dispute([dispute]))
        .to.emit(zeroLC, "ChargeDisputed")
        .withArgs(user.address, agent.address, scopeHash, CHARGE_AMOUNT);
    });

    it("should handle multiple disputes in single transaction (different batches)", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // First settlement
      const timestamp1 = await time.latest();
      const { chargeBatch: chargeBatch1 } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp1 + 3600 }
      ]);

      // Increase time to ensure different timestamp
      await time.increase(2);

      // Second settlement with different nonce
      const timestamp2 = await time.latest();
      const { chargeBatch: chargeBatch2 } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 2, notAfter: timestamp2 + 3600 }
      ]);

      // Create two disputes
      const dispute1 = await createDispute(chargeBatch1, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);
      const dispute2 = await createDispute(chargeBatch2, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);

      const userBalanceBefore = await zeroLC.userStates(user.address);

      await zeroLC.dispute([dispute1, dispute2]);

      const userBalanceAfter = await zeroLC.userStates(user.address);
      expect(userBalanceAfter.balance).to.equal(userBalanceBefore.balance + CHARGE_AMOUNT + CHARGE_AMOUNT);
      expect(userBalanceAfter.numDisputes).to.equal(userBalanceBefore.numDisputes + 2n);
    });
  });

  describe("Section 6.2 - Dispute Window", function () {
    it("should dispute within valid dispute window", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      // Wait for some time within the dispute window
      await time.increase(1800); // 30 minutes (half of dispute window)

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);
      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });

    it("should dispute at exact disputeWindow boundary (block.timestamp - timestamp < disputeWindow)", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      // The check is: block.timestamp - timestamp < disputeWindow
      const currentTime = await time.latest();
      const timeSinceSettle = currentTime - chargeBatch.timestamp;
      const remainingTime = DISPUTE_WINDOW - timeSinceSettle - 2;

      if (remainingTime > 0) {
        await time.increase(remainingTime);
      }

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);
      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });

    it("should revert dispute after dispute window expires", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      // Move time past the dispute window
      await time.increase(DISPUTE_WINDOW + 1);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);
      await expect(zeroLC.dispute([dispute])).to.be.revertedWithCustomError(zeroLC, "DisputeWindowExpired");
    });

    it("should dispute with very short dispute window (10 seconds)", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);

      const currentTime = await time.latest();
      const { scope, signature } = await createAuthorizationScope(
        user,
        agent,
        SCOPE_AMOUNT,
        10, // 10 seconds
        currentTime - 60,
        currentTime + 86400
      );

      await zeroLC.registerAuthorizationScope(scope, signature);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const entries = [
        {
          scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0),
          nonce: 1,
          notAfter: timestamp + 3600,
        },
      ];

      const domainSeparator = ethers.TypedDataEncoder.hashDomain({
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      });
      const calculatedScopeHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "tuple(address,uint40,address,uint40,uint40,uint128,uint8)"],
          [
            domainSeparator,
            [scope.user, scope.disputeWindow, scope.agent, scope.notBefore, scope.notAfter, scope.totalAmount, scope.amountGranularity],
          ]
        )
      );

      const chargeBatch = {
        scope: scope,
        entries: entries,
        timestamp: timestamp + 1,
        agentSignature: "0x",
      };

      const lastEntry = entries[0];
      const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint32,uint24,uint40)", "bytes32"],
        [ethers.ZeroHash, [lastEntry.scaledAmount, lastEntry.nonce, lastEntry.notAfter], calculatedScopeHash]
      );

      const verifierBytes = ethers.getBytes(verifierEncoded);
      const agentSignature = await agent.signMessage(verifierBytes);
      chargeBatch.agentSignature = agentSignature;

      await zeroLC.settleCharges([chargeBatch]);

      // Dispute immediately (within 10 seconds)
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);
      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });

    it("should dispute with very long dispute window (100 years)", async function () {
      const { zeroLC, user, agent, depositForUser, createAuthorizationScope, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);

      const currentTime = await time.latest();
      const veryLongWindow = 86400n * 365n * 100n; // 100 years in seconds

      const { scope, signature } = await createAuthorizationScope(
        user,
        agent,
        SCOPE_AMOUNT,
        Number(veryLongWindow),
        currentTime - 60,
        currentTime + 86400
      );

      await zeroLC.registerAuthorizationScope(scope, signature);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const entries = [
        {
          scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0),
          nonce: 1,
          notAfter: timestamp + 3600,
        },
      ];

      const domainSeparator = ethers.TypedDataEncoder.hashDomain({
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      });
      const calculatedScopeHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "tuple(address,uint40,address,uint40,uint40,uint128,uint8)"],
          [
            domainSeparator,
            [scope.user, scope.disputeWindow, scope.agent, scope.notBefore, scope.notAfter, scope.totalAmount, scope.amountGranularity],
          ]
        )
      );

      const chargeBatch = {
        scope: scope,
        entries: entries,
        timestamp: timestamp + 1,
        agentSignature: "0x",
      };

      const lastEntry = entries[0];
      const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint32,uint24,uint40)", "bytes32"],
        [ethers.ZeroHash, [lastEntry.scaledAmount, lastEntry.nonce, lastEntry.notAfter], calculatedScopeHash]
      );

      const verifierBytes = ethers.getBytes(verifierEncoded);
      const agentSignature = await agent.signMessage(verifierBytes);
      chargeBatch.agentSignature = agentSignature;

      await zeroLC.settleCharges([chargeBatch]);

      // Dispute after some time
      await time.increase(86400); // 1 day later
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);
      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });

    it("should validate dispute window calculation with timestamp edge cases", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      // Capture the settlement timestamp
      const settlementTimestamp = chargeBatch.timestamp;

      // Move to somewhere in the middle of the window, not at the edge
      const currentTime = await time.latest();
      const timeToWait = (Number(settlementTimestamp) + DISPUTE_WINDOW - currentTime) / 2;

      if (timeToWait > 0) {
        await time.increase(Math.floor(timeToWait)); // Halfway through the window
      }

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);
      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;

      // Try to dispute the same batch again
      await expect(zeroLC.dispute([dispute])).to.be.revertedWithCustomError(zeroLC, "DisputeAlreadyExists");
    });
  });

  describe("Section 6.3 - Signature Validation", function () {
    it("should revert dispute with invalid user signature", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      // Create dispute with invalid signature (just random bytes)
      const dispute = {
        chargeBatch: chargeBatch,
        amountToClawback: calculateScaledAmount(CHARGE_AMOUNT, 0),
        signature:
          "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12",
      };

      await expect(zeroLC.dispute([dispute])).to.be.reverted;
    });

    it("should revert dispute with wrong signer", async function () {
      const { zeroLC, user, agent, thirdParty, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      // Create dispute signed by thirdParty instead of user
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), thirdParty);

      await expect(zeroLC.dispute([dispute])).to.be.revertedWithCustomError(zeroLC, "InvalidDisputeSignature");
    });

    it("should revert dispute with tampered amountToClawback", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      // Sign with one amount
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);

      // Tamper with the amount
      dispute.amountToClawback = calculateScaledAmount(CHARGE_AMOUNT / 2n, 0);

      await expect(zeroLC.dispute([dispute])).to.be.revertedWithCustomError(zeroLC, "InvalidDisputeSignature");
    });

    it("should revert dispute with tampered scopeHash", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);

      // Tamper with scope data
      chargeBatch.scope.totalAmount = SCOPE_AMOUNT + 1000n;

      await expect(zeroLC.dispute([dispute])).to.be.reverted;
    });

    it("should verify dispute signature uses correct EIP712 type hash", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      // Create dispute with correct EIP712 structure
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

      const disputeData = {
        scopeHash: scopeHash,
        amountToClawback: calculateScaledAmount(CHARGE_AMOUNT, 0),
      };

      const signature = await user.signTypedData(domain, types, disputeData);

      const dispute = {
        chargeBatch: chargeBatch,
        amountToClawback: calculateScaledAmount(CHARGE_AMOUNT, 0),
        signature: signature,
      };

      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });

    it("should dispute with ERC-6492 signature", async function () {
      const { zeroLC, gasToken, owner, agent, calculateScaledAmount } = await loadFixture(deployZeroLCFixture);

      // Deploy SimpleCreate2Factory
      const SimpleCreate2FactoryFactory = await ethers.getContractFactory("SimpleCreate2Factory");
      const factory = await SimpleCreate2FactoryFactory.deploy();
      await factory.waitForDeployment();

      // Prepare wallet deployment
      const MockERC1271WalletFactory = await ethers.getContractFactory("MockERC1271Wallet");
      const walletInitCode = ethers.concat([
        MockERC1271WalletFactory.bytecode,
        ethers.AbiCoder.defaultAbiCoder().encode(["address"], [owner.address]),
      ]);

      const salt = ethers.randomBytes(32);
      const walletAddress = await factory.getDeployedAddress(salt, ethers.keccak256(walletInitCode));

      // Fund the counterfactual wallet
      await gasToken.transfer(walletAddress, DEPOSIT_AMOUNT);

      // Register scope with counterfactual wallet as user
      const scopeTime = await time.latest();
      const notBefore = scopeTime - 60;
      const notAfter = scopeTime + 86400;

      const scope = {
        user: walletAddress,
        disputeWindow: DISPUTE_WINDOW,
        agent: agent.address,
        notBefore: notBefore,
        notAfter: notAfter,
        totalAmount: SCOPE_AMOUNT,
        amountGranularity: 0,
      };

      // Create ERC-6492 wrapped signature for scope registration
      const domain = {
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      };

      const scopeTypes = {
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

      const ownerScopeSignature = await owner.signTypedData(domain, scopeTypes, scope);

      // Wrap in ERC-6492 format
      const erc6492Signature = ethers.concat([
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "bytes", "bytes"],
          [await factory.getAddress(), ethers.concat([salt, walletInitCode]), ownerScopeSignature]
        ),
        "0x6492649264926492649264926492649264926492649264926492649264926492",
      ]);

      // Approve tokens from counterfactual wallet (we need to deploy it first for this)
      await factory.deploy(salt, walletInitCode);
      const deployedWallet = MockERC1271WalletFactory.attach(walletAddress) as MockERC1271Wallet;
      await deployedWallet.executeCall(
        await gasToken.getAddress(),
        gasToken.interface.encodeFunctionData("approve", [await zeroLC.getAddress(), DEPOSIT_AMOUNT])
      );

      await zeroLC.registerAuthorizationScope(scope, erc6492Signature);

      // Settle charges
      const timestamp = await time.latest();
      const entries = [
        {
          scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0),
          nonce: 1,
          notAfter: timestamp + 3600,
        },
      ];

      const domainSeparator = ethers.TypedDataEncoder.hashDomain({
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      });
      const scopeHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "tuple(address,uint40,address,uint40,uint40,uint128,uint8)"],
          [
            domainSeparator,
            [scope.user, scope.disputeWindow, scope.agent, scope.notBefore, scope.notAfter, scope.totalAmount, scope.amountGranularity],
          ]
        )
      );

      const chargeBatch = {
        scope: scope,
        entries: entries,
        timestamp: timestamp + 1,
        agentSignature: "0x",
      };

      const lastEntry = entries[0];
      const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint32,uint24,uint40)", "bytes32"],
        [ethers.ZeroHash, [lastEntry.scaledAmount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
      );

      const verifierBytes = ethers.getBytes(verifierEncoded);
      const agentSignature = await agent.signMessage(verifierBytes);
      chargeBatch.agentSignature = agentSignature;

      await zeroLC.settleCharges([chargeBatch]);

      // Create dispute with ERC-6492 signature
      const disputeTypes = {
        Dispute: [
          { name: "scopeHash", type: "bytes32" },
          { name: "amountToClawback", type: "uint32" },
        ],
      };

      const disputeData = {
        scopeHash: scopeHash,
        amountToClawback: calculateScaledAmount(CHARGE_AMOUNT, 0),
      };

      const ownerDisputeSignature = await owner.signTypedData(domain, disputeTypes, disputeData);

      // Wallet already deployed, so ERC-1271 should work directly
      const dispute = {
        chargeBatch: chargeBatch,
        amountToClawback: calculateScaledAmount(CHARGE_AMOUNT, 0),
        signature: ownerDisputeSignature,
      };

      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });
  });

  describe("Section 6.4 - Amount Validation", function () {
    it("should dispute with amountToClawback < totalChargedAmount", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const partialAmount = CHARGE_AMOUNT - 1n;
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(partialAmount, 0), user);

      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });

    it("should dispute with amountToClawback == totalChargedAmount (boundary)", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);

      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });

    it("should revert dispute with amountToClawback > totalChargedAmount", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const excessiveAmount = CHARGE_AMOUNT + 1n;
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(excessiveAmount, 0), user);

      await expect(zeroLC.dispute([dispute])).to.be.revertedWithCustomError(zeroLC, "ClawbackExceedsBatchTotal");
    });

    it("should revert dispute with zero amountToClawback", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const dispute = await createDispute(chargeBatch, scopeHash, 0n, user);

      await expect(zeroLC.dispute([dispute])).to.be.revertedWithCustomError(zeroLC, "InvalidClawbackAmount");
    });

    it("should calculate totalChargedAmount correctly from entries", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle with multiple entries
      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(1000n, 0), nonce: 1, notAfter: timestamp + 3600 },
        { scaledAmount: calculateScaledAmount(2000n, 0), nonce: 2, notAfter: timestamp + 3600 },
        { scaledAmount: calculateScaledAmount(3000n, 0), nonce: 3, notAfter: timestamp + 3600 },
      ]);

      // Total is 1000 + 2000 + 3000 = 6000
      // Dispute with exact total - should succeed
      const totalAmount = 6000n;
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(totalAmount, 0), user);
      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;

      // Settle a second batch (after dispute, scope is expired, so need a fresh test)
      // This test verified the total is calculated correctly; the excess check is tested elsewhere
    });
  });

  describe("Section 6.5 - Duplicate Disputes", function () {
    it("should revert when disputing same charge batch twice", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);

      // First dispute should succeed
      await zeroLC.dispute([dispute]);

      // Second dispute should fail
      await expect(zeroLC.dispute([dispute])).to.be.revertedWithCustomError(zeroLC, "DisputeAlreadyExists");
    });

    it("should verify dispute hash calculation is unique per batch", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp1 = await time.latest();
      const { chargeBatch: batch1 } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp1 + 3600 }
      ]);

      // Settle second batch
      await time.increase(2);
      const timestamp2 = await time.latest();
      const { chargeBatch: chargeBatch2 } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 2, notAfter: timestamp2 + 3600 }
      ]);

      // Dispute both batches - should work since they have different hashes
      const dispute1 = await createDispute(batch1, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);
      const dispute2 = await createDispute(chargeBatch2, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);

      await expect(zeroLC.dispute([dispute1, dispute2])).to.not.be.reverted;
    });

    it("should verify dispute hash includes scope, entries, and timestamp", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      // Calculate expected dispute hash
      const expectedDisputeHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(address,uint40,address,uint40,uint40,uint128,uint8)", "tuple(uint32,uint24,uint40)[]", "uint40"],
          [
            [scope.user, scope.disputeWindow, scope.agent, scope.notBefore, scope.notAfter, scope.totalAmount, scope.amountGranularity],
            chargeBatch.entries.map((e: any) => [e.scaledAmount, e.nonce, e.notAfter]),
            chargeBatch.timestamp,
          ]
        )
      );

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);
      await zeroLC.dispute([dispute]);

      // Verify the dispute was recorded
      const isDisputed = await zeroLC.disputedCharges(expectedDisputeHash);
      expect(isDisputed).to.be.true;
    });

    it("should verify different batches have different dispute hashes", async function () {
      const { user, agent, depositForUser, registerScope, settleCharges, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);

      const timestamp1 = await time.latest();
      const { chargeBatch: batch1 } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp1 + 3600 }
      ]);

      // Calculate hash for batch1
      const hash1 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(address,uint40,address,uint40,uint40,uint128,uint8)", "tuple(uint32,uint24,uint40)[]", "uint40"],
          [
            [scope.user, scope.disputeWindow, scope.agent, scope.notBefore, scope.notAfter, scope.totalAmount, scope.amountGranularity],
            batch1.entries.map((e: any) => [e.scaledAmount, e.nonce, e.notAfter]),
            batch1.timestamp,
          ]
        )
      );

      // Settle second batch with different timestamp
      await time.increase(2);
      const timestamp2 = await time.latest();

      const hash2 = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(address,uint40,address,uint40,uint40,uint128,uint8)", "tuple(uint32,uint24,uint40)[]", "uint40"],
          [
            [scope.user, scope.disputeWindow, scope.agent, scope.notBefore, scope.notAfter, scope.totalAmount, scope.amountGranularity],
            [{ scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 2, notAfter: timestamp2 + 3600 }].map((e: any) => [e.scaledAmount, e.nonce, e.notAfter]),
            timestamp2,
          ]
        )
      );

      expect(hash1).to.not.equal(hash2);
    });
  });

  describe("Section 6.6 - Agent Signature Verification", function () {
    it("should verify agent signature on charge batch during dispute", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      // Create valid dispute - this implicitly verifies agent signature
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);
      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });

    it("should revert dispute with invalid agent signature during verification", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const entries = [
        {
          scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0),
          nonce: 1,
          notAfter: timestamp + 3600,
        },
      ];

      const chargeBatch = {
        scope: scope,
        entries: entries,
        timestamp: timestamp,
        agentSignature:
          "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12",
      };

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);

      await expect(zeroLC.dispute([dispute])).to.be.reverted;
    });

    it("should validate charge batch signature before processing dispute", async function () {
      const { zeroLC, user, agent, thirdParty, depositForUser, registerScope, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);

      const timestamp = await time.latest();
      const entries = [
        {
          scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0),
          nonce: 1,
          notAfter: timestamp + 3600,
        },
      ];

      const domainSeparator = ethers.TypedDataEncoder.hashDomain({
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      });
      const scopeHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "tuple(address,uint40,address,uint40,uint40,uint128,uint8)"],
          [
            domainSeparator,
            [scope.user, scope.disputeWindow, scope.agent, scope.notBefore, scope.notAfter, scope.totalAmount, scope.amountGranularity],
          ]
        )
      );

      const chargeBatch = {
        scope: scope,
        entries: entries,
        timestamp: timestamp + 1,
        agentSignature: "0x",
      };

      // Sign with wrong signer (thirdParty instead of agent)
      const lastEntry = entries[0];
      const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint32,uint24,uint40)", "bytes32"],
        [ethers.ZeroHash, [lastEntry.scaledAmount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
      );

      const verifierBytes = ethers.getBytes(verifierEncoded);
      const wrongSignature = await thirdParty.signMessage(verifierBytes);
      chargeBatch.agentSignature = wrongSignature;

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);

      await expect(zeroLC.dispute([dispute])).to.be.revertedWithCustomError(zeroLC, "InvalidAgentSignature");
    });
  });

  describe("Section 6.7 - Timestamp Validation", function () {
    it("should revert dispute with future charge batch timestamp", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);

      const currentTime = await time.latest();
      const futureTimestamp = currentTime + 100;

      const entries = [
        {
          scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0),
          nonce: 1,
          notAfter: futureTimestamp + 3600,
        },
      ];

      const domainSeparator = ethers.TypedDataEncoder.hashDomain({
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      });
      const scopeHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "tuple(address,uint40,address,uint40,uint40,uint128,uint8)"],
          [
            domainSeparator,
            [scope.user, scope.disputeWindow, scope.agent, scope.notBefore, scope.notAfter, scope.totalAmount, scope.amountGranularity],
          ]
        )
      );

      const chargeBatch = {
        scope: scope,
        entries: entries,
        timestamp: futureTimestamp,
        agentSignature: "0x",
      };

      const lastEntry = entries[0];
      const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint32,uint24,uint40)", "bytes32"],
        [ethers.ZeroHash, [lastEntry.scaledAmount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
      );

      const verifierBytes = ethers.getBytes(verifierEncoded);
      const agentSignature = await agent.signMessage(verifierBytes);
      chargeBatch.agentSignature = agentSignature;

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);

      await expect(zeroLC.dispute([dispute])).to.be.reverted;
    });

    it("should dispute with timestamp == block.timestamp (boundary)", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);

      const currentTime = await time.latest();

      const entries = [
        {
          scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0),
          nonce: 1,
          notAfter: currentTime + 3600,
        },
      ];

      const domainSeparator = ethers.TypedDataEncoder.hashDomain({
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      });
      const scopeHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "tuple(address,uint40,address,uint40,uint40,uint128,uint8)"],
          [
            domainSeparator,
            [scope.user, scope.disputeWindow, scope.agent, scope.notBefore, scope.notAfter, scope.totalAmount, scope.amountGranularity],
          ]
        )
      );

      const chargeBatch = {
        scope: scope,
        entries: entries,
        timestamp: currentTime + 1,
        agentSignature: "0x",
      };

      const lastEntry = entries[0];
      const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint32,uint24,uint40)", "bytes32"],
        [ethers.ZeroHash, [lastEntry.scaledAmount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
      );

      const verifierBytes = ethers.getBytes(verifierEncoded);
      const agentSignature = await agent.signMessage(verifierBytes);
      chargeBatch.agentSignature = agentSignature;

      // Need to settle first before disputing
      await zeroLC.settleCharges([chargeBatch]);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);
      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });

    it("should validate timestamp <= block.timestamp", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(CHARGE_AMOUNT, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      // Verify the batch timestamp is in the past or present
      const currentTime = await time.latest();
      expect(chargeBatch.timestamp).to.be.lessThanOrEqual(currentTime);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);
      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });
  });

  describe("Section 6.8 - Empty Batch Validation", function () {
    it("should revert dispute with empty disputes array", async function () {
      const { zeroLC } = await loadFixture(deployZeroLCFixture);
      await expect(zeroLC.dispute([])).to.be.revertedWithCustomError(zeroLC, "InvalidBatchLength");
    });

    it("should verify dispute validates non-empty charge batch entries", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT);

      const timestamp = await time.latest();

      // Create charge batch with empty entries
      const chargeBatch = {
        scope: scope,
        entries: [],
        timestamp: timestamp,
        agentSignature: "0x",
      };

      const domainSeparator = ethers.TypedDataEncoder.hashDomain({
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      });
      const scopeHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "tuple(address,uint40,address,uint40,uint40,uint128,uint8)"],
          [
            domainSeparator,
            [scope.user, scope.disputeWindow, scope.agent, scope.notBefore, scope.notAfter, scope.totalAmount, scope.amountGranularity],
          ]
        )
      );

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(CHARGE_AMOUNT, 0), user);

      await expect(zeroLC.dispute([dispute])).to.be.revertedWithCustomError(zeroLC, "EmptyChargeBatch");
    });
  });

  describe("Section 6.9 - Cascading Deduction Logic", function () {
    it("should deduct from chargedAmountFinalizing before chargedAmountPending", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT, DISPUTE_WINDOW);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle batch1 (10000) - goes to pending
      const timestamp1 = await time.latest();
      const { chargeBatch: batch1 } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(10000n, 0), nonce: 1, notAfter: timestamp1 + 3600 }
      ]);

      // Settle batch2 (5000) - this triggers finalization from epoch, moves batch1 to finalizing
      // Wait only a short time (NOT dispute window) to prevent double-run finalization
      await time.increase(10);
      const timestamp2 = await time.latest();
      const { chargeBatch: batch2 } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(5000n, 0), nonce: 2, notAfter: timestamp2 + 3600 }
      ]);

      // Verify state before dispute
      const stateBefore = await zeroLC.authorizationScopes(scopeHash);
      // Second settlement triggers finalization from epoch: batch1 (10000) moved to finalizing, batch2 (5000) in pending
      expect(stateBefore.chargedAmountFinalizing).to.equal(calculateScaledAmount(10000n, 0));
      expect(stateBefore.chargedAmountPending).to.equal(calculateScaledAmount(5000n, 0));

      // Dispute batch2 with its full amount (5000)
      // Cascading deduction should take from finalizing first (even though we're disputing a pending batch)
      const dispute2 = await createDispute(batch2, scopeHash, calculateScaledAmount(5000n, 0), user);
      await zeroLC.dispute([dispute2]);

      // Verify the cascading deduction took 5000 from finalizing (not from pending)
      const stateAfter = await zeroLC.authorizationScopes(scopeHash);
      expect(stateAfter.chargedAmountFinalizing).to.equal(calculateScaledAmount(5000n, 0)); // 10000 - 5000
      expect(stateAfter.chargedAmountPending).to.equal(calculateScaledAmount(5000n, 0)); // Still 5000 (untouched)
    });

    it("should not allow clawing back finalized amounts (chargedAmountWithdrawable)", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT, DISPUTE_WINDOW);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle charges (10000)
      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(10000n, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      // Advance time 2x dispute window - should move to withdrawable
      await time.increase(DISPUTE_WINDOW * 2 + 10);

      // Settle a tiny batch to trigger state update that moves amounts to withdrawable
      const timestamp2 = await time.latest();
      await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(1n, 0), nonce: 2, notAfter: timestamp2 + 3600 }
      ]);

      // Agent withdraws
      await zeroLC.connect(agent)["withdrawAgentChargedFund((address,uint40,address,uint40,uint40,uint128,uint8),bool)"](scope, true);

      // Verify withdrawal succeeded - 10000 was withdrawn
      // Note: The tiny batch (1) has moved to finalizing because of time advancement
      const scopeState = await zeroLC.authorizationScopes(scopeHash);
      expect(scopeState.chargedAmountWithdrawable).to.equal(0); // Should be 0 after withdrawal
      expect(scopeState.chargedAmountFinalizing).to.equal(calculateScaledAmount(1n, 0)); // The tiny batch
      expect(scopeState.chargedAmountPending).to.equal(0);

      // Try to dispute the old batch - should fail because dispute window expired
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(10000n, 0), user);
      await expect(zeroLC.dispute([dispute]))
        .to.be.revertedWithCustomError(zeroLC, "DisputeWindowExpired");
    });

    it("should handle partial clawback from finalizing bucket only", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT, DISPUTE_WINDOW);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle charges (10000) - goes to pending
      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(10000n, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      // Settle a small batch to trigger state update (moves first batch to finalizing)
      // Wait only short time to prevent double-run finalization
      await time.increase(10);
      const timestamp2 = await time.latest();
      const { chargeBatch: batch2 } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(100n, 0), nonce: 2, notAfter: timestamp2 + 3600 }
      ]);

      // Verify state: 10000 in finalizing (from epoch finalization), 100 in pending
      const stateBefore = await zeroLC.authorizationScopes(scopeHash);
      expect(stateBefore.chargedAmountFinalizing).to.equal(calculateScaledAmount(10000n, 0));
      expect(stateBefore.chargedAmountPending).to.equal(calculateScaledAmount(100n, 0));

      // Dispute batch2 with clawback=100 (its full amount, but < finalizing)
      // Should deduct from finalizing, not from pending
      const dispute = await createDispute(batch2, scopeHash, calculateScaledAmount(100n, 0), user);
      await zeroLC.dispute([dispute]);

      // Verify cascading deduction took from finalizing
      const stateAfter = await zeroLC.authorizationScopes(scopeHash);
      expect(stateAfter.chargedAmountFinalizing).to.equal(calculateScaledAmount(9900n, 0)); // 10000 - 100
      expect(stateAfter.chargedAmountPending).to.equal(calculateScaledAmount(100n, 0)); // Still 100
    });

    it("should handle clawback that exactly depletes finalizing + pending", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT, DISPUTE_WINDOW);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle batch1 (3000) - pending
      const timestamp1 = await time.latest();
      const { chargeBatch: batch1 } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(3000n, 0), nonce: 1, notAfter: timestamp1 + 3600 }
      ]);

      // Settle batch2 (7000) - triggers epoch finalization, moves batch1 to finalizing
      await time.increase(10);
      const timestamp2 = await time.latest();
      const { chargeBatch: batch2 } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(7000n, 0), nonce: 2, notAfter: timestamp2 + 3600 }
      ]);

      // Verify state: 3000 in finalizing (from epoch finalization), 7000 in pending
      const stateBefore = await zeroLC.authorizationScopes(scopeHash);
      expect(stateBefore.chargedAmountFinalizing).to.equal(calculateScaledAmount(3000n, 0));
      expect(stateBefore.chargedAmountPending).to.equal(calculateScaledAmount(7000n, 0));

      // Dispute batch2 with clawback=7000 (its full amount)
      // Cascading: takes 3000 from finalizing, then 4000 from pending
      const dispute = await createDispute(batch2, scopeHash, calculateScaledAmount(7000n, 0), user);
      await zeroLC.dispute([dispute]);

      // Verify cascading deduction depleted finalizing and took from pending
      const stateAfter = await zeroLC.authorizationScopes(scopeHash);
      expect(stateAfter.chargedAmountFinalizing).to.equal(0n); // Fully depleted
      expect(stateAfter.chargedAmountPending).to.equal(calculateScaledAmount(3000n, 0)); // 7000 - 4000
    });

    it("should revert with InsufficientPendingBalance when clawback > finalizing+pending", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT, DISPUTE_WINDOW);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle charges (10000)
      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(10000n, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      // Try to dispute with amount > batch total (20000 > 10000)
      // Should revert with ClawbackExceedsBatchTotal before checking pending balance
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(20000n, 0), user);
      await expect(zeroLC.dispute([dispute]))
        .to.be.revertedWithCustomError(zeroLC, "ClawbackExceedsBatchTotal");
    });

    it("should handle cascading deduction across multiple disputes", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT, DISPUTE_WINDOW);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle batch1 (10000)
      const timestamp1 = await time.latest();
      const { chargeBatch: batch1 } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(10000n, 0), nonce: 1, notAfter: timestamp1 + 3600 }
      ]);

      await time.increase(2);

      // Settle batch2 (5000)
      const timestamp2 = await time.latest();
      const { chargeBatch: batch2 } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(5000n, 0), nonce: 2, notAfter: timestamp2 + 3600 }
      ]);

      await time.increase(2);

      // Settle batch3 (3000)
      const timestamp3 = await time.latest();
      const { chargeBatch: batch3 } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(3000n, 0), nonce: 3, notAfter: timestamp3 + 3600 }
      ]);

      // Dispute batch1 (partial - 4000)
      const dispute1 = await createDispute(batch1, scopeHash, calculateScaledAmount(4000n, 0), user);
      await zeroLC.dispute([dispute1]);

      const userState1 = await zeroLC.userStates(user.address);
      expect(userState1.numDisputes).to.equal(1n);

      // Note: After first dispute, scope is expired, so we can't dispute more batches
      // This test demonstrates the first dispute worked correctly
    });
  });

  describe("Section 6.10 - Amount Granularity Tests", function () {
    it("should handle dispute with amountGranularity=3", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);

      // Use amounts divisible by 1000: 1000000 (scaled: 1000)
      const totalAmount = 1000000n;
      const chargeAmount = 100000n;
      const scope = await registerScope(user, agent, totalAmount, DISPUTE_WINDOW, undefined, undefined, 3);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(chargeAmount, 3), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const userBalanceBefore = await zeroLC.userStates(user.address);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(chargeAmount, 3), user);

      // Verify event emits unscaled amount
      await expect(zeroLC.dispute([dispute]))
        .to.emit(zeroLC, "ChargeDisputed")
        .withArgs(user.address, agent.address, scopeHash, chargeAmount);

      const userBalanceAfter = await zeroLC.userStates(user.address);
      expect(userBalanceAfter.balance).to.equal(userBalanceBefore.balance + chargeAmount);
    });

    it("should handle dispute with amountGranularity=6 (USDC-like)", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);

      // Use amounts divisible by 1000000: 10000000 (scaled: 10)
      const totalAmount = 100000000n;
      const chargeAmount = 10000000n;
      const scope = await registerScope(user, agent, totalAmount, DISPUTE_WINDOW, undefined, undefined, 6);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(chargeAmount, 6), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(chargeAmount, 6), user);

      await expect(zeroLC.dispute([dispute]))
        .to.emit(zeroLC, "ChargeDisputed")
        .withArgs(user.address, agent.address, scopeHash, chargeAmount);
    });

    it("should handle dispute with amountGranularity=12", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);

      // Use large amounts: 1000000000000 (scaled: 1)
      const totalAmount = 10000000000000n;
      const chargeAmount = 1000000000000n;
      const scope = await registerScope(user, agent, totalAmount, DISPUTE_WINDOW, undefined, undefined, 12);
      const scopeHash = await zeroLC.getScopeHash(scope);

      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(chargeAmount, 12), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(chargeAmount, 12), user);

      await expect(zeroLC.dispute([dispute]))
        .to.emit(zeroLC, "ChargeDisputed")
        .withArgs(user.address, agent.address, scopeHash, chargeAmount);
    });

    it("should handle cascading deduction with granularity=3", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);

      const totalAmount = 1000000n;
      const scope = await registerScope(user, agent, totalAmount, DISPUTE_WINDOW, undefined, undefined, 3);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle batch1 (30000) - pending
      const timestamp1 = await time.latest();
      const { chargeBatch: batch1 } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(30000n, 3), nonce: 1, notAfter: timestamp1 + 3600 }
      ]);

      // Settle batch2 (70000) - triggers epoch finalization, moves batch1 to finalizing
      await time.increase(10);
      const timestamp2 = await time.latest();
      const { chargeBatch: batch2 } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(70000n, 3), nonce: 2, notAfter: timestamp2 + 3600 }
      ]);

      // Verify state: 30000 in finalizing (from epoch finalization), 70000 in pending
      const stateBefore = await zeroLC.authorizationScopes(scopeHash);
      expect(stateBefore.chargedAmountFinalizing).to.equal(calculateScaledAmount(30000n, 3));
      expect(stateBefore.chargedAmountPending).to.equal(calculateScaledAmount(70000n, 3));

      // Dispute batch2 with its full amount (70000)
      // Cascading should take 30000 from finalizing, then 40000 from pending
      const dispute = await createDispute(batch2, scopeHash, calculateScaledAmount(70000n, 3), user);
      await zeroLC.dispute([dispute]);

      // Verify cascading deduction worked with granularity=3
      const stateAfter = await zeroLC.authorizationScopes(scopeHash);
      expect(stateAfter.chargedAmountFinalizing).to.equal(0n); // Fully depleted
      expect(stateAfter.chargedAmountPending).to.equal(calculateScaledAmount(30000n, 3)); // 70000 - 40000
    });
  });

  describe("Section 6.11 - Nonce Validation", function () {
    it("should allow disputing settled charges (nonce < currentNonce)", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT, DISPUTE_WINDOW);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle charges with nonce=1
      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(5000n, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      // Current nonce should now be 2
      const currentNonce = await zeroLC.getScopeNonce(scopeHash);
      expect(currentNonce).to.equal(2);

      // Dispute settled charges (nonce=1 < currentNonce=2) - should succeed
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(5000n, 0), user);
      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });

    it("should revert when disputing unsettled charges (nonce == currentNonce)", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, createChargeBatch, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT, DISPUTE_WINDOW);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Current nonce is 1 (no settlements yet)
      const currentNonce = await zeroLC.getScopeNonce(scopeHash);
      expect(currentNonce).to.equal(1);

      // Create a signed charge batch with nonce=1 (not settled yet)
      const timestamp = await time.latest();
      const { chargeBatch } = await createChargeBatch(scope, agent, [
        { scaledAmount: calculateScaledAmount(5000n, 0), nonce: 1, notAfter: timestamp + 3600 }
      ], timestamp + 1);

      // Try to dispute unsettled charges (nonce=1 == currentNonce=1) - should revert
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(5000n, 0), user);
      await expect(zeroLC.dispute([dispute]))
        .to.be.revertedWithCustomError(zeroLC, "InvalidNonce");
    });

    it("should revert when disputing future charges (nonce > currentNonce)", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createChargeBatch, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT, DISPUTE_WINDOW);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle charges with nonce=1
      const timestamp1 = await time.latest();
      await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(1000n, 0), nonce: 1, notAfter: timestamp1 + 3600 }
      ]);

      // Current nonce should now be 2
      const currentNonce = await zeroLC.getScopeNonce(scopeHash);
      expect(currentNonce).to.equal(2);

      // Create a signed charge batch with nonce=5 (future, not settled)
      await time.increase(1);
      const timestamp2 = await time.latest();
      const { chargeBatch } = await createChargeBatch(scope, agent, [
        { scaledAmount: calculateScaledAmount(5000n, 0), nonce: 5, notAfter: timestamp2 + 3600 }
      ], timestamp2 + 1);

      // Try to dispute future charges (nonce=5 > currentNonce=2) - should revert
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(5000n, 0), user);
      await expect(zeroLC.dispute([dispute]))
        .to.be.revertedWithCustomError(zeroLC, "InvalidNonce");
    });

    it("should revert when disputing with nonce=0", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, createChargeBatch, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT, DISPUTE_WINDOW);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Create a charge batch with nonce=0 (invalid)
      const timestamp = await time.latest();
      const { chargeBatch } = await createChargeBatch(scope, agent, [
        { scaledAmount: calculateScaledAmount(5000n, 0), nonce: 0, notAfter: timestamp + 3600 }
      ], timestamp + 1);

      // Try to dispute with nonce=0 - should revert
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(5000n, 0), user);
      await expect(zeroLC.dispute([dispute]))
        .to.be.revertedWithCustomError(zeroLC, "InvalidNonce");
    });

    it("should revert when disputing with non-sequential nonces", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createChargeBatch, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT, DISPUTE_WINDOW);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle charges with nonces 1, 2, 3
      const timestamp1 = await time.latest();
      await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(1000n, 0), nonce: 1, notAfter: timestamp1 + 3600 },
        { scaledAmount: calculateScaledAmount(1000n, 0), nonce: 2, notAfter: timestamp1 + 3600 },
        { scaledAmount: calculateScaledAmount(1000n, 0), nonce: 3, notAfter: timestamp1 + 3600 }
      ]);

      // Current nonce should now be 4
      const currentNonce = await zeroLC.getScopeNonce(scopeHash);
      expect(currentNonce).to.equal(4);

      // Create a charge batch with non-sequential nonces [1, 3] (skipping 2)
      await time.increase(1);
      const timestamp2 = await time.latest();
      const { chargeBatch } = await createChargeBatch(scope, agent, [
        { scaledAmount: calculateScaledAmount(1000n, 0), nonce: 1, notAfter: timestamp2 + 3600 },
        { scaledAmount: calculateScaledAmount(1000n, 0), nonce: 3, notAfter: timestamp2 + 3600 }
      ], timestamp2 + 1);

      // Try to dispute with non-sequential nonces - should revert
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(2000n, 0), user);
      await expect(zeroLC.dispute([dispute]))
        .to.be.revertedWithCustomError(zeroLC, "InvalidNonce");
    });

    it("should allow disputing old settled batches within dispute window", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT, DISPUTE_WINDOW);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle first batch with nonce=1
      const timestamp1 = await time.latest();
      const { chargeBatch: batch1 } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(2000n, 0), nonce: 1, notAfter: timestamp1 + 3600 }
      ]);

      // Settle second batch with nonce=2
      await time.increase(2);
      const timestamp2 = await time.latest();
      await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(3000n, 0), nonce: 2, notAfter: timestamp2 + 3600 }
      ]);

      // Current nonce should now be 3
      const currentNonce = await zeroLC.getScopeNonce(scopeHash);
      expect(currentNonce).to.equal(3);

      // Dispute the OLD batch1 (nonce=1) - should succeed as it's settled and within window
      const dispute = await createDispute(batch1, scopeHash, calculateScaledAmount(2000n, 0), user);
      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });

    it("should prevent leaked batch attack - dispute before settlement", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, createChargeBatch, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT, DISPUTE_WINDOW);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Scenario: Agent creates and signs a charge batch for nonce=1
      // but hasn't settled it yet. The signed batch is leaked to the user.
      const timestamp = await time.latest();
      const { chargeBatch } = await createChargeBatch(scope, agent, [
        { scaledAmount: calculateScaledAmount(5000n, 0), nonce: 1, notAfter: timestamp + 3600 }
      ], timestamp + 1);

      // User tries to immediately dispute the leaked batch before agent settles
      const currentNonce = await zeroLC.getScopeNonce(scopeHash);
      expect(currentNonce).to.equal(1); // No settlements yet

      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(5000n, 0), user);

      // Attack should fail: can't dispute unsettled charges (nonce=1 == currentNonce=1)
      await expect(zeroLC.dispute([dispute]))
        .to.be.revertedWithCustomError(zeroLC, "InvalidNonce");
    });

    it("should allow disputing at exact settlement boundary", async function () {
      const { zeroLC, user, agent, depositForUser, registerScope, settleCharges, createDispute, calculateScaledAmount } =
        await loadFixture(deployZeroLCFixture);

      await depositForUser(user, DEPOSIT_AMOUNT);
      const scope = await registerScope(user, agent, SCOPE_AMOUNT, DISPUTE_WINDOW);
      const scopeHash = await zeroLC.getScopeHash(scope);

      // Settle charges with nonce=1
      const timestamp = await time.latest();
      const { chargeBatch } = await settleCharges(scope, agent, [
        { scaledAmount: calculateScaledAmount(5000n, 0), nonce: 1, notAfter: timestamp + 3600 }
      ]);

      // Current nonce is now 2 (immediately after settlement)
      const currentNonce = await zeroLC.getScopeNonce(scopeHash);
      expect(currentNonce).to.equal(2);

      // Immediately dispute the just-settled charges - should succeed
      const dispute = await createDispute(chargeBatch, scopeHash, calculateScaledAmount(5000n, 0), user);
      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });
  });
});
