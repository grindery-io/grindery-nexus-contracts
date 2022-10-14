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
    const [owner, operator, user, user2] = await ethers.getSigners();

    const GrinderyNexusHub = await ethers.getContractFactory("GrinderyNexusHub");
    const GrinderyNexusDrone = await ethers.getContractFactory("GrinderyNexusDrone");
    const TestContract = await ethers.getContractFactory("TestContract");
    const testContract = await TestContract.deploy();

    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const hubImpl = await GrinderyNexusHub.deploy();
    const hubProxy = await ERC1967Proxy.deploy(hubImpl.address, hubImpl.interface.encodeFunctionData("initialize"));
    const hub = hubImpl.attach(hubProxy.address);

    const UpgradeableBeacon = await ethers.getContractFactory("UpgradeableBeacon");
    const StaticBeaconProxy = await ethers.getContractFactory("StaticBeaconProxy");
    const droneImpl = await GrinderyNexusDrone.deploy(hub.address);
    const droneBeacon = await UpgradeableBeacon.deploy(droneImpl.address);
    const droneProxy = await StaticBeaconProxy.deploy(droneBeacon.address);
    const drone = droneImpl.attach(droneProxy.address);

    await hub.setOperator(operator.address);
    await hub.setDroneImplementation(drone.address);

    return { hub, drone, owner, operator, user, user2, testContract };
  }

  describe("Deployment", function () {
    it("Should set the right owner", async function () {
      const { hub, owner } = await loadFixture(deployFixture);

      expect(await hub.owner()).to.equal(owner.address);
    });
    it("Should allow setting new operator", async function () {
      const { hub, user, operator } = await loadFixture(deployFixture);

      expect(await hub.setOperator(user.address))
        .to.emit(hub, "OperatorChanged")
        .withArgs(operator.address, user.address);
    });
    it("Should allow setting new drone implementation", async function () {
      const { hub, drone } = await loadFixture(deployFixture);
      const GrinderyNexusDrone = await ethers.getContractFactory("GrinderyNexusDrone");
      const newDrone = await GrinderyNexusDrone.deploy(hub.address);

      expect(await hub.setDroneImplementation(newDrone.address))
        .to.emit(hub, "DroneImplementationChanged")
        .withArgs(drone.address, newDrone.address);
    });
    it("Should reject setting operator by non-owner", async function () {
      const { hub, user } = await loadFixture(deployFixture);

      await expect(hub.connect(user).setOperator(user.address)).to.be.reverted;
    });
    it("Should reject setting drone implementation by non-owner", async function () {
      const { hub, user } = await loadFixture(deployFixture);

      const GrinderyNexusDrone = await ethers.getContractFactory("GrinderyNexusDrone");
      const newDrone = await GrinderyNexusDrone.deploy(hub.address);

      await expect(hub.connect(user).setDroneImplementation(newDrone.address)).to.be.reverted;
    });
    it("Should be able to transfer ownership", async function () {
      const { hub, user } = await loadFixture(deployFixture);
      expect(await hub.transferOwnership(user.address)).to.emit(hub, "OwnershipTransferStarted");
      expect(await hub.pendingOwner()).to.equal(user.address);
      expect(await hub.connect(user).acceptOwnership()).to.emit(hub, "OwnershipTransferred");
      expect(await hub.owner()).to.equal(user.address);
    });
    it("Should reject ownership transfer by non-owner", async function () {
      const { hub, user } = await loadFixture(deployFixture);
      await expect(hub.connect(user).transferOwnership(user.address)).to.be.reverted;
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
    async function deployDroneFixture() {
      const fixture = await loadFixture(deployFixture);
      const { hub, operator, user, drone } = fixture;

      const hubOperator = hub.connect(operator);
      const droneAddress = await hubOperator.getUserDroneAddress(user.address);
      await hubOperator.deployDrone(user.address);
      const droneInstance = drone.attach(droneAddress).connect(operator);

      return Object.assign({}, fixture, { droneAddress, hubOperator, droneInstance });
    }
    it("Should be able to send transaction", async function () {
      const { user, operator, testContract, hubOperator, droneAddress, droneInstance } = await loadFixture(
        deployDroneFixture
      );

      await expect(testContract.connect(user).echo("0x0"))
        .to.emit(testContract, "Echo")
        .withArgs(
          user.address,
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          "0x0000000000000000000000000000000000000000000000000000000000000000"
        );

      const callData = testContract.interface.encodeFunctionData("echo", ["0x1"]);
      const nonce = await droneInstance.getNextNonce();
      expect(nonce).to.equal("0x0");
      const transactionHash = await hubOperator.getTransactionHash(droneAddress, testContract.address, nonce, callData);
      const signature = await operator.signMessage(ethers.utils.arrayify(transactionHash));
      const transaction = droneInstance.sendTransaction(testContract.address, nonce, callData, signature);
      await expect(transaction)
        .to.emit(droneInstance, "TransactionResult")
        .withArgs(
          ethers.utils.keccak256(ethers.utils.arrayify(signature)),
          true,
          "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
      await expect(transaction)
        .to.emit(testContract, "Echo")
        .withArgs(
          droneAddress,
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
      expect(await droneInstance.getNextNonce()).to.equal("0x1");
    });
    it("Should be able to handle revert from transaction", async function () {
      const { operator, testContract, hubOperator, droneAddress, droneInstance } = await loadFixture(
        deployDroneFixture
      );

      await expect(testContract.testRevert("0x0")).to.be.reverted;

      const callData = testContract.interface.encodeFunctionData("testRevert", ["0x1"]);
      const nonce = await droneInstance.getNextNonce();
      expect(nonce).to.equal("0x0");
      const transactionHash = await hubOperator.getTransactionHash(droneAddress, testContract.address, nonce, callData);
      const signature = await operator.signMessage(ethers.utils.arrayify(transactionHash));
      const transaction = droneInstance.sendTransaction(testContract.address, nonce, callData, signature);
      await expect(transaction)
        .to.emit(droneInstance, "TransactionResult")
        .withArgs(ethers.utils.keccak256(ethers.utils.arrayify(signature)), false, anyValue);
      expect(await droneInstance.getNextNonce()).to.equal("0x1");
    });
    it("Should be able to handle gas exhaustion", async function () {
      const { operator, testContract, hubOperator, droneAddress, droneInstance } = await loadFixture(
        deployDroneFixture
      );

      await expect(testContract.testDrainAllGas("0x0")).to.be.reverted;

      const callData = testContract.interface.encodeFunctionData("testDrainAllGas", ["0x1"]);
      const nonce = await droneInstance.getNextNonce();
      expect(nonce).to.equal("0x0");
      const transactionHash = await hubOperator.getTransactionHash(droneAddress, testContract.address, nonce, callData);
      const signature = await operator.signMessage(ethers.utils.arrayify(transactionHash));
      const transaction = droneInstance.sendTransaction(testContract.address, nonce, callData, signature, {
        gasLimit: 150000,
      });
      await expect(transaction)
        .to.emit(droneInstance, "TransactionResult")
        .withArgs(ethers.utils.keccak256(ethers.utils.arrayify(signature)), false, anyValue);
      expect(await droneInstance.getNextNonce()).to.equal("0x1");
    });
    it("Should be able to handle long return data", async function () {
      const { operator, testContract, hubOperator, droneAddress, droneInstance } = await loadFixture(
        deployDroneFixture
      );

      const callData = testContract.interface.encodeFunctionData("testLongReturnValue", [10]);
      const nonce = await droneInstance.getNextNonce();
      expect(nonce).to.equal("0x0");
      const transactionHash = await hubOperator.getTransactionHash(droneAddress, testContract.address, nonce, callData);
      const signature = await operator.signMessage(ethers.utils.arrayify(transactionHash));
      const transaction = droneInstance.sendTransaction(testContract.address, nonce, callData, signature);
      await expect(transaction)
        .to.emit(droneInstance, "TransactionResult")
        .withArgs(ethers.utils.keccak256(ethers.utils.arrayify(signature)), true, anyValue);
      expect(await droneInstance.getNextNonce()).to.equal("0x1");
    });
    it("Should be able to deploy drone and send transaction at the same time", async function () {
      const { user2, operator, testContract, hubOperator, droneInstance } = await loadFixture(deployDroneFixture);

      const callData = testContract.interface.encodeFunctionData("echo", ["0x1"]);
      const nonce = 0;
      const droneAddress = await hubOperator.getUserDroneAddress(user2.address);
      const transactionHash = await hubOperator.getTransactionHash(droneAddress, testContract.address, nonce, callData);
      const signature = await operator.signMessage(ethers.utils.arrayify(transactionHash));
      const transaction = hubOperator.deployDroneAndSendTransaction(
        user2.address,
        testContract.address,
        callData,
        signature
      );
      const newDroneInstance = droneInstance.attach(droneAddress);
      await expect(transaction).to.emit(hubOperator, "DeployedDrone").withArgs(droneAddress);
      await expect(transaction)
        .to.emit(newDroneInstance, "TransactionResult")
        .withArgs(
          ethers.utils.keccak256(ethers.utils.arrayify(signature)),
          true,
          "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
      await expect(transaction)
        .to.emit(testContract, "Echo")
        .withArgs(
          droneAddress,
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          "0x0000000000000000000000000000000000000000000000000000000000000001"
        );
      expect(await newDroneInstance.getNextNonce()).to.equal("0x1");
    });
    it("Should fail when deployDroneAndSendTransaction is called for an user who already has drone", async function () {
      const { user, operator, testContract, hubOperator, droneInstance } = await loadFixture(deployDroneFixture);

      const callData = testContract.interface.encodeFunctionData("echo", ["0x1"]);
      const nonce = await droneInstance.getNextNonce();
      expect(nonce).to.equal("0x0");
      const droneAddress = await hubOperator.getUserDroneAddress(user.address);
      expect(droneAddress).to.equal(droneInstance.address);
      const transactionHash = await hubOperator.getTransactionHash(droneAddress, testContract.address, nonce, callData);
      const signature = await operator.signMessage(ethers.utils.arrayify(transactionHash));
      await expect(hubOperator.deployDroneAndSendTransaction(user.address, testContract.address, callData, signature))
        .to.be.reverted;
    });
  });
});
