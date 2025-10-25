import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ZeroLC, TestERC20, UniversalSigValidator, MockERC1271Wallet } from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("ZeroLC - Dispute Tests", function () {
  let zeroLC: ZeroLC;
  let gasToken: TestERC20;
  let universalSigValidator: UniversalSigValidator;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let agent: HardhatEthersSigner;
  let thirdParty: HardhatEthersSigner;

  const DEPOSIT_AMOUNT = ethers.parseEther("1000");
  const SCOPE_AMOUNT = 100000n; // Small amount that fits in uint48
  const DISPUTE_WINDOW = 3600; // 1 hour
  const CHARGE_AMOUNT = 10000n;

  async function deployContracts() {
    [owner, user, agent, thirdParty] = await ethers.getSigners();

    // Deploy TestERC20
    const TestERC20Factory = await ethers.getContractFactory("TestERC20");
    gasToken = await TestERC20Factory.deploy(ethers.parseEther("1000000"));
    await gasToken.waitForDeployment();

    // Deploy UniversalSigValidator
    const UniversalSigValidatorFactory = await ethers.getContractFactory("UniversalSigValidator");
    universalSigValidator = await UniversalSigValidatorFactory.deploy();
    await universalSigValidator.waitForDeployment();

    // Deploy ZeroLC implementation
    const ZeroLCFactory = await ethers.getContractFactory("ZeroLC");
    const implementation = await ZeroLCFactory.deploy(
      await gasToken.getAddress(),
      await universalSigValidator.getAddress()
    );
    await implementation.waitForDeployment();

    // Deploy proxy
    const ERC1967ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await ERC1967ProxyFactory.deploy(
      await implementation.getAddress(),
      implementation.interface.encodeFunctionData("initialize")
    );
    await proxy.waitForDeployment();

    zeroLC = ZeroLCFactory.attach(await proxy.getAddress()) as ZeroLC;

    // Transfer tokens to user
    await gasToken.transfer(user.address, DEPOSIT_AMOUNT);
    await gasToken.connect(user).approve(await zeroLC.getAddress(), DEPOSIT_AMOUNT);

    // User deposits
    await zeroLC.connect(user)["deposit(uint256)"](DEPOSIT_AMOUNT);
  }

  async function registerScope() {
    const currentTime = await time.latest();
    const notBefore = currentTime - 60;
    const notAfter = currentTime + 86400; // 24 hours from now

    const scope = {
      user: user.address,
      totalAmount: SCOPE_AMOUNT,
      disputeWindow: DISPUTE_WINDOW,
      agent: agent.address,
      notBefore: notBefore,
      notAfter: notAfter,
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

  async function settleCharges(scope: any, numCharges: number = 1) {
    const timestamp = await time.latest();

    const entries = [];
    for (let i = 0; i < numCharges; i++) {
      entries.push({
        amount: CHARGE_AMOUNT,
        nonce: i + 1,
        notAfter: timestamp + 3600,
      });
    }

    const chargeBatch = {
      scope: scope,
      entries: entries,
      timestamp: timestamp,
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
        ["bytes32", "tuple(address,uint48,uint48,address,uint48,uint48)"],
        [domainSeparator, [scope.user, scope.totalAmount, scope.disputeWindow, scope.agent, scope.notBefore, scope.notAfter]]
      )
    );

    // Create verifier struct
    let batchPartHash = ethers.ZeroHash;
    if (entries.length > 1) {
      const entriesExceptLast = entries.slice(0, -1);
      batchPartHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(uint48,uint48,uint48)[]"],
          [entriesExceptLast]
        )
      );
    }

    const lastEntry = entries[entries.length - 1];
    const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "tuple(uint48,uint48,uint48)", "bytes32"],
      [batchPartHash, [lastEntry.amount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
    );

    // Agent signs the verifier - IMPORTANT: sign the bytes, not the hash!
    const verifierBytes = ethers.getBytes(verifierEncoded);
    const agentSignature = await agent.signMessage(verifierBytes);
    chargeBatch.agentSignature = agentSignature;

    await zeroLC.settleCharges([chargeBatch]);

    return { chargeBatch, scopeHash };
  }

  async function createDispute(chargeBatch: any, scopeHash: string, amountToClawback: bigint, signer: HardhatEthersSigner = user) {
    const domain = {
      name: "ZeroLC",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await zeroLC.getAddress(),
    };

    const types = {
      Dispute: [
        { name: "scopeHash", type: "bytes32" },
        { name: "amountToClawback", type: "uint48" },
      ],
    };

    const disputeData = {
      scopeHash: scopeHash,
      amountToClawback: amountToClawback,
    };

    const signature = await signer.signTypedData(domain, types, disputeData);

    return {
      chargeBatch: chargeBatch,
      amountToClawback: amountToClawback,
      signature: signature,
    };
  }

  describe("Section 6.1 - Valid Disputes", function () {
    beforeEach(async function () {
      await deployContracts();
    });

    it("should dispute valid charge batch within dispute window", async function () {
      const scope = await registerScope();
      const { chargeBatch, scopeHash } = await settleCharges(scope);

      const userBalanceBefore = await zeroLC.userStates(user.address);
      const scopeStateBefore = await zeroLC.authorizationScopes(scopeHash);

      const dispute = await createDispute(chargeBatch, scopeHash, CHARGE_AMOUNT);

      await expect(zeroLC.dispute([dispute]))
        .to.emit(zeroLC, "ChargeDisputed")
        .withArgs(user.address, agent.address, scopeHash, CHARGE_AMOUNT);

      const userBalanceAfter = await zeroLC.userStates(user.address);
      const scopeStateAfter = await zeroLC.authorizationScopes(scopeHash);

      expect(userBalanceAfter.balance).to.equal(userBalanceBefore.balance + CHARGE_AMOUNT);
      expect(scopeStateAfter.agentPendingAmount).to.equal(scopeStateBefore.agentPendingAmount - CHARGE_AMOUNT);
      const currentTime = await time.latest();
      expect(scopeStateAfter.notAfter).to.be.lessThanOrEqual(currentTime + 1);
      expect(userBalanceAfter.numDisputes).to.equal(userBalanceBefore.numDisputes + BigInt(1));
    });

    it("should dispute with partial clawback amount", async function () {
      const scope = await registerScope();
      const { chargeBatch, scopeHash } = await settleCharges(scope);

      const partialAmount = CHARGE_AMOUNT / BigInt(2);
      const dispute = await createDispute(chargeBatch, scopeHash, partialAmount);

      const userBalanceBefore = await zeroLC.userStates(user.address);
      const scopeStateBefore = await zeroLC.authorizationScopes(scopeHash);

      await zeroLC.dispute([dispute]);

      const userBalanceAfter = await zeroLC.userStates(user.address);
      const scopeStateAfter = await zeroLC.authorizationScopes(scopeHash);

      expect(userBalanceAfter.balance).to.equal(userBalanceBefore.balance + partialAmount);
      expect(scopeStateAfter.agentPendingAmount).to.equal(scopeStateBefore.agentPendingAmount - partialAmount);
    });

    it("should dispute with full clawback amount (amountToClawback == totalChargedAmount)", async function () {
      const scope = await registerScope();
      const { chargeBatch, scopeHash } = await settleCharges(scope);

      const dispute = await createDispute(chargeBatch, scopeHash, CHARGE_AMOUNT);

      const userBalanceBefore = await zeroLC.userStates(user.address);
      const scopeStateBefore = await zeroLC.authorizationScopes(scopeHash);

      await zeroLC.dispute([dispute]);

      const userBalanceAfter = await zeroLC.userStates(user.address);
      const scopeStateAfter = await zeroLC.authorizationScopes(scopeHash);

      expect(userBalanceAfter.balance).to.equal(userBalanceBefore.balance + CHARGE_AMOUNT);
      expect(scopeStateAfter.agentPendingAmount).to.equal(BigInt(0));
    });

    it("should dispute with valid user EOA signature", async function () {
      const scope = await registerScope();
      const { chargeBatch, scopeHash } = await settleCharges(scope);

      const dispute = await createDispute(chargeBatch, scopeHash, CHARGE_AMOUNT, user);

      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });

    it("should dispute with valid ERC-1271 signature from smart wallet", async function () {
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

      // Register scope for smart wallet
      const scopeTime = await time.latest();
      const notBefore = scopeTime - 60;
      const notAfter = scopeTime + 86400;

      const scope = {
        user: await smartWallet.getAddress(),
        totalAmount: SCOPE_AMOUNT,
        disputeWindow: DISPUTE_WINDOW,
        agent: agent.address,
        notBefore: notBefore,
        notAfter: notAfter,
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

      const signature = await owner.signTypedData(domain, types, scope);
      await zeroLC.registerAuthorizationScope(scope, signature);

      // Settle charges
      const timestamp = await time.latest();
      const entries = [{
        amount: CHARGE_AMOUNT,
        nonce: 1,
        notAfter: timestamp + 3600,
      }];

      const chargeBatch = {
        scope: scope,
        entries: entries,
        timestamp: timestamp,
        agentSignature: "0x",
      };

      const scopeDomainSeparator = ethers.TypedDataEncoder.hashDomain({
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      });
      const scopeHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "tuple(address,uint48,uint48,address,uint48,uint48)"],
          [scopeDomainSeparator, [scope.user, scope.totalAmount, scope.disputeWindow, scope.agent, scope.notBefore, scope.notAfter]]
        )
      );

      const lastEntry = entries[0];
      const verifierEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint48,uint48,uint48)", "bytes32"],
        [ethers.ZeroHash, [lastEntry.amount, lastEntry.nonce, lastEntry.notAfter], scopeHash]
      );

      const verifierBytes = ethers.getBytes(verifierEncoded);
      const agentSignature = await agent.signMessage(verifierBytes);
      chargeBatch.agentSignature = agentSignature;

      await zeroLC.settleCharges([chargeBatch]);

      // Create dispute with ERC-1271 signature
      const disputeTypes = {
        Dispute: [
          { name: "scopeHash", type: "bytes32" },
          { name: "amountToClawback", type: "uint48" },
        ],
      };

      const disputeData = {
        scopeHash: scopeHash,
        amountToClawback: CHARGE_AMOUNT,
      };

      const disputeSignature = await owner.signTypedData(domain, disputeTypes, disputeData);

      const dispute = {
        chargeBatch: chargeBatch,
        amountToClawback: CHARGE_AMOUNT,
        signature: disputeSignature,
      };

      await expect(zeroLC.dispute([dispute])).to.not.be.reverted;
    });

    it("should update agentPendingAmount correctly (decreases)", async function () {
      const scope = await registerScope();
      const { chargeBatch, scopeHash } = await settleCharges(scope);

      const scopeStateBefore = await zeroLC.authorizationScopes(scopeHash);
      expect(scopeStateBefore.agentPendingAmount).to.equal(CHARGE_AMOUNT);

      const dispute = await createDispute(chargeBatch, scopeHash, CHARGE_AMOUNT);
      await zeroLC.dispute([dispute]);

      const scopeStateAfter = await zeroLC.authorizationScopes(scopeHash);
      expect(scopeStateAfter.agentPendingAmount).to.equal(BigInt(0));
    });

    it("should update user balance correctly (increases)", async function () {
      const scope = await registerScope();
      const { chargeBatch, scopeHash } = await settleCharges(scope);

      const userBalanceBefore = await zeroLC.userStates(user.address);

      const dispute = await createDispute(chargeBatch, scopeHash, CHARGE_AMOUNT);
      await zeroLC.dispute([dispute]);

      const userBalanceAfter = await zeroLC.userStates(user.address);
      expect(userBalanceAfter.balance).to.equal(userBalanceBefore.balance + CHARGE_AMOUNT);
    });

    it("should set scope notAfter to block.timestamp", async function () {
      const scope = await registerScope();
      const { chargeBatch, scopeHash } = await settleCharges(scope);

      const dispute = await createDispute(chargeBatch, scopeHash, CHARGE_AMOUNT);
      await zeroLC.dispute([dispute]);

      const scopeStateAfter = await zeroLC.authorizationScopes(scopeHash);
      const currentTimestamp = await time.latest();

      expect(scopeStateAfter.notAfter).to.be.lessThanOrEqual(currentTimestamp + 1);
      expect(scopeStateAfter.notAfter).to.be.greaterThanOrEqual(currentTimestamp - 1);
    });

    it("should increment numDisputes counter", async function () {
      const scope = await registerScope();
      const { chargeBatch, scopeHash } = await settleCharges(scope);

      const userStateBefore = await zeroLC.userStates(user.address);

      const dispute = await createDispute(chargeBatch, scopeHash, CHARGE_AMOUNT);
      await zeroLC.dispute([dispute]);

      const userStateAfter = await zeroLC.userStates(user.address);
      expect(userStateAfter.numDisputes).to.equal(userStateBefore.numDisputes + BigInt(1));
    });

    it("should emit ChargeDisputed event with correct parameters", async function () {
      const scope = await registerScope();
      const { chargeBatch, scopeHash } = await settleCharges(scope);

      const dispute = await createDispute(chargeBatch, scopeHash, CHARGE_AMOUNT);

      await expect(zeroLC.dispute([dispute]))
        .to.emit(zeroLC, "ChargeDisputed")
        .withArgs(user.address, agent.address, scopeHash, CHARGE_AMOUNT);
    });

    it("should handle multiple disputes in single transaction (different batches)", async function () {
      const scope = await registerScope();

      // First settlement
      const { chargeBatch: chargeBatch1, scopeHash } = await settleCharges(scope, 1);

      // Increase time to ensure different timestamp
      await time.increase(2);

      // Second settlement with different nonce
      const timestamp2 = await time.latest();
      const entries2 = [{
        amount: CHARGE_AMOUNT,
        nonce: 2,
        notAfter: timestamp2 + 3600,
      }];

      const chargeBatch2 = {
        scope: scope,
        entries: entries2,
        timestamp: timestamp2,
        agentSignature: "0x",
      };

      const lastEntry2 = entries2[0];
      const verifierEncoded2 = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "tuple(uint48,uint48,uint48)", "bytes32"],
        [ethers.ZeroHash, [lastEntry2.amount, lastEntry2.nonce, lastEntry2.notAfter], scopeHash]
      );

      const verifierBytes2 = ethers.getBytes(verifierEncoded2);
      const agentSignature2 = await agent.signMessage(verifierBytes2);
      chargeBatch2.agentSignature = agentSignature2;

      await zeroLC.settleCharges([chargeBatch2]);

      // Create two disputes
      const dispute1 = await createDispute(chargeBatch1, scopeHash, CHARGE_AMOUNT);
      const dispute2 = await createDispute(chargeBatch2, scopeHash, CHARGE_AMOUNT);

      const userBalanceBefore = await zeroLC.userStates(user.address);

      await zeroLC.dispute([dispute1, dispute2]);

      const userBalanceAfter = await zeroLC.userStates(user.address);
      expect(userBalanceAfter.balance).to.equal(userBalanceBefore.balance + CHARGE_AMOUNT + CHARGE_AMOUNT);
      expect(userBalanceAfter.numDisputes).to.equal(userBalanceBefore.numDisputes + BigInt(2));
    });
  });
});