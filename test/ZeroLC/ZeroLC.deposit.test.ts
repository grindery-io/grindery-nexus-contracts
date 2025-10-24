import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { ZeroLC, TestERC20, UniversalSigValidator } from "../../typechain-types";

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
