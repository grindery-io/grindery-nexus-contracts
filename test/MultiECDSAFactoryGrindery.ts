import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, deployments, network } from "hardhat";
import {
  BaseGasTank__factory,
  FeeAccountantPrimary__factory,
  MultiECDSAFactoryGrindery,
  MultiECDSAFactoryGrindery__factory,
} from "../typechain-types";

describe("MultiECDSAFactoryGrindery", function () {
  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  async function deployFixture() {
    // Contracts are deployed using the first signer/account by default
    const [owner, walletUser, walletUser2, operator] = await ethers.getSigners();

    await deployments.fixture();

    const MultiECDSAFactoryGrindery = await deployments.get("MultiECDSAFactoryGrindery");
    const multiECDSAFactoryGrindery = MultiECDSAFactoryGrindery__factory.connect(
      MultiECDSAFactoryGrindery.address,
      owner
    ) as MultiECDSAFactoryGrindery;

    const Kernel = await deployments.get("Kernel");

    return {
      owner,
      walletUser,
      walletUser2,
      operator,
      MultiECDSAFactoryGrindery,
      multiECDSAFactoryGrindery,
      Kernel,
    };
  }
  describe("Account deployment", function () {
    it("Should deploy account to expected address", async function () {
      const { owner, walletUser, operator, multiECDSAFactoryGrindery, Kernel } = await loadFixture(deployFixture);

      const salt = ethers.keccak256(ethers.toUtf8Bytes("GrinderyTestAccount"));
      const expectedAddress = await multiECDSAFactoryGrindery["getAccountAddress(uint256)"](salt);

      expect(await owner.provider.getCode(expectedAddress).then((x) => x || "0x")).to.equal("0x");

      await expect(multiECDSAFactoryGrindery["createAccount(uint256)"](salt))
        .to.emit(multiECDSAFactoryGrindery, "Deployed")
        .withArgs(expectedAddress, Kernel.address);

      expect(await owner.provider.getCode(expectedAddress).then((x) => x || "0x")).to.not.equal("0x");
    });
  });
});
