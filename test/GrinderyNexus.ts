import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("GrinderyNexus", function () {
  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  async function deployFixture() {
    // Contracts are deployed using the first signer/account by default
    const [owner, operator, user] = await ethers.getSigners();

    const GrinderyNexusHub = await ethers.getContractFactory("GrinderyNexusHub");
    const GrinderyNexusDrone = await ethers.getContractFactory("GrinderyNexusDrone");
    const TestContract = await ethers.getContractFactory("TestContract");
    const hub = await GrinderyNexusHub.deploy();
    const drone = await GrinderyNexusDrone.deploy(hub.address);
    const testContract = await TestContract.deploy();

    await hub.setOperator(operator.address);
    await hub.setDroneImplementation(drone.address);

    return { hub, drone, owner, operator, user, testContract };
  }

  describe("Deployment", function () {
    it("Should set the right owner", async function () {
      const { hub, owner } = await loadFixture(deployFixture);

      expect(await hub.owner()).to.equal(owner.address);
    });
    it("Should allow setting new operator", async function () {
      const { hub, user } = await loadFixture(deployFixture);

      expect(await hub.setOperator(user.address)).to.emit(hub, "OperatorChanged");
    });
    it("Should reject setting operator from non-owner", async function () {
      const { hub, user } = await loadFixture(deployFixture);

      await expect(hub.connect(user).setOperator(user.address)).to.be.reverted;
    });
    it("Should be able to transfer ownership", async function () {
      const { hub, user } = await loadFixture(deployFixture);
      expect(await hub.transferOwnership(user.address)).to.emit(hub, "OwnershipTransferStarted");
      expect(await hub.pendingOwner()).to.equal(user.address);
      expect(await hub.connect(user).acceptOwnership()).to.emit(hub, "OwnershipTransferred");
      expect(await hub.owner()).to.equal(user.address);
    });
    it("Should revert if malicious user tries to claim pending ownership", async function () {
      const { hub, user, operator } = await loadFixture(deployFixture);
      expect(await hub.transferOwnership(user.address)).to.emit(hub, "OwnershipTransferStarted");
      expect(await hub.pendingOwner()).to.equal(user.address);
      await expect(hub.connect(operator).acceptOwnership()).to.be.reverted;
    });
  });
  describe("Drone", function () {
    it("Should be able to deploy drone", async function () {
      const { hub, operator, user } = await loadFixture(deployFixture);

      const hubOperator = hub.connect(operator);
      const droneAddress = await hubOperator.getUserDroneAddress(user.address);
      expect(await ethers.provider.getCode(droneAddress)).to.equal("0x");
      expect(await hubOperator.deployDrone(user.address))
        .to.emit(hub, "DeployedDrone")
        .withArgs(droneAddress);
      expect(await ethers.provider.getCode(droneAddress)).to.not.equal("0x");
    });
    it("Should be able to deploy drone only once", async function () {
      const { hub, operator, user } = await loadFixture(deployFixture);

      const hubOperator = hub.connect(operator);
      await hubOperator.deployDrone(user.address);
      await expect(hubOperator.deployDrone(user.address)).to.be.reverted;
    });
  });
  describe("Transaction", function () {
    it("Should be able to send transaction", async function () {
      const { hub, operator, user, drone, testContract } = await loadFixture(deployFixture);

      const hubOperator = hub.connect(operator);
      const droneAddress = await hubOperator.getUserDroneAddress(user.address);
      await hubOperator.deployDrone(user.address);
      const droneInstance = drone.attach(droneAddress).connect(operator);

      const callData = testContract.interface.encodeFunctionData("echo", ["0x1"]);
      const nonce = await droneInstance.getNextNonce();
      expect(nonce).to.equal("0x0");
      const transactionHash = await hubOperator.getTransactionHash(droneAddress, testContract.address, nonce, callData);
      const signature = await operator.signMessage(ethers.utils.arrayify(transactionHash));
      await expect(droneInstance.sendTransaction(testContract.address, nonce, callData, signature))
        .to.emit(droneInstance, "TransactionResult")
        .withArgs(
          ethers.utils.keccak256(ethers.utils.arrayify(signature)),
          true,
          "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
      expect(await droneInstance.getNextNonce()).to.equal("0x1");
    });
  });
});
