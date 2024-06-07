import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers, deployments, network } from "hardhat";
import { RemoteGasTank__factory } from "../typechain-types";

describe("RemoteGasTank", function () {
  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  async function deployFixture() {
    network.config.gasTokenAddress = undefined;
    await network.provider.send("hardhat_reset");
    await deployments.fixture(undefined, { keepExistingDeployments: false });
    // Contracts are deployed using the first signer/account by default
    const [owner, walletUser, walletUser2, operator, signer] = await ethers.getSigners();

    const TestERC20 = await ethers.getContractFactory("TestERC20");
    const testErc20 = await TestERC20.deploy(ethers.parseEther("10000"));

    const RemoteGasTank = await deployments.get("GasTank");
    const gasTank = RemoteGasTank__factory.connect(RemoteGasTank.address, owner);

    await gasTank.grantRole(await gasTank.ROLE_SIGNER(), signer.getAddress()).then((x) => x.wait());

    const SampleSmartWallet = await ethers.getContractFactory("SampleSmartWallet");
    const sampleSmartWallet = await SampleSmartWallet.deploy();
    const sampleContract = await SampleSmartWallet.deploy();

    await testErc20
      .connect(owner)
      .transfer(sampleSmartWallet.getAddress(), ethers.parseEther("100"))
      .then((x) => x.wait());

    return {
      owner,
      walletUser,
      walletUser2,
      operator,
      signer,
      TestERC20,
      testErc20,
      gasTank,
      SampleSmartWallet,
      sampleSmartWallet,
      sampleContract,
    };
  }

  it("Should execute tx and record fee", async function () {
    const { owner, signer, gasTank, sampleSmartWallet, sampleContract, testErc20 } =
      await loadFixture(deployFixture);

    await expect(
      sampleSmartWallet.delegateCall(
        await gasTank.getAddress(),
        gasTank.interface.encodeFunctionData("execute", [
          await sampleContract.getAddress(),
          sampleContract.interface.encodeFunctionData("sampleMethod"),
          false,
          await signer.signMessage(
            ethers.getBytes(
              await gasTank.getSigningHash(await sampleSmartWallet.getAddress(), ethers.hexlify(Buffer.alloc(32, 0)))
            )
          ),
        ]),
        { gasLimit: 30000000, gasPrice: ethers.parseUnits("1", "gwei") }
      )
    )
      .to.emit(gasTank, "ReportGasFee")
      .withArgs(0n, await sampleSmartWallet.getAddress(), 0n, anyValue)
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());
    await expect(
      sampleSmartWallet.delegateCall(
        await gasTank.getAddress(),
        gasTank.interface.encodeFunctionData("execute", [
          await sampleContract.getAddress(),
          sampleContract.interface.encodeFunctionData("sampleMethod"),
          false,
          await signer.signMessage(
            ethers.getBytes(
              await gasTank.getSigningHash(await sampleSmartWallet.getAddress(), ethers.hexlify(Buffer.alloc(32, 0)))
            )
          ),
        ]),
        { gasLimit: 30000000, gasPrice: ethers.parseUnits("1", "gwei") }
      )
    )
      .to.emit(gasTank, "ReportGasFee")
      .withArgs(0n, await sampleSmartWallet.getAddress(), 1n, anyValue)
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());
  });
  it("Should record fee for failed tx", async function () {
    const { signer, gasTank, sampleSmartWallet, testErc20 } =
      await loadFixture(deployFixture);
    expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);

    await expect(
      sampleSmartWallet.delegateCall(
        await gasTank.getAddress(),
        gasTank.interface.encodeFunctionData("reportFailedTx", [
          ethers.hexlify(Buffer.alloc(32, 1)),
          300000,
          await signer.signMessage(
            ethers.getBytes(
              await gasTank.getSigningHash(await sampleSmartWallet.getAddress(), ethers.hexlify(Buffer.alloc(32, 1)))
            )
          ),
        ])
      )
    )
      .to.emit(gasTank, "ReportGasFee")
      .withArgs(Buffer.alloc(32, 1), await sampleSmartWallet.getAddress(), 0n, anyValue);
  });
});
