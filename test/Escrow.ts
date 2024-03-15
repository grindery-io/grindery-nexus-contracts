import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers, deployments } from "hardhat";
import { Escrow, EscrowFactory } from "../typechain-types";
import { assert } from "ethers";

enum CloseReason {
  Release,
  ReleaseExpired,
  Refund,
  AdminRelease,
  AdminRefund,
}

describe("Escrow", function () {
  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  async function deployFixture() {
    await deployments.fixture();
    // Contracts are deployed using the first signer/account by default
    const [owner, sender, beneficiary, otherUser] = await ethers.getSigners();

    const TestERC20 = await ethers.getContractFactory("TestERC20");
    const testErc20 = await TestERC20.deploy(10000000n);

    const Escrow = await ethers.getContractFactory("Escrow");
    const escrowImpl = await Escrow.deploy();

    const EscrowFactory = await ethers.getContractFactory("EscrowFactory");
    const escrowFactory = await EscrowFactory.deploy(escrowImpl.getAddress());

    await testErc20
      .connect(owner)
      .transfer(sender, 10000n)
      .then((x) => x.wait());

    const salt = ethers.hexlify(ethers.randomBytes(32));
    const escrowAddress = await escrowFactory.getEscrowAddress(salt);
    const holdSeconds = 3600;
    const holdDeadline = BigInt(Math.floor(Date.now() / 1000) + holdSeconds);
    const escrow = Escrow.attach(escrowAddress) as Escrow;
    return {
      owner,
      sender,
      beneficiary,
      otherUser,
      TestERC20,
      testErc20,
      Escrow,
      EscrowFactory,
      escrowFactory,
      salt,
      escrowAddress,
      holdSeconds,
      holdDeadline,
      escrow,
    };
  }

  describe("Escrow", function () {
    it("Should handle normal escrow flow", async function () {
      const { testErc20, escrowFactory, owner, sender, beneficiary, escrow, escrowAddress, salt, holdDeadline } =
        await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline))
        .to.emit(escrow, "Open")
        .withArgs(await testErc20.getAddress(), sender, beneficiary, 111n, holdDeadline);
      expect(await testErc20.balanceOf(escrowAddress)).to.equal(111n);
      expect(await escrow._sender()).to.be.equal(sender);
      expect(await escrow._beneficiary()).to.be.equal(beneficiary);
      await expect(escrow.connect(sender).release())
        .to.emit(escrow, "Close")
        .withArgs(sender, beneficiary, 111n, BigInt(CloseReason.Release))
        .and.to.emit(testErc20, "Transfer")
        .withArgs(escrowAddress, beneficiary, 111n);
    });
    it("Should revert when sender doesn't have any fund", async function () {
      const { testErc20, escrowFactory, owner, sender, beneficiary, escrow, salt, holdDeadline } = await loadFixture(
        deployFixture
      );

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.be.revertedWithCustomError(escrow, "NoApprovedFundFromSender");
    });
    it("Should revert when holdDeadline is not in the future", async function () {
      const { testErc20, escrowFactory, owner, sender, beneficiary, escrow, salt, holdDeadline } = await loadFixture(
        deployFixture
      );

      await expect(
        escrowFactory.createEscrow(
          salt,
          testErc20.getAddress(),
          sender,
          beneficiary,
          owner,
          Math.floor(Date.now() / 1000 - 1)
        )
      ).to.be.revertedWithCustomError(escrow, "HoldDeadlineMustBeInFuture");
      await expect(
        escrowFactory.createEscrow(
          salt,
          testErc20.getAddress(),
          sender,
          beneficiary,
          owner,
          Math.floor(Date.now() / 1000)
        )
      ).to.be.revertedWithCustomError(escrow, "HoldDeadlineMustBeInFuture");
    });
    it("Should not release fund when called by incorrect wallet", async function () {
      const {
        testErc20,
        escrowFactory,
        owner,
        sender,
        beneficiary,
        otherUser,
        escrow,
        escrowAddress,
        salt,
        holdDeadline,
      } = await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.emit(escrow, "Open");

      await expect(escrow.connect(owner).release()).to.be.revertedWithCustomError(
        escrow,
        "OnlySenderCanReleaseWithinHoldingPeriod"
      );
      await expect(escrow.connect(beneficiary).release()).to.be.revertedWithCustomError(
        escrow,
        "OnlySenderCanReleaseWithinHoldingPeriod"
      );
      await expect(escrow.connect(otherUser).release()).to.be.revertedWithCustomError(
        escrow,
        "OnlySenderCanReleaseWithinHoldingPeriod"
      );
    });
    it("Should only allow one release call", async function () {
      const { testErc20, escrowFactory, owner, sender, beneficiary, escrow, escrowAddress, salt, holdDeadline } =
        await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.emit(escrow, "Open");

      await expect(escrow.connect(sender).release()).to.emit(escrow, "Close");
      await expect(escrow.connect(sender).release()).to.be.revertedWithCustomError(escrow, "InvalidState");
    });
    it("Should only allow beneficiary to release fund after hold time", async function () {
      const { testErc20, escrowFactory, owner, sender, beneficiary, escrow, escrowAddress, salt, holdDeadline } =
        await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.emit(escrow, "Open");

      await time.increaseTo(holdDeadline - 1n);
      await expect(escrow.connect(beneficiary).release()).to.be.revertedWithCustomError(
        escrow,
        "OnlySenderCanReleaseWithinHoldingPeriod"
      );
      await time.increase(2);
      await expect(escrow.connect(beneficiary).release())
        .to.emit(escrow, "Close")
        .withArgs(sender, beneficiary, 111n, BigInt(CloseReason.ReleaseExpired))
        .and.to.emit(testErc20, "Transfer")
        .withArgs(escrowAddress, beneficiary, 111n);
    });
    it("Should allow beneficiary to trigger a refund", async function () {
      const { testErc20, escrowFactory, owner, sender, beneficiary, escrow, escrowAddress, salt, holdDeadline } =
        await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.emit(escrow, "Open");

      await expect(escrow.connect(beneficiary).refund())
        .to.emit(escrow, "Close")
        .withArgs(sender, beneficiary, 111n, BigInt(CloseReason.Refund))
        .and.to.emit(testErc20, "Transfer")
        .withArgs(escrowAddress, sender, 111n);
    });
    it("Should allow beneficiary to trigger a refund even after holding period", async function () {
      const { testErc20, escrowFactory, owner, sender, beneficiary, escrow, escrowAddress, salt, holdDeadline } =
        await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.emit(escrow, "Open");

      await time.increaseTo(holdDeadline + 1n);
      await expect(escrow.connect(beneficiary).refund())
        .to.emit(escrow, "Close")
        .withArgs(sender, beneficiary, 111n, BigInt(CloseReason.Refund))
        .and.to.emit(testErc20, "Transfer")
        .withArgs(escrowAddress, sender, 111n);
    });
    it("Should not allow anybody else to trigger refund", async function () {
      const {
        testErc20,
        escrowFactory,
        owner,
        sender,
        beneficiary,
        otherUser,
        escrow,
        escrowAddress,
        salt,
        holdDeadline,
      } = await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.emit(escrow, "Open");

      await expect(escrow.connect(owner).refund()).to.be.revertedWithCustomError(
        escrow,
        "OnlyBeneficiaryCanTriggerRefund"
      );
      await expect(escrow.connect(sender).refund()).to.be.revertedWithCustomError(
        escrow,
        "OnlyBeneficiaryCanTriggerRefund"
      );
      await expect(escrow.connect(otherUser).refund()).to.be.revertedWithCustomError(
        escrow,
        "OnlyBeneficiaryCanTriggerRefund"
      );
      await time.increaseTo(holdDeadline + 1n);
      await expect(escrow.connect(owner).refund()).to.be.revertedWithCustomError(
        escrow,
        "OnlyBeneficiaryCanTriggerRefund"
      );
      await expect(escrow.connect(sender).refund()).to.be.revertedWithCustomError(
        escrow,
        "OnlyBeneficiaryCanTriggerRefund"
      );
      await expect(escrow.connect(otherUser).refund()).to.be.revertedWithCustomError(
        escrow,
        "OnlyBeneficiaryCanTriggerRefund"
      );
    });
    it("Should not allow beneficiary to trigger refund after the fund has been released", async function () {
      const { testErc20, escrowFactory, owner, sender, beneficiary, escrow, escrowAddress, salt, holdDeadline } =
        await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.emit(escrow, "Open");

      await expect(escrow.connect(sender).release()).to.emit(escrow, "Close");
      await expect(escrow.connect(beneficiary).refund()).to.be.revertedWithCustomError(escrow, "InvalidState");
    });
    it("Should allow only sender to dispute", async function () {
      const {
        testErc20,
        escrowFactory,
        owner,
        sender,
        beneficiary,
        otherUser,
        escrow,
        escrowAddress,
        salt,
        holdDeadline,
      } = await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.emit(escrow, "Open");

      await expect(escrow.connect(beneficiary).dispute()).to.be.revertedWithCustomError(escrow, "OnlySenderCanDispute");
      await expect(escrow.connect(owner).dispute()).to.be.revertedWithCustomError(escrow, "OnlySenderCanDispute");
      await expect(escrow.connect(otherUser).dispute()).to.be.revertedWithCustomError(escrow, "OnlySenderCanDispute");
      await expect(escrow.connect(sender).dispute()).to.emit(escrow, "Dispute").withArgs(sender, beneficiary);
    });
    it("Should allow only one call to dispute", async function () {
      const { testErc20, escrowFactory, owner, sender, beneficiary, escrow, escrowAddress, salt, holdDeadline } =
        await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.emit(escrow, "Open");

      await expect(escrow.connect(sender).dispute()).to.emit(escrow, "Dispute").withArgs(sender, beneficiary);
      await expect(escrow.connect(sender).dispute()).to.be.revertedWithCustomError(escrow, "InvalidState");
    });
    it("Should disable normal release and refund when disputing", async function () {
      const { testErc20, escrowFactory, owner, sender, beneficiary, escrow, escrowAddress, salt, holdDeadline } =
        await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.emit(escrow, "Open");

      await expect(escrow.connect(sender).dispute()).to.emit(escrow, "Dispute").withArgs(sender, beneficiary);
      await expect(escrow.connect(sender).release()).to.be.revertedWithCustomError(escrow, "InvalidState");
      await expect(escrow.connect(beneficiary).refund()).to.be.revertedWithCustomError(escrow, "InvalidState");
      await time.increaseTo(holdDeadline + 1n);
      await expect(escrow.connect(sender).release()).to.be.revertedWithCustomError(escrow, "InvalidState");
      await expect(escrow.connect(beneficiary).refund()).to.be.revertedWithCustomError(escrow, "InvalidState");
    });
    it("Should not allow admin to resolve dispute when the escrow is not being disputed", async function () {
      const { testErc20, escrowFactory, owner, sender, beneficiary, escrow, escrowAddress, salt, holdDeadline } =
        await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.emit(escrow, "Open");

      await expect(escrow.connect(owner).resolveDispute(sender)).to.be.revertedWithCustomError(escrow, "InvalidState");
      await expect(escrow.connect(owner).resolveDispute(beneficiary)).to.be.revertedWithCustomError(
        escrow,
        "InvalidState"
      );
      await time.increaseTo(holdDeadline + 1n);
      await expect(escrow.connect(owner).resolveDispute(sender)).to.be.revertedWithCustomError(escrow, "InvalidState");
      await expect(escrow.connect(owner).resolveDispute(beneficiary)).to.be.revertedWithCustomError(
        escrow,
        "InvalidState"
      );
      await expect(escrow.connect(sender).release()).to.emit(escrow, "Close");
      await expect(escrow.connect(owner).resolveDispute(sender)).to.be.revertedWithCustomError(escrow, "InvalidState");
      await expect(escrow.connect(owner).resolveDispute(beneficiary)).to.be.revertedWithCustomError(
        escrow,
        "InvalidState"
      );
    });
    it("Should not allow anyone other than admin to resolve dispute", async function () {
      const {
        testErc20,
        escrowFactory,
        owner,
        sender,
        beneficiary,
        otherUser,
        escrow,
        escrowAddress,
        salt,
        holdDeadline,
      } = await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.emit(escrow, "Open");

      await expect(escrow.connect(sender).dispute()).to.emit(escrow, "Dispute").withArgs(sender, beneficiary);
      await expect(escrow.connect(sender).resolveDispute(sender)).to.be.revertedWithCustomError(
        escrow,
        "OnlyAdminCanResolveDispute"
      );
      await expect(escrow.connect(beneficiary).resolveDispute(beneficiary)).to.be.revertedWithCustomError(
        escrow,
        "OnlyAdminCanResolveDispute"
      );
      await expect(escrow.connect(otherUser).resolveDispute(sender)).to.be.revertedWithCustomError(
        escrow,
        "OnlyAdminCanResolveDispute"
      );
      await expect(escrow.connect(otherUser).resolveDispute(beneficiary)).to.be.revertedWithCustomError(
        escrow,
        "OnlyAdminCanResolveDispute"
      );
    });
    it("Should allow admin to resolve dispute by releasing the fund", async function () {
      const { testErc20, escrowFactory, owner, sender, beneficiary, escrow, escrowAddress, salt, holdDeadline } =
        await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.emit(escrow, "Open");

      await expect(escrow.connect(sender).dispute()).to.emit(escrow, "Dispute").withArgs(sender, beneficiary);
      await expect(escrow.connect(owner).resolveDispute(beneficiary))
        .to.emit(escrow, "Close")
        .withArgs(sender, beneficiary, 111n, BigInt(CloseReason.AdminRelease))
        .and.to.emit(testErc20, "Transfer")
        .withArgs(escrowAddress, beneficiary, 111n);
    });
    it("Should allow admin to resolve dispute by refunding sender", async function () {
      const { testErc20, escrowFactory, owner, sender, beneficiary, escrow, escrowAddress, salt, holdDeadline } =
        await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.emit(escrow, "Open");

      await expect(escrow.connect(sender).dispute()).to.emit(escrow, "Dispute").withArgs(sender, beneficiary);
      await expect(escrow.connect(owner).resolveDispute(sender))
        .to.emit(escrow, "Close")
        .withArgs(sender, beneficiary, 111n, BigInt(CloseReason.AdminRefund))
        .and.to.emit(testErc20, "Transfer")
        .withArgs(escrowAddress, sender, 111n);
    });
    it("Should not allow admin resolve dispute by sending fund to elsewhere", async function () {
      const {
        testErc20,
        escrowFactory,
        owner,
        sender,
        beneficiary,
        otherUser,
        escrow,
        escrowAddress,
        salt,
        holdDeadline,
      } = await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.emit(escrow, "Open");

      await expect(escrow.connect(sender).dispute()).to.emit(escrow, "Dispute").withArgs(sender, beneficiary);
      await expect(escrow.connect(owner).resolveDispute(owner)).to.be.revertedWithCustomError(
        escrow,
        "OnlyPossibleToTransferToSenderOrBeneficiary"
      );
      await expect(escrow.connect(owner).resolveDispute(otherUser)).to.be.revertedWithCustomError(
        escrow,
        "OnlyPossibleToTransferToSenderOrBeneficiary"
      );
    });
    it("Should only allow resolving dispute once", async function () {
      const { testErc20, escrowFactory, owner, sender, beneficiary, escrow, escrowAddress, salt, holdDeadline } =
        await loadFixture(deployFixture);

      await testErc20
        .connect(sender)
        .approve(escrowAddress, 111n)
        .then((x) => x.wait());

      await expect(
        escrowFactory.createEscrow(salt, testErc20.getAddress(), sender, beneficiary, owner, holdDeadline)
      ).to.emit(escrow, "Open");

      await expect(escrow.connect(sender).dispute()).to.emit(escrow, "Dispute").withArgs(sender, beneficiary);
      await expect(escrow.connect(owner).resolveDispute(beneficiary)).to.emit(escrow, "Close");
      await expect(escrow.connect(owner).resolveDispute(beneficiary)).to.be.revertedWithCustomError(
        escrow,
        "InvalidState"
      );
      await expect(escrow.connect(owner).resolveDispute(sender)).to.be.revertedWithCustomError(escrow, "InvalidState");
    });
  });
  describe("EscrowByDelegateCall", function () {
    it("Should work", async function () {
      const { testErc20, escrowFactory, owner, beneficiary, Escrow, holdDeadline } = await loadFixture(deployFixture);

      const TestProxy = await ethers.getContractFactory("TestProxy");
      const testProxy = await TestProxy.deploy(escrowFactory.getAddress());

      const sender = await testProxy.getAddress();
      await testErc20
        .connect(owner)
        .transfer(sender, 111n)
        .then((x) => x.wait());

      const receipt = await (escrowFactory.attach(sender) as EscrowFactory)
        .createEscrowByDelegateCall(testErc20.getAddress(), 111n, beneficiary, owner, holdDeadline)
        .then((x) => x.wait());
      const fragment = Escrow.attach(sender).getEvent("Open").fragment;
      const event = receipt?.logs.find((x) => x.topics[0] === fragment.topicHash);
      const escrowAddress = event?.address!;
      const escrow = Escrow.attach(escrowAddress) as Escrow;
      expect(event).to.satisfies((x: any) => !!x);
      const log = escrow.interface.decodeEventLog(fragment, event?.data!, event?.topics!);
      expect(log).to.eql([await testErc20.getAddress(), sender, await beneficiary.getAddress(), 111n, holdDeadline]);
      expect(await testErc20.balanceOf(escrowAddress)).to.equal(111n);
      expect(await escrow._sender()).to.be.equal(sender);
      expect(await escrow._beneficiary()).to.be.equal(beneficiary);
    });
  });
});
