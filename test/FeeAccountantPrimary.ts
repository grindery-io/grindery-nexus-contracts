import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, deployments, network } from "hardhat";
import { BaseGasTank__factory, FeeAccountantPrimary__factory } from "../typechain-types";

describe("FeeAccountantPrimary", function () {
  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  async function deployFixture() {
    // Contracts are deployed using the first signer/account by default
    const [owner, walletUser, walletUser2, operator] = await ethers.getSigners();

    await network.provider.send("hardhat_reset");

    const TestERC20 = await ethers.getContractFactory("TestERC20");
    const testErc20 = await TestERC20.deploy(ethers.parseEther("10000"));

    await testErc20
      .connect(owner)
      .transfer(walletUser, ethers.parseEther("100"))
      .then((x) => x.wait());

    network.config.gasTokenAddress = (await testErc20.getAddress()) as any;
    await deployments.fixture();

    const GasTank = await deployments.get("GasTank");
    const gasTank = BaseGasTank__factory.connect(GasTank.address, owner);

    const FeeAccountantPrimary = await deployments.get("FeeAccountantPrimary");
    const feeAccountantPrimary = FeeAccountantPrimary__factory.connect(FeeAccountantPrimary.address, owner);

    await feeAccountantPrimary
      .grantRole(await feeAccountantPrimary.ROLE_OPERATOR(), operator.getAddress())
      .then((x) => x.wait());

    const MockV3Aggregator = await ethers.getContractFactory("MockV3Aggregator");
    const priceFeedLocal = await MockV3Aggregator.deploy(8, 1n * 10n ** 8n);
    const CHAIN_ID = await owner.provider.getNetwork().then((x) => x.chainId);
    await feeAccountantPrimary.setPriceFeed(CHAIN_ID, priceFeedLocal.getAddress()).then((x) => x.wait());
    await feeAccountantPrimary.setPriceFeed(0, priceFeedLocal.getAddress()).then((x) => x.wait());

    const priceFeedDefaultForeign = await MockV3Aggregator.deploy(8, 1n * 10n ** 8n);
    await feeAccountantPrimary.setPriceFeed(1, priceFeedDefaultForeign.getAddress()).then((x) => x.wait());

    const priceFeedDefaultForeign2x = await MockV3Aggregator.deploy(8, 2n * 10n ** 8n);
    await feeAccountantPrimary
      .connect(owner)
      .setPriceFeed(2, priceFeedDefaultForeign2x.getAddress())
      .then((x) => x.wait());

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
      gasTank,
      feeAccountantPrimary,
      priceFeedLocal,
      priceFeedDefaultForeign,
      priceFeedDefaultForeign2x,
      sampleSmartWallet,
      CHAIN_ID,
    };
  }
  const SAMPLE_FEE = 236725n * ethers.parseUnits("1", "gwei");
  const SAMPLE_TX = "0x4758bef1c726bf9fb60e95808c9fe3e5485ede2304e549bc9f6db229163464b1";

  describe("Fee recording", function () {
    it("Should record fee", async function () {
      const { owner, walletUser, operator, gasTank, feeAccountantPrimary } = await loadFixture(deployFixture);
      let { nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1);
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);
      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 1n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(1n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE, 0n, SAMPLE_FEE, SAMPLE_FEE);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1));
      expect(balance).to.equal(SAMPLE_FEE);
      expect(nonce).to.equal(1n);
    });
    it("Should record fee after applying stage2 rate", async function () {
      const { owner, walletUser, operator, gasTank, feeAccountantPrimary } = await loadFixture(deployFixture);
      await expect(feeAccountantPrimary.setStage2Fee(123n, 3n, 2n))
        .to.emit(feeAccountantPrimary, "Stage2ScaleUpdated")
        .withArgs(3n, 2n);
      let { nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1);
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);
      const SAMPLE_FEE_AFTER_STAGE2 = ((SAMPLE_FEE + 123n) * 3n) / 2n;
      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 1n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(
          1n,
          SAMPLE_TX,
          walletUser.getAddress(),
          SAMPLE_FEE,
          0n,
          SAMPLE_FEE_AFTER_STAGE2,
          SAMPLE_FEE_AFTER_STAGE2
        );
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1));
      expect(balance).to.equal(SAMPLE_FEE_AFTER_STAGE2);
      expect(nonce).to.equal(1n);
    });
    it("Should record fee after applying stage2 rate in a single call", async function () {
      const { owner, walletUser, operator, gasTank, feeAccountantPrimary } = await loadFixture(deployFixture);
      await feeAccountantPrimary.setStage2Fee(123n, 99n, 55n);
      let { nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1);
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);
      const SAMPLE_FEE_AFTER_STAGE2 = ((SAMPLE_FEE + 123n) * 3n) / 2n;
      await expect(
        feeAccountantPrimary.connect(operator).updateStage2ScaleAndCommitFees(
          [
            {
              chainId: 1n,
              wallet: walletUser.getAddress(),
              transaction: SAMPLE_TX,
              nonce: 0,
              fee: SAMPLE_FEE,
            },
          ],
          3n,
          2n
        )
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(
          1n,
          SAMPLE_TX,
          walletUser.getAddress(),
          SAMPLE_FEE,
          0n,
          SAMPLE_FEE_AFTER_STAGE2,
          SAMPLE_FEE_AFTER_STAGE2
        )
        .and.to.emit(feeAccountantPrimary, "Stage2ScaleUpdated")
        .withArgs(3n, 2n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1));
      expect(balance).to.equal(SAMPLE_FEE_AFTER_STAGE2);
      expect(nonce).to.equal(1n);
    });
    it("Should record fee in batch", async function () {
      const { owner, walletUser, walletUser2, operator, gasTank, feeAccountantPrimary } =
        await loadFixture(deployFixture);
      let { nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1);
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser2.getAddress(), 1));
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);
      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 1n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE,
          },
          {
            chainId: 2n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE,
          },
          {
            chainId: 1n,
            wallet: walletUser2.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE,
          },
          {
            chainId: 1n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 1,
            fee: SAMPLE_FEE * 2n,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(1n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE, 0n, SAMPLE_FEE, SAMPLE_FEE)
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(1n, SAMPLE_TX, walletUser2.getAddress(), SAMPLE_FEE, 0n, SAMPLE_FEE, SAMPLE_FEE)
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(2n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE, 0n, SAMPLE_FEE * 2n, SAMPLE_FEE * 3n)
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(1n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE * 2n, 1n, SAMPLE_FEE * 2n, SAMPLE_FEE * 5n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1));
      expect(balance).to.equal(SAMPLE_FEE * 5n);
      expect(nonce).to.equal(2n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(SAMPLE_FEE * 5n);
      expect(nonce).to.equal(1n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser2.getAddress(), 1));
      expect(balance).to.equal(SAMPLE_FEE);
      expect(nonce).to.equal(1n);
    });
    it("Should reject fee record from non-operator", async function () {
      const { owner, walletUser, operator, gasTank, feeAccountantPrimary } = await loadFixture(deployFixture);
      await expect(
        feeAccountantPrimary.connect(walletUser).commitFees([
          {
            chainId: 1,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0n,
            fee: SAMPLE_FEE,
          },
        ])
      ).to.be.revertedWithCustomError(feeAccountantPrimary, "AccessControlUnauthorizedAccount");
      await expect(
        feeAccountantPrimary.connect(owner).commitFees([
          {
            chainId: 1,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0n,
            fee: SAMPLE_FEE,
          },
        ])
      ).to.be.revertedWithCustomError(feeAccountantPrimary, "AccessControlUnauthorizedAccount");
    });
    it("Should not record fee for unknown chain", async function () {
      const { owner, walletUser, operator, gasTank, feeAccountantPrimary } = await loadFixture(deployFixture);
      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 4242,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0n,
            fee: SAMPLE_FEE,
          },
        ])
      ).to.be.revertedWithCustomError(feeAccountantPrimary, "UnsupportedChain");
    });
    it("Should not record fee with invalid nonce", async function () {
      const { owner, walletUser, operator, gasTank, feeAccountantPrimary } = await loadFixture(deployFixture);
      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 1,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 1n,
            fee: SAMPLE_FEE,
          },
        ])
      ).to.be.revertedWithCustomError(feeAccountantPrimary, "InvalidNonce");
    });
    it("Should reject batch fee record in incorrect order", async function () {
      const { owner, walletUser, walletUser2, operator, gasTank, feeAccountantPrimary } =
        await loadFixture(deployFixture);
      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 1n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 1,
            fee: SAMPLE_FEE,
          },
          {
            chainId: 1n,
            wallet: walletUser2.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE,
          },
          {
            chainId: 1n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE * 2n,
          },
        ])
      ).to.be.revertedWithCustomError(feeAccountantPrimary, "InvalidNonce");
    });
    it("Should handle changing price", async function () {
      const { walletUser, operator, feeAccountantPrimary, priceFeedLocal, priceFeedDefaultForeign } =
        await loadFixture(deployFixture);
      let { nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1);
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);
      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 1n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(1n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE, 0n, SAMPLE_FEE, SAMPLE_FEE);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1));
      expect(balance).to.equal(SAMPLE_FEE);
      expect(nonce).to.equal(1n);

      await priceFeedLocal.updateAnswer(2n * 10n ** 8n);

      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 1n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 1,
            fee: SAMPLE_FEE,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(1n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE, 1n, SAMPLE_FEE / 2n, (SAMPLE_FEE * 3n) / 2n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1));
      expect(balance).to.equal((SAMPLE_FEE * 3n) / 2n);
      expect(nonce).to.equal(2n);

      await priceFeedDefaultForeign.updateAnswer(3n * 10n ** 8n);

      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 1n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 2,
            fee: SAMPLE_FEE,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(1n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE, 2n, (SAMPLE_FEE / 2n) * 3n, SAMPLE_FEE * 3n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1));
      expect(balance).to.equal(SAMPLE_FEE * 3n);
      expect(nonce).to.equal(3n);
    });
    it("Should reject obviously incorrect fee", async function () {
      const { owner, walletUser, operator, gasTank, feeAccountantPrimary } = await loadFixture(deployFixture);
      let { nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1);
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);
      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 1n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE * ethers.parseUnits("100", "gwei"),
          },
        ])
      ).to.be.revertedWithCustomError(feeAccountantPrimary, "InsaneFee");
    });
  });
  describe("Fee transfer", function () {
    it("Should transfer fee to gas tank if there is enough approved balance", async function () {
      const { owner, walletUser, operator, gasTank, feeAccountantPrimary, testErc20 } =
        await loadFixture(deployFixture);
      let { nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1);
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);

      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);
      const walletBalance = await testErc20.balanceOf(walletUser.getAddress());
      expect(walletBalance).to.greaterThan(SAMPLE_FEE * 100n);
      await testErc20.connect(walletUser).approve(feeAccountantPrimary.getAddress(), walletBalance);

      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 2n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(2n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE, 0n, SAMPLE_FEE * 2n, 0n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(1n);
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(walletBalance - SAMPLE_FEE * 2n);
      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(SAMPLE_FEE * 2n);

      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 2n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 1,
            fee: SAMPLE_FEE * 2n,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(2n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE * 2n, 1n, SAMPLE_FEE * 4n, 0n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(2n);
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(walletBalance - SAMPLE_FEE * 6n);
      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(SAMPLE_FEE * 6n);
    });
    it("Should allow partial fee transfer", async function () {
      const { owner, walletUser, operator, gasTank, feeAccountantPrimary, testErc20 } =
        await loadFixture(deployFixture);
      let { nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1);
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);

      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);
      const walletBalance = await testErc20.balanceOf(walletUser.getAddress());
      expect(walletBalance).to.greaterThan(SAMPLE_FEE * 100n);
      await testErc20.connect(walletUser).approve(feeAccountantPrimary.getAddress(), SAMPLE_FEE);

      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 2n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(2n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE, 0n, SAMPLE_FEE * 2n, SAMPLE_FEE);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(SAMPLE_FEE);
      expect(nonce).to.equal(1n);
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(walletBalance - SAMPLE_FEE);
      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(SAMPLE_FEE);
    });
    it("Should handle approval without enough balance", async function () {
      const { owner, walletUser, operator, gasTank, feeAccountantPrimary, testErc20 } =
        await loadFixture(deployFixture);
      let { nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1);
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);

      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);
      const walletBalance = await testErc20.balanceOf(walletUser.getAddress());
      expect(walletBalance).to.greaterThan(SAMPLE_FEE * 100n);
      await testErc20.connect(walletUser).approve(feeAccountantPrimary.getAddress(), walletBalance);
      await testErc20.connect(walletUser).transfer(owner.getAddress(), walletBalance - SAMPLE_FEE);

      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 2n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(2n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE, 0n, SAMPLE_FEE * 2n, SAMPLE_FEE);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(SAMPLE_FEE);
      expect(nonce).to.equal(1n);
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(0n);
      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(SAMPLE_FEE);
      expect(await testErc20.allowance(walletUser.getAddress(), feeAccountantPrimary.getAddress())).to.equal(
        walletBalance - SAMPLE_FEE
      );
    });
  });
  describe("Fee payment", function () {
    it("Should allow user to pay fee", async function () {
      const { owner, walletUser, operator, gasTank, feeAccountantPrimary, testErc20, CHAIN_ID } =
        await loadFixture(deployFixture);
      let { nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1);
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);

      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);
      const walletBalance = await testErc20.balanceOf(walletUser.getAddress());
      expect(walletBalance).to.greaterThan(SAMPLE_FEE * 100n);

      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 2n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(2n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE, 0n, SAMPLE_FEE * 2n, SAMPLE_FEE * 2n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(SAMPLE_FEE * 2n);
      expect(nonce).to.equal(1n);
      await testErc20.connect(walletUser).approve(feeAccountantPrimary.getAddress(), walletBalance);
      await expect(feeAccountantPrimary.connect(walletUser).payFee(SAMPLE_FEE * 2n))
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(ethers.MaxUint256, ethers.hexlify(Buffer.alloc(32, 0)), walletUser.getAddress(), 0n, 0n, 0n, 0n);
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(walletBalance - SAMPLE_FEE * 2n);
      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(SAMPLE_FEE * 2n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(1n);
    });
    it("Should allow user to pay fee in partial", async function () {
      const { owner, walletUser, operator, gasTank, feeAccountantPrimary, testErc20, CHAIN_ID } =
        await loadFixture(deployFixture);
      let { nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1);
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);

      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);
      const walletBalance = await testErc20.balanceOf(walletUser.getAddress());
      expect(walletBalance).to.greaterThan(SAMPLE_FEE * 100n);

      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 2n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(2n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE, 0n, SAMPLE_FEE * 2n, SAMPLE_FEE * 2n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(SAMPLE_FEE * 2n);
      expect(nonce).to.equal(1n);
      await testErc20.connect(walletUser).approve(feeAccountantPrimary.getAddress(), walletBalance);

      await expect(feeAccountantPrimary.connect(walletUser).payFee(SAMPLE_FEE))
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(
          ethers.MaxUint256,
          ethers.hexlify(Buffer.alloc(32, 0)),
          walletUser.getAddress(),
          0n,
          0n,
          0n,
          SAMPLE_FEE
        );
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(walletBalance - SAMPLE_FEE);
      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(SAMPLE_FEE);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(SAMPLE_FEE);
      expect(nonce).to.equal(1n);

      await expect(feeAccountantPrimary.connect(walletUser).payFee(SAMPLE_FEE))
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(ethers.MaxUint256, ethers.hexlify(Buffer.alloc(32, 0)), walletUser.getAddress(), 0n, 0n, 0n, 0n);
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(walletBalance - SAMPLE_FEE * 2n);
      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(SAMPLE_FEE * 2n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(1n);
    });
    it("Should allow user to overpay fee", async function () {
      const { owner, walletUser, operator, gasTank, feeAccountantPrimary, testErc20, CHAIN_ID } =
        await loadFixture(deployFixture);
      let { nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1);
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);

      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);
      const walletBalance = await testErc20.balanceOf(walletUser.getAddress());
      expect(walletBalance).to.greaterThan(SAMPLE_FEE * 100n);

      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 2n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(2n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE, 0n, SAMPLE_FEE * 2n, SAMPLE_FEE * 2n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(SAMPLE_FEE * 2n);
      expect(nonce).to.equal(1n);
      await testErc20.connect(walletUser).approve(feeAccountantPrimary.getAddress(), walletBalance);

      await expect(feeAccountantPrimary.connect(walletUser).payFee(SAMPLE_FEE * 4n))
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(
          ethers.MaxUint256,
          ethers.hexlify(Buffer.alloc(32, 0)),
          walletUser.getAddress(),
          0n,
          0n,
          0n,
          SAMPLE_FEE * -2n
        );
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(walletBalance - SAMPLE_FEE * 4n);
      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(SAMPLE_FEE * 4n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(SAMPLE_FEE * -2n);
      expect(nonce).to.equal(1n);
    });
    it("Should allow user to prepay fee", async function () {
      const { owner, walletUser, operator, gasTank, feeAccountantPrimary, testErc20, CHAIN_ID } =
        await loadFixture(deployFixture);
      let { nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1);
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);

      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);
      const walletBalance = await testErc20.balanceOf(walletUser.getAddress());
      expect(walletBalance).to.greaterThan(SAMPLE_FEE * 100n);
      await testErc20.connect(walletUser).approve(feeAccountantPrimary.getAddress(), SAMPLE_FEE * 4n);
      await expect(feeAccountantPrimary.connect(walletUser).payFee(SAMPLE_FEE * 4n))
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(
          ethers.MaxUint256,
          ethers.hexlify(Buffer.alloc(32, 0)),
          walletUser.getAddress(),
          0n,
          0n,
          0n,
          SAMPLE_FEE * -4n
        );
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(walletBalance - SAMPLE_FEE * 4n);
      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(SAMPLE_FEE * 4n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(SAMPLE_FEE * -4n);
      expect(nonce).to.equal(0n);

      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 2n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(2n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE, 0n, SAMPLE_FEE * 2n, SAMPLE_FEE * -2n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(SAMPLE_FEE * -2n);
      expect(nonce).to.equal(1n);

      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 2n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 1,
            fee: SAMPLE_FEE,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(2n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE, 1n, SAMPLE_FEE * 2n, 0n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(2n);
    });
    it("Should allow user to prepay and pay fee in partial", async function () {
      const { owner, walletUser, operator, gasTank, feeAccountantPrimary, testErc20, CHAIN_ID } =
        await loadFixture(deployFixture);
      let { nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1);
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);

      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);
      const walletBalance = await testErc20.balanceOf(walletUser.getAddress());
      expect(walletBalance).to.greaterThan(SAMPLE_FEE * 100n);

      await testErc20.connect(walletUser).approve(feeAccountantPrimary.getAddress(), SAMPLE_FEE * 2n);
      await expect(feeAccountantPrimary.connect(walletUser).payFee(SAMPLE_FEE * 2n))
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(
          ethers.MaxUint256,
          ethers.hexlify(Buffer.alloc(32, 0)),
          walletUser.getAddress(),
          0n,
          0n,
          0n,
          SAMPLE_FEE * -2n
        );
      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(walletBalance - SAMPLE_FEE * 2n);
      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(SAMPLE_FEE * 2n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(SAMPLE_FEE * -2n);
      expect(nonce).to.equal(0n);

      await testErc20.connect(walletUser).approve(feeAccountantPrimary.getAddress(), SAMPLE_FEE);

      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 2n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE * 2n,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(2n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE * 2n, 0n, SAMPLE_FEE * 4n, SAMPLE_FEE);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(SAMPLE_FEE);
      expect(nonce).to.equal(1n);

      expect(await testErc20.balanceOf(walletUser.getAddress())).to.equal(walletBalance - SAMPLE_FEE * 3n);
      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(SAMPLE_FEE * 3n);
    });
    it("Should allow smart wallet to pay fee and pre-approve future fee", async function () {
      const { operator, gasTank, feeAccountantPrimary, testErc20, sampleSmartWallet } =
        await loadFixture(deployFixture);
      let { nonce, balance } = await feeAccountantPrimary.getWalletRecord(sampleSmartWallet.getAddress(), 1);
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);

      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);
      const walletBalance = await testErc20.balanceOf(sampleSmartWallet.getAddress());
      expect(walletBalance).to.greaterThan(SAMPLE_FEE * 100n);

      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 2n,
            wallet: sampleSmartWallet.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(2n, SAMPLE_TX, sampleSmartWallet.getAddress(), SAMPLE_FEE, 0n, SAMPLE_FEE * 2n, SAMPLE_FEE * 2n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(sampleSmartWallet.getAddress(), 2));
      expect(balance).to.equal(SAMPLE_FEE * 2n);
      expect(nonce).to.equal(1n);
      await expect(
        sampleSmartWallet.delegateCall(
          await feeAccountantPrimary.getAddress(),
          feeAccountantPrimary.interface.encodeFunctionData("approveAndPayFee", [SAMPLE_FEE * 2n, SAMPLE_FEE * 10n])
        )
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(
          ethers.MaxUint256,
          ethers.hexlify(Buffer.alloc(32, 0)),
          sampleSmartWallet.getAddress(),
          0n,
          0n,
          0n,
          0n
        );
      expect(await testErc20.balanceOf(sampleSmartWallet.getAddress())).to.equal(walletBalance - SAMPLE_FEE * 2n);
      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(SAMPLE_FEE * 2n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(sampleSmartWallet.getAddress(), 2));
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(1n);

      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 2n,
            wallet: sampleSmartWallet.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 1,
            fee: SAMPLE_FEE,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(2n, SAMPLE_TX, sampleSmartWallet.getAddress(), SAMPLE_FEE, 1n, SAMPLE_FEE * 2n, 0n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(sampleSmartWallet.getAddress(), 2));
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(2n);
    });
    it("Should revert if user does not have enough balance", async function () {
      const { owner, walletUser, operator, gasTank, feeAccountantPrimary, testErc20, CHAIN_ID } =
        await loadFixture(deployFixture);
      let { nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 1);
      expect(balance).to.equal(0n);
      expect(nonce).to.equal(0n);

      expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);
      const walletBalance = await testErc20.balanceOf(walletUser.getAddress());
      expect(walletBalance).to.greaterThan(SAMPLE_FEE * 100n);

      await expect(
        feeAccountantPrimary.connect(operator).commitFees([
          {
            chainId: 2n,
            wallet: walletUser.getAddress(),
            transaction: SAMPLE_TX,
            nonce: 0,
            fee: SAMPLE_FEE,
          },
        ])
      )
        .to.emit(feeAccountantPrimary, "BalanceUpdated")
        .withArgs(2n, SAMPLE_TX, walletUser.getAddress(), SAMPLE_FEE, 0n, SAMPLE_FEE * 2n, SAMPLE_FEE * 2n);
      ({ nonce, balance } = await feeAccountantPrimary.getWalletRecord(walletUser.getAddress(), 2));
      expect(balance).to.equal(SAMPLE_FEE * 2n);
      expect(nonce).to.equal(1n);
      await testErc20.connect(walletUser).approve(feeAccountantPrimary.getAddress(), SAMPLE_FEE);
      await expect(feeAccountantPrimary.connect(walletUser).payFee(SAMPLE_FEE * 2n)).to.be.reverted;
      await testErc20.connect(walletUser).transfer(owner.getAddress(), walletBalance);
      await expect(feeAccountantPrimary.connect(walletUser).payFee(SAMPLE_FEE)).to.be.reverted;
    });
  });
});
