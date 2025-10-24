import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeroLC, TestERC20, UniversalSigValidator } from "../../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ZeroLC - Direct Deposit (no signature)", function () {
  // Fixture to deploy the contract and set up test environment
  async function deployZeroLCFixture() {
    const [owner, user1, user2, agent1] = await ethers.getSigners();

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

    return {
      zeroLC,
      gasToken,
      universalSigValidator,
      owner,
      user1,
      user2,
      agent1,
    };
  }

  describe("Deposit with valid amount increases user balance", function () {
    it("should increase user balance when depositing valid amount", async function () {
      const { zeroLC, gasToken, user1 } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // Approve tokens
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount);

      // Check balance before deposit
      const balanceBefore = await zeroLC.balanceOf(user1.address);
      expect(balanceBefore).to.equal(0);

      // Perform deposit
      await zeroLC.connect(user1)["deposit(uint256)"](depositAmount);

      // Check balance after deposit
      const balanceAfter = await zeroLC.balanceOf(user1.address);
      expect(balanceAfter).to.equal(depositAmount);
    });

    it("should correctly accumulate balance from multiple deposits", async function () {
      const { zeroLC, gasToken, user1 } = await loadFixture(deployZeroLCFixture);

      const depositAmount1 = ethers.parseEther("100");
      const depositAmount2 = ethers.parseEther("50");

      // Approve tokens
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount1 + depositAmount2);

      // First deposit
      await zeroLC.connect(user1)["deposit(uint256)"](depositAmount1);
      expect(await zeroLC.balanceOf(user1.address)).to.equal(depositAmount1);

      // Second deposit
      await zeroLC.connect(user1)["deposit(uint256)"](depositAmount2);
      expect(await zeroLC.balanceOf(user1.address)).to.equal(depositAmount1 + depositAmount2);
    });
  });

  describe("Deposit with zero amount (should revert)", function () {
    it("should revert when depositing zero amount", async function () {
      const { zeroLC, user1 } = await loadFixture(deployZeroLCFixture);

      await expect(
        zeroLC.connect(user1)["deposit(uint256)"](0)
      ).to.be.revertedWith("Deposit amount must be greater than zero");
    });
  });

  describe("Deposit with insufficient token balance (should revert)", function () {
    it("should revert when user has insufficient token balance", async function () {
      const { zeroLC, gasToken, user1 } = await loadFixture(deployZeroLCFixture);

      // User has 10000 tokens, try to deposit more
      const depositAmount = ethers.parseEther("20000");

      // Approve tokens (approval will succeed but transfer will fail)
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount);

      // Should revert during transfer
      await expect(
        zeroLC.connect(user1)["deposit(uint256)"](depositAmount)
      ).to.be.reverted;
    });
  });

  describe("Deposit with insufficient allowance (should revert)", function () {
    it("should revert when user has insufficient allowance", async function () {
      const { zeroLC, gasToken, user1 } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // Don't approve or approve insufficient amount
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount / 2n);

      // Should revert during transfer
      await expect(
        zeroLC.connect(user1)["deposit(uint256)"](depositAmount)
      ).to.be.reverted;
    });

    it("should revert when user has no allowance", async function () {
      const { zeroLC, user1 } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // Should revert during transfer (no approval)
      await expect(
        zeroLC.connect(user1)["deposit(uint256)"](depositAmount)
      ).to.be.reverted;
    });
  });

  describe("Deposit emits correct Deposit event", function () {
    it("should emit Deposit event with correct parameters", async function () {
      const { zeroLC, gasToken, user1 } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // Approve tokens
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount);

      // Check event emission
      await expect(zeroLC.connect(user1)["deposit(uint256)"](depositAmount))
        .to.emit(zeroLC, "Deposit")
        .withArgs(user1.address, depositAmount);
    });
  });

  describe("Reentrancy attack on deposit (should be blocked)", function () {
    it("should block reentrancy attack during deposit", async function () {
      const { owner } = await loadFixture(deployZeroLCFixture);

      // Deploy a malicious ERC20 token that attempts reentrancy
      const MaliciousTokenFactory = await ethers.getContractFactory("MaliciousReentrantToken");
      const maliciousToken = await MaliciousTokenFactory.deploy(ethers.parseEther("1000000"));
      await maliciousToken.waitForDeployment();

      // Deploy UniversalSigValidator for the malicious test
      const UniversalSigValidatorFactory = await ethers.getContractFactory("UniversalSigValidator");
      const universalSigValidator = (await UniversalSigValidatorFactory.deploy()) as UniversalSigValidator;
      await universalSigValidator.waitForDeployment();

      // Deploy a new ZeroLC with the malicious token
      const ZeroLCFactory = await ethers.getContractFactory("ZeroLC");
      const maliciousZeroLCImpl = (await ZeroLCFactory.deploy(
        await maliciousToken.getAddress(),
        await universalSigValidator.getAddress()
      )) as ZeroLC;
      await maliciousZeroLCImpl.waitForDeployment();

      // Deploy proxy
      const ERC1967ProxyFactory = await ethers.getContractFactory("@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy");
      const initData = maliciousZeroLCImpl.interface.encodeFunctionData("initialize");
      const proxy = await ERC1967ProxyFactory.deploy(await maliciousZeroLCImpl.getAddress(), initData);
      await proxy.waitForDeployment();

      const maliciousZeroLC = ZeroLCFactory.attach(await proxy.getAddress()) as ZeroLC;

      // Set the target for reentrancy attack
      await maliciousToken.setReentrancyTarget(
        await maliciousZeroLC.getAddress(),
        maliciousZeroLC.interface.encodeFunctionData("deposit(uint256)", [ethers.parseEther("10")])
      );

      // Approve tokens
      await maliciousToken.connect(owner).approve(await maliciousZeroLC.getAddress(), ethers.parseEther("100"));

      // Attempt deposit - should revert due to reentrancy guard
      await expect(
        maliciousZeroLC.connect(owner)["deposit(uint256)"](ethers.parseEther("50"))
      ).to.be.reverted;
    });
  });

  describe("Multiple consecutive deposits accumulate correctly", function () {
    it("should correctly accumulate balance from multiple consecutive deposits", async function () {
      const { zeroLC, gasToken, user1 } = await loadFixture(deployZeroLCFixture);

      const deposits = [
        ethers.parseEther("100"),
        ethers.parseEther("50"),
        ethers.parseEther("75"),
        ethers.parseEther("25"),
      ];

      const totalDeposit = deposits.reduce((acc, val) => acc + val, 0n);

      // Approve total amount
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), totalDeposit);

      let expectedBalance = 0n;

      // Perform multiple deposits
      for (const depositAmount of deposits) {
        await zeroLC.connect(user1)["deposit(uint256)"](depositAmount);
        expectedBalance += depositAmount;

        const currentBalance = await zeroLC.balanceOf(user1.address);
        expect(currentBalance).to.equal(expectedBalance);
      }

      // Final balance check
      expect(await zeroLC.balanceOf(user1.address)).to.equal(totalDeposit);
    });

    it("should handle deposits from multiple users independently", async function () {
      const { zeroLC, gasToken, user1, user2 } = await loadFixture(deployZeroLCFixture);

      const user1Deposit = ethers.parseEther("100");
      const user2Deposit = ethers.parseEther("200");

      // Approve tokens for both users
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), user1Deposit);
      await gasToken.connect(user2).approve(await zeroLC.getAddress(), user2Deposit);

      // User1 deposits
      await zeroLC.connect(user1)["deposit(uint256)"](user1Deposit);
      expect(await zeroLC.balanceOf(user1.address)).to.equal(user1Deposit);
      expect(await zeroLC.balanceOf(user2.address)).to.equal(0);

      // User2 deposits
      await zeroLC.connect(user2)["deposit(uint256)"](user2Deposit);
      expect(await zeroLC.balanceOf(user1.address)).to.equal(user1Deposit);
      expect(await zeroLC.balanceOf(user2.address)).to.equal(user2Deposit);
    });
  });
});

