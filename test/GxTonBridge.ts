import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, deployments, network } from "hardhat";
import { BaseGasTank__factory, FeeAccountantPrimary__factory, GxTonBridge__factory } from "../typechain-types";

describe("GxTonBridge", function () {
  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  async function deployFixture() {
    // Contracts are deployed using the first signer/account by default
    const [owner, walletUser, walletUser2, operator] = await ethers.getSigners();

    await network.provider.send("hardhat_reset");

    const TestERC20 = await ethers.getContractFactory("TestERC20");
    const testErc20 = await TestERC20.deploy(ethers.parseEther("10000"));

    network.config.gxTokenAddress = (await testErc20.getAddress()) as any;
    network.config.gxTonBridgeOperator = (await operator.getAddress()) as any;
    await deployments.fixture();

    const GxTonBridge = await deployments.get("GxTonBridge");
    const gxTonBridge = GxTonBridge__factory.connect(GxTonBridge.address, owner);

    const SampleSmartWallet = await ethers.getContractFactory("SampleSmartWallet");
    const sampleSmartWallet = await SampleSmartWallet.deploy();

    await testErc20
      .connect(owner)
      .transfer(sampleSmartWallet.getAddress(), ethers.parseEther("100"))
      .then((x) => x.wait());

    return {
      owner,
      walletUser,
      walletUser2,
      operator,
      TestERC20,
      testErc20,
      sampleSmartWallet,
      GxTonBridge,
      gxTonBridge,
    };
  }
  describe("Bridge out", function () {
    it("Should allow bridge out", async function () {
      const { owner, walletUser, gxTonBridge, testErc20 } = await loadFixture(deployFixture);
      expect(await testErc20.balanceOf(gxTonBridge.getAddress())).to.equal(0n);
      await testErc20
        .connect(owner)
        .transfer(walletUser.getAddress(), ethers.parseEther("100"))
        .then((x) => x.wait());
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(ethers.parseEther("100"));

      await testErc20
        .connect(walletUser)
        .approve(gxTonBridge.getAddress(), ethers.parseEther("100"))
        .then((x) => x.wait());
      await expect(
        gxTonBridge.connect(walletUser).bridgeToTon(ethers.parseEther("100"), 0n, ethers.keccak256("0xdeadbeef"))
      )
        .to.emit(gxTonBridge, "BridgeToTon")
        .withArgs(walletUser.getAddress(), ethers.parseEther("100"), 0n, ethers.keccak256("0xdeadbeef"));
      expect(await testErc20.balanceOf(gxTonBridge.getAddress())).to.equal(ethers.parseEther("100"));
    });
    it("Should revert when balance is not enough", async function () {
      const { owner, walletUser, gxTonBridge, testErc20 } = await loadFixture(deployFixture);
      expect(await testErc20.balanceOf(gxTonBridge.getAddress())).to.equal(0n);
      await testErc20
        .connect(owner)
        .transfer(walletUser.getAddress(), ethers.parseEther("50"))
        .then((x) => x.wait());
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(ethers.parseEther("50"));

      await testErc20
        .connect(walletUser)
        .approve(gxTonBridge.getAddress(), ethers.parseEther("100"))
        .then((x) => x.wait());
      await expect(
        gxTonBridge.connect(walletUser).bridgeToTon(ethers.parseEther("100"), 0n, ethers.keccak256("0xdeadbeef"))
      ).to.be.reverted;
      expect(await testErc20.balanceOf(gxTonBridge.getAddress())).to.equal(ethers.parseEther("0"));
    });
    it("Should revert when balance is enough but approval is not enough", async function () {
      const { owner, walletUser, gxTonBridge, testErc20 } = await loadFixture(deployFixture);
      expect(await testErc20.balanceOf(gxTonBridge.getAddress())).to.equal(0n);
      await testErc20
        .connect(owner)
        .transfer(walletUser.getAddress(), ethers.parseEther("100"))
        .then((x) => x.wait());
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(ethers.parseEther("100"));

      await testErc20
        .connect(walletUser)
        .approve(gxTonBridge.getAddress(), ethers.parseEther("50"))
        .then((x) => x.wait());
      await expect(
        gxTonBridge.connect(walletUser).bridgeToTon(ethers.parseEther("100"), 0n, ethers.keccak256("0xdeadbeef"))
      ).to.be.reverted;
      expect(await testErc20.balanceOf(gxTonBridge.getAddress())).to.equal(ethers.parseEther("0"));
    });
    it("Should ignore plain transfer", async function () {
      const { owner, walletUser, gxTonBridge, testErc20 } = await loadFixture(deployFixture);
      expect(await testErc20.balanceOf(gxTonBridge.getAddress())).to.equal(0n);
      await testErc20
        .connect(owner)
        .transfer(walletUser.getAddress(), ethers.parseEther("100"))
        .then((x) => x.wait());
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(ethers.parseEther("100"));

      await expect(
        testErc20.connect(walletUser).transfer(gxTonBridge.getAddress(), ethers.parseEther("100"))
      ).to.not.emit(gxTonBridge, "BridgeToTon");
      expect(await testErc20.balanceOf(gxTonBridge.getAddress())).to.equal(ethers.parseEther("100"));
    });
  });

  describe("Bridge in", function () {
    it("Should release fund when receiving bridge in request", async function () {
      const { owner, walletUser, operator, gxTonBridge, testErc20 } = await loadFixture(deployFixture);
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(0n);
      await testErc20
        .connect(owner)
        .transfer(gxTonBridge.getAddress(), ethers.parseEther("100"))
        .then((x) => x.wait());
      expect(await testErc20.balanceOf(gxTonBridge.getAddress())).to.equal(ethers.parseEther("100"));

      const nonce = await gxTonBridge.nextNonce();
      const tonWorkchainId = 0n;
      const tonAccountId = ethers.keccak256("0xdead");
      const transactionHash = ethers.keccak256("0xbeef");
      const amount = ethers.parseEther("100");
      const destination = await walletUser.getAddress();
      await expect(
        gxTonBridge
          .connect(operator)
          .onBridgeFromTon(
            transactionHash,
            tonWorkchainId,
            tonAccountId,
            amount,
            destination,
            nonce,
            await operator.signMessage(
              ethers.getBytes(
                ethers.solidityPackedKeccak256(
                  ["bytes32", "bytes32", "int32", "bytes32", "uint256", "address", "uint256"],
                  [
                    ethers.keccak256(ethers.toUtf8Bytes("GX_TON_BRIDGE_IN")),
                    transactionHash,
                    tonWorkchainId,
                    tonAccountId,
                    amount,
                    destination,
                    nonce,
                  ]
                )
              )
            )
          )
      )
        .to.emit(gxTonBridge, "BridgeFromTon")
        .withArgs(transactionHash, tonWorkchainId, tonAccountId, amount, destination, nonce)
        .and.to.emit(testErc20, "Transfer")
        .withArgs(gxTonBridge.getAddress(), destination, amount);
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(ethers.parseEther("100"));
    });
    it("Should reject request with invalid signer", async function () {
      const { owner, walletUser, operator, gxTonBridge, testErc20 } = await loadFixture(deployFixture);
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(0n);
      await testErc20
        .connect(owner)
        .transfer(gxTonBridge.getAddress(), ethers.parseEther("100"))
        .then((x) => x.wait());
      expect(await testErc20.balanceOf(gxTonBridge.getAddress())).to.equal(ethers.parseEther("100"));

      const nonce = await gxTonBridge.nextNonce();
      const tonWorkchainId = 0n;
      const tonAccountId = ethers.keccak256("0xdead");
      const transactionHash = ethers.keccak256("0xbeef");
      const amount = ethers.parseEther("100");
      const destination = await walletUser.getAddress();
      await expect(
        gxTonBridge
          .connect(operator)
          .onBridgeFromTon(
            transactionHash,
            tonWorkchainId,
            tonAccountId,
            amount,
            destination,
            nonce,
            await walletUser.signMessage(
              ethers.getBytes(
                ethers.solidityPackedKeccak256(
                  ["bytes32", "bytes32", "int32", "bytes32", "uint256", "address", "uint256"],
                  [
                    ethers.keccak256(ethers.toUtf8Bytes("GX_TON_BRIDGE_IN")),
                    transactionHash,
                    tonWorkchainId,
                    tonAccountId,
                    amount,
                    destination,
                    nonce,
                  ]
                )
              )
            )
          )
      ).to.be.revertedWithCustomError(gxTonBridge, "InvalidSignature");
    });
    it("Should reject request with invalid nonce", async function () {
      const { owner, walletUser, operator, gxTonBridge, testErc20 } = await loadFixture(deployFixture);
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(0n);
      await testErc20
        .connect(owner)
        .transfer(gxTonBridge.getAddress(), ethers.parseEther("100"))
        .then((x) => x.wait());
      expect(await testErc20.balanceOf(gxTonBridge.getAddress())).to.equal(ethers.parseEther("100"));

      const nonce = 42n;
      const tonWorkchainId = 0n;
      const tonAccountId = ethers.keccak256("0xdead");
      const transactionHash = ethers.keccak256("0xbeef");
      const amount = ethers.parseEther("100");
      const destination = await walletUser.getAddress();
      await expect(
        gxTonBridge
          .connect(operator)
          .onBridgeFromTon(
            transactionHash,
            tonWorkchainId,
            tonAccountId,
            amount,
            destination,
            nonce,
            await operator.signMessage(
              ethers.getBytes(
                ethers.solidityPackedKeccak256(
                  ["bytes32", "bytes32", "int32", "bytes32", "uint256", "address", "uint256"],
                  [
                    ethers.keccak256(ethers.toUtf8Bytes("GX_TON_BRIDGE_IN")),
                    transactionHash,
                    tonWorkchainId,
                    tonAccountId,
                    amount,
                    destination,
                    nonce,
                  ]
                )
              )
            )
          )
      ).to.be.revertedWithCustomError(gxTonBridge, "InvalidNonce");
    });
    it("Should reject duplicate request", async function () {
      const { owner, walletUser, operator, gxTonBridge, testErc20 } = await loadFixture(deployFixture);
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(0n);
      await testErc20
        .connect(owner)
        .transfer(gxTonBridge.getAddress(), ethers.parseEther("100"))
        .then((x) => x.wait());
      expect(await testErc20.balanceOf(gxTonBridge.getAddress())).to.equal(ethers.parseEther("100"));

      let nonce = await gxTonBridge.nextNonce();
      const tonWorkchainId = 0n;
      const tonAccountId = ethers.keccak256("0xdead");
      const transactionHash = ethers.keccak256("0xbeef");
      const amount = ethers.parseEther("100");
      const destination = await walletUser.getAddress();
      await expect(
        gxTonBridge
          .connect(operator)
          .onBridgeFromTon(
            transactionHash,
            tonWorkchainId,
            tonAccountId,
            amount,
            destination,
            nonce,
            await operator.signMessage(
              ethers.getBytes(
                ethers.solidityPackedKeccak256(
                  ["bytes32", "bytes32", "int32", "bytes32", "uint256", "address", "uint256"],
                  [
                    ethers.keccak256(ethers.toUtf8Bytes("GX_TON_BRIDGE_IN")),
                    transactionHash,
                    tonWorkchainId,
                    tonAccountId,
                    amount,
                    destination,
                    nonce,
                  ]
                )
              )
            )
          )
      )
        .to.emit(gxTonBridge, "BridgeFromTon")
        .withArgs(transactionHash, tonWorkchainId, tonAccountId, amount, destination, nonce)
        .and.to.emit(testErc20, "Transfer")
        .withArgs(gxTonBridge.getAddress(), destination, amount);
      nonce = await gxTonBridge.nextNonce();
      await expect(
        gxTonBridge
          .connect(operator)
          .onBridgeFromTon(
            transactionHash,
            tonWorkchainId,
            tonAccountId,
            amount,
            destination,
            nonce,
            await operator.signMessage(
              ethers.getBytes(
                ethers.solidityPackedKeccak256(
                  ["bytes32", "bytes32", "int32", "bytes32", "uint256", "address", "uint256"],
                  [
                    ethers.keccak256(ethers.toUtf8Bytes("GX_TON_BRIDGE_IN")),
                    transactionHash,
                    tonWorkchainId,
                    tonAccountId,
                    amount,
                    destination,
                    nonce,
                  ]
                )
              )
            )
          )
      ).to.be.revertedWithCustomError(gxTonBridge, "TransactionAlreadyClaimed");
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(ethers.parseEther("100"));
    });
  });
});