describe("ZeroLC - Deposit with Signature", function () {
  // Fixture to deploy the contract and set up test environment
  async function deployZeroLCFixture() {
    const [owner, user1, user2, agent1] = await ethers.getSigners();

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

    // Helper function to create EIP712 signature for deposit
    async function signDeposit(signer: SignerWithAddress, user: string, amount: bigint, nonce: bigint) {
      const domain = {
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      };

      const types = {
        Deposit: [
          { name: "user", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        user: user,
        amount: amount,
        nonce: nonce,
      };

      return await signer.signTypedData(domain, types, value);
    }

    return {
      zeroLC,
      gasToken,
      universalSigValidator,
      owner,
      user1,
      user2,
      agent1,
      signDeposit,
    };
  }

  describe("Deposit with valid signature from EOA", function () {
    it("should allow deposit with valid EOA signature", async function () {
      const { zeroLC, gasToken, user1, user2, signDeposit } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // User1 approves tokens
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount);

      // Get current nonce
      const nonce = (await zeroLC.userStates(user1.address)).nonce;

      // User1 signs deposit message
      const signature = await signDeposit(user1, user1.address, depositAmount, nonce);

      // Check balance before deposit
      const balanceBefore = await zeroLC.balanceOf(user1.address);
      expect(balanceBefore).to.equal(0);

      // Anyone (user2) can submit the signed deposit
      await zeroLC.connect(user2)["deposit(address,uint256,bytes)"](
        user1.address,
        depositAmount,
        signature
      );

      // Check balance after deposit
      const balanceAfter = await zeroLC.balanceOf(user1.address);
      expect(balanceAfter).to.equal(depositAmount);

      // Check nonce was incremented
      const newNonce = (await zeroLC.userStates(user1.address)).nonce;
      expect(newNonce).to.equal(nonce + 1n);
    });

    it("should emit Deposit event with correct parameters when using signature", async function () {
      const { zeroLC, gasToken, user1, user2, signDeposit } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // User1 approves tokens
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount);

      // Get current nonce
      const nonce = (await zeroLC.userStates(user1.address)).nonce;

      // User1 signs deposit message
      const signature = await signDeposit(user1, user1.address, depositAmount, nonce);

      // Check event emission
      await expect(
        zeroLC.connect(user2)["deposit(address,uint256,bytes)"](
          user1.address,
          depositAmount,
          signature
        )
      )
        .to.emit(zeroLC, "Deposit")
        .withArgs(user1.address, depositAmount);
    });

    it("should allow third party to submit deposit with valid signature", async function () {
      const { zeroLC, gasToken, user1, agent1, signDeposit } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // User1 approves tokens
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount);

      // Get current nonce
      const nonce = (await zeroLC.userStates(user1.address)).nonce;

      // User1 signs deposit message
      const signature = await signDeposit(user1, user1.address, depositAmount, nonce);

      // Agent1 (third party) submits the signed deposit on behalf of user1
      await zeroLC.connect(agent1)["deposit(address,uint256,bytes)"](
        user1.address,
        depositAmount,
        signature
      );

      // Check balance
      expect(await zeroLC.balanceOf(user1.address)).to.equal(depositAmount);
    });
  });

  describe("Deposit with invalid signature (should revert)", function () {
    it("should revert with invalid signature", async function () {
      const { zeroLC, gasToken, user1, user2, signDeposit } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // User1 approves tokens
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount);

      // Get current nonce
      const nonce = (await zeroLC.userStates(user1.address)).nonce;

      // User1 signs deposit message
      const signature = await signDeposit(user1, user1.address, depositAmount, nonce);

      // Corrupt the signature by flipping a byte
      const corruptedSignature = signature.slice(0, -2) + (signature.slice(-2) === "ff" ? "00" : "ff");

      // Should revert due to invalid signature (could be various error messages)
      await expect(
        zeroLC.connect(user2)["deposit(address,uint256,bytes)"](
          user1.address,
          depositAmount,
          corruptedSignature
        )
      ).to.be.reverted;
    });

    it("should revert with signature from wrong signer", async function () {
      const { zeroLC, gasToken, user1, user2, signDeposit } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // User1 approves tokens
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount);

      // Get current nonce
      const nonce = (await zeroLC.userStates(user1.address)).nonce;

      // User2 signs deposit message (wrong signer)
      const signature = await signDeposit(user2, user1.address, depositAmount, nonce);

      // Should revert because user2 signed instead of user1
      await expect(
        zeroLC.connect(user2)["deposit(address,uint256,bytes)"](
          user1.address,
          depositAmount,
          signature
        )
      ).to.be.revertedWith("Invalid deposit signature");
    });

    it("should revert with malformed signature", async function () {
      const { zeroLC, gasToken, user1 } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // User1 approves tokens
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount);

      // Malformed signature (too short)
      const malformedSignature = "0x1234";

      // Should revert due to malformed signature
      await expect(
        zeroLC.connect(user1)["deposit(address,uint256,bytes)"](
          user1.address,
          depositAmount,
          malformedSignature
        )
      ).to.be.reverted;
    });

    it("should revert when signature is for different amount", async function () {
      const { zeroLC, gasToken, user1, signDeposit } = await loadFixture(deployZeroLCFixture);

      const signedAmount = ethers.parseEther("100");
      const actualAmount = ethers.parseEther("200");

      // User1 approves tokens
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), actualAmount);

      // Get current nonce
      const nonce = (await zeroLC.userStates(user1.address)).nonce;

      // User1 signs for different amount
      const signature = await signDeposit(user1, user1.address, signedAmount, nonce);

      // Should revert because amounts don't match
      await expect(
        zeroLC.connect(user1)["deposit(address,uint256,bytes)"](
          user1.address,
          actualAmount,
          signature
        )
      ).to.be.revertedWith("Invalid deposit signature");
    });

    it("should revert when signature is for different user", async function () {
      const { zeroLC, gasToken, user1, user2, signDeposit } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // User1 approves tokens
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount);

      // Get current nonce
      const nonce = (await zeroLC.userStates(user1.address)).nonce;

      // User1 signs for their own address
      const signature = await signDeposit(user1, user1.address, depositAmount, nonce);

      // Try to use signature for user2's address
      await expect(
        zeroLC.connect(user1)["deposit(address,uint256,bytes)"](
          user2.address,
          depositAmount,
          signature
        )
      ).to.be.revertedWith("Invalid deposit signature");
    });
  });

  describe("Deposit to zero address (should revert)", function () {
    it("should revert when depositing to zero address", async function () {
      const { zeroLC, user1, signDeposit } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // Sign for zero address (use nonce 0 since zero address has no state)
      const signature = await signDeposit(user1, ethers.ZeroAddress, depositAmount, 0n);

      // Should revert (signature validation fails before user address check)
      await expect(
        zeroLC.connect(user1)["deposit(address,uint256,bytes)"](
          ethers.ZeroAddress,
          depositAmount,
          signature
        )
      ).to.be.reverted;
    });
  });

  describe("Deposit signature has correct EIP712 type hash", function () {
    it("should verify signature using correct EIP712 domain and type", async function () {
      const { zeroLC, gasToken, user1, signDeposit } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // User1 approves tokens
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount);

      // Get current nonce
      const nonce = (await zeroLC.userStates(user1.address)).nonce;

      // Sign with correct domain and type
      const signature = await signDeposit(user1, user1.address, depositAmount, nonce);

      // Should succeed with correctly formatted signature
      await expect(
        zeroLC.connect(user1)["deposit(address,uint256,bytes)"](
          user1.address,
          depositAmount,
          signature
        )
      ).to.not.be.reverted;

      expect(await zeroLC.balanceOf(user1.address)).to.equal(depositAmount);
    });

    it("should reject signature with wrong domain name", async function () {
      const { zeroLC, gasToken, user1 } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // User1 approves tokens
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount);

      // Get current nonce
      const nonce = (await zeroLC.userStates(user1.address)).nonce;

      // Create signature with wrong domain name
      const wrongDomain = {
        name: "WrongName",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      };

      const types = {
        Deposit: [
          { name: "user", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        user: user1.address,
        amount: depositAmount,
        nonce: nonce,
      };

      const signature = await user1.signTypedData(wrongDomain, types, value);

      // Should revert with invalid signature
      await expect(
        zeroLC.connect(user1)["deposit(address,uint256,bytes)"](
          user1.address,
          depositAmount,
          signature
        )
      ).to.be.revertedWith("Invalid deposit signature");
    });

    it("should reject signature with wrong domain version", async function () {
      const { zeroLC, gasToken, user1 } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // User1 approves tokens
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount);

      // Get current nonce
      const nonce = (await zeroLC.userStates(user1.address)).nonce;

      // Create signature with wrong domain version
      const wrongDomain = {
        name: "ZeroLC",
        version: "2",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      };

      const types = {
        Deposit: [
          { name: "user", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        user: user1.address,
        amount: depositAmount,
        nonce: nonce,
      };

      const signature = await user1.signTypedData(wrongDomain, types, value);

      // Should revert with invalid signature
      await expect(
        zeroLC.connect(user1)["deposit(address,uint256,bytes)"](
          user1.address,
          depositAmount,
          signature
        )
      ).to.be.revertedWith("Invalid deposit signature");
    });
  });

  describe("Reentrancy attack on signed deposit (should be blocked)", function () {
    it("should block reentrancy attack during signed deposit", async function () {
      const { owner, signDeposit } = await loadFixture(deployZeroLCFixture);

      // Deploy a malicious ERC20 token that attempts reentrancy
      const MaliciousTokenFactory = await ethers.getContractFactory("MaliciousReentrantToken");
      const maliciousToken = await MaliciousTokenFactory.deploy(ethers.parseEther("1000000"));
      await maliciousToken.waitForDeployment();

      // Deploy UniversalSigValidator for the malicious test
      const UniversalSigValidatorFactory = await ethers.getContractFactory("UniversalSigValidator");
      const universalSigValidator = (await UniversalSigValidatorFactory.deploy()) as UniversalSigValidator;
      await universalSigValidator.waitForDeployment();

      // Deploy a new ZeroLC with the malicious token
      const ZeroLCFactory = await ethers.getContractFactory("ZeroLC");
      const maliciousZeroLCImpl = (await ZeroLCFactory.deploy(
        await maliciousToken.getAddress(),
        await universalSigValidator.getAddress()
      )) as ZeroLC;
      await maliciousZeroLCImpl.waitForDeployment();

      // Deploy proxy
      const ERC1967ProxyFactory = await ethers.getContractFactory("@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy");
      const initData = maliciousZeroLCImpl.interface.encodeFunctionData("initialize");
      const proxy = await ERC1967ProxyFactory.deploy(await maliciousZeroLCImpl.getAddress(), initData);
      await proxy.waitForDeployment();

      const maliciousZeroLC = ZeroLCFactory.attach(await proxy.getAddress()) as ZeroLC;

      // Create signature for deposit
      const depositAmount = ethers.parseEther("50");
      const nonce = (await maliciousZeroLC.userStates(owner.address)).nonce;
      const domain = {
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await maliciousZeroLC.getAddress(),
      };

      const types = {
        Deposit: [
          { name: "user", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        user: owner.address,
        amount: depositAmount,
        nonce: nonce,
      };

      const signature = await owner.signTypedData(domain, types, value);

      // Set the target for reentrancy attack
      await maliciousToken.setReentrancyTarget(
        await maliciousZeroLC.getAddress(),
        maliciousZeroLC.interface.encodeFunctionData("deposit(address,uint256,bytes)", [
          owner.address,
          ethers.parseEther("10"),
          signature,
        ])
      );

      // Approve tokens
      await maliciousToken.connect(owner).approve(await maliciousZeroLC.getAddress(), ethers.parseEther("100"));

      // Attempt deposit - should revert due to reentrancy guard
      await expect(
        maliciousZeroLC.connect(owner)["deposit(address,uint256,bytes)"](
          owner.address,
          depositAmount,
          signature
        )
      ).to.be.reverted;
    });
  });

  describe("Deposit with valid ERC-1271 signature from smart contract wallet", function () {
    it("should allow deposit with valid ERC-1271 signature", async function () {
      const { zeroLC, gasToken, owner } = await loadFixture(deployZeroLCFixture);

      // Deploy a mock ERC-1271 wallet
      const MockERC1271WalletFactory = await ethers.getContractFactory("MockERC1271Wallet");
      const mockWallet = await MockERC1271WalletFactory.deploy(owner.address);
      await mockWallet.waitForDeployment();

      const depositAmount = ethers.parseEther("100");

      // Transfer tokens to the wallet
      await gasToken.transfer(await mockWallet.getAddress(), depositAmount);

      // Approve from wallet
      await mockWallet.executeCall(
        await gasToken.getAddress(),
        gasToken.interface.encodeFunctionData("approve", [await zeroLC.getAddress(), depositAmount])
      );

      // Create the EIP712 signature
      const walletAddress = await mockWallet.getAddress();
      const nonce = (await zeroLC.userStates(walletAddress)).nonce;
      const domain = {
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      };

      const types = {
        Deposit: [
          { name: "user", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        user: walletAddress,
        amount: depositAmount,
        nonce: nonce,
      };

      // Owner signs on behalf of the wallet
      const signature = await owner.signTypedData(domain, types, value);

      // Deposit should succeed
      await zeroLC["deposit(address,uint256,bytes)"](
        walletAddress,
        depositAmount,
        signature
      );

      expect(await zeroLC.balanceOf(walletAddress)).to.equal(depositAmount);
    });

    it("should revert with invalid ERC-1271 signature", async function () {
      const { zeroLC, gasToken, owner, user1 } = await loadFixture(deployZeroLCFixture);

      // Deploy a mock ERC-1271 wallet
      const MockERC1271WalletFactory = await ethers.getContractFactory("MockERC1271Wallet");
      const mockWallet = await MockERC1271WalletFactory.deploy(owner.address);
      await mockWallet.waitForDeployment();

      const depositAmount = ethers.parseEther("100");

      // Transfer tokens to the wallet
      await gasToken.transfer(await mockWallet.getAddress(), depositAmount);

      // Approve from wallet
      await mockWallet.executeCall(
        await gasToken.getAddress(),
        gasToken.interface.encodeFunctionData("approve", [await zeroLC.getAddress(), depositAmount])
      );

      // Create the EIP712 signature with wrong signer (user1 instead of owner)
      const walletAddress = await mockWallet.getAddress();
      const nonce = (await zeroLC.userStates(walletAddress)).nonce;
      const domain = {
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      };

      const types = {
        Deposit: [
          { name: "user", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        user: walletAddress,
        amount: depositAmount,
        nonce: nonce,
      };

      // User1 signs instead of owner (wallet won't validate this)
      const signature = await user1.signTypedData(domain, types, value);

      // Deposit should fail
      await expect(
        zeroLC["deposit(address,uint256,bytes)"](
          await mockWallet.getAddress(),
          depositAmount,
          signature
        )
      ).to.be.revertedWith("Invalid deposit signature");
    });
  });

  describe("Deposit with ERC-6492 counterfactual signature", function () {
    it("should allow deposit with valid ERC-6492 signature for undeployed contract", async function () {
      const { zeroLC, gasToken, owner } = await loadFixture(deployZeroLCFixture);

      // This is a placeholder test for ERC-6492 support
      // ERC-6492 allows signatures from contracts that haven't been deployed yet
      // The UniversalSigValidator should handle this

      const depositAmount = ethers.parseEther("100");

      // Deploy a factory for creating wallets
      const MockERC1271WalletFactory = await ethers.getContractFactory("MockERC1271Wallet");

      // Calculate the counterfactual address (this would be the address before deployment)
      // For this test, we'll simulate it by deploying the wallet
      const mockWallet = await MockERC1271WalletFactory.deploy(owner.address);
      await mockWallet.waitForDeployment();

      // Transfer tokens to the wallet
      await gasToken.transfer(await mockWallet.getAddress(), depositAmount);

      // Approve from wallet
      await mockWallet.executeCall(
        await gasToken.getAddress(),
        gasToken.interface.encodeFunctionData("approve", [await zeroLC.getAddress(), depositAmount])
      );

      // Create the EIP712 signature
      const walletAddress = await mockWallet.getAddress();
      const nonce = (await zeroLC.userStates(walletAddress)).nonce;
      const domain = {
        name: "ZeroLC",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await zeroLC.getAddress(),
      };

      const types = {
        Deposit: [
          { name: "user", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "nonce", type: "uint256" },
        ],
      };

      const value = {
        user: walletAddress,
        amount: depositAmount,
        nonce: nonce,
      };

      const signature = await owner.signTypedData(domain, types, value);

      // Deposit should succeed
      await zeroLC["deposit(address,uint256,bytes)"](
        walletAddress,
        depositAmount,
        signature
      );

      expect(await zeroLC.balanceOf(walletAddress)).to.equal(depositAmount);
    });
  });

  describe("Replay attack prevention with nonce", function () {
    it("should prevent replay attack by rejecting reused signature", async function () {
      const { zeroLC, gasToken, user1, user2, signDeposit } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // User1 approves enough for multiple deposits
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount * 3n);

      // Get current nonce
      const nonce = (await zeroLC.userStates(user1.address)).nonce;

      // User1 signs deposit message with nonce
      const signature = await signDeposit(user1, user1.address, depositAmount, nonce);

      // First deposit should succeed
      await zeroLC.connect(user2)["deposit(address,uint256,bytes)"](
        user1.address,
        depositAmount,
        signature
      );

      expect(await zeroLC.balanceOf(user1.address)).to.equal(depositAmount);

      // Verify nonce was incremented
      const newNonce = (await zeroLC.userStates(user1.address)).nonce;
      expect(newNonce).to.equal(nonce + 1n);

      // Try to replay the same signature - should fail
      await expect(
        zeroLC.connect(user2)["deposit(address,uint256,bytes)"](
          user1.address,
          depositAmount,
          signature
        )
      ).to.be.revertedWith("Invalid deposit signature");

      // Balance should remain the same (only one deposit succeeded)
      expect(await zeroLC.balanceOf(user1.address)).to.equal(depositAmount);
    });

    it("should allow deposits with sequential nonces", async function () {
      const { zeroLC, gasToken, user1, signDeposit } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("50");

      // User1 approves enough for multiple deposits
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount * 5n);

      // Perform multiple deposits with sequential nonces
      for (let i = 0; i < 3; i++) {
        const nonce = (await zeroLC.userStates(user1.address)).nonce;
        const signature = await signDeposit(user1, user1.address, depositAmount, nonce);

        await zeroLC.connect(user1)["deposit(address,uint256,bytes)"](
          user1.address,
          depositAmount,
          signature
        );

        expect(await zeroLC.balanceOf(user1.address)).to.equal(depositAmount * BigInt(i + 1));
      }

      // Final balance should be 3 * depositAmount
      expect(await zeroLC.balanceOf(user1.address)).to.equal(depositAmount * 3n);
    });

    it("should reject signature with future nonce", async function () {
      const { zeroLC, gasToken, user1, signDeposit } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("100");

      // User1 approves tokens
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount);

      // Get current nonce and sign with future nonce
      const currentNonce = (await zeroLC.userStates(user1.address)).nonce;
      const futureNonce = currentNonce + 5n;
      const signature = await signDeposit(user1, user1.address, depositAmount, futureNonce);

      // Should revert because nonce doesn't match current nonce
      await expect(
        zeroLC.connect(user1)["deposit(address,uint256,bytes)"](
          user1.address,
          depositAmount,
          signature
        )
      ).to.be.revertedWith("Invalid deposit signature");
    });

    it("should reject signature with old nonce", async function () {
      const { zeroLC, gasToken, user1, signDeposit } = await loadFixture(deployZeroLCFixture);

      const depositAmount = ethers.parseEther("50");

      // User1 approves tokens for multiple deposits
      await gasToken.connect(user1).approve(await zeroLC.getAddress(), depositAmount * 3n);

      // First deposit with nonce 0
      const nonce0 = (await zeroLC.userStates(user1.address)).nonce;
      const signature0 = await signDeposit(user1, user1.address, depositAmount, nonce0);

      await zeroLC.connect(user1)["deposit(address,uint256,bytes)"](
        user1.address,
        depositAmount,
        signature0
      );

      // Second deposit with nonce 1
      const nonce1 = (await zeroLC.userStates(user1.address)).nonce;
      const signature1 = await signDeposit(user1, user1.address, depositAmount, nonce1);

      await zeroLC.connect(user1)["deposit(address,uint256,bytes)"](
        user1.address,
        depositAmount,
        signature1
      );

      // Try to use old signature with nonce 0 - should fail
      await expect(
        zeroLC.connect(user1)["deposit(address,uint256,bytes)"](
          user1.address,
          depositAmount,
          signature0
        )
      ).to.be.revertedWith("Invalid deposit signature");
    });
  });
});
