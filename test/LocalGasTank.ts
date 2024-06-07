import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers, deployments, network } from "hardhat";
import { FeeAccountantPrimary__factory, LocalGasTank__factory } from "../typechain-types";

describe("LocalGasTank", function () {
  // We define a fixture to reuse the same setup in every test.
  // We use loadFixture to run this setup once, snapshot that state,
  // and reset Hardhat Network to that snapshot in every test.
  async function deployFixture() {
    const [owner, walletUser, walletUser2, operator, signer] = await ethers.getSigners();

    await network.provider.send("hardhat_reset");

    const TestERC20 = await ethers.getContractFactory("TestERC20");
    const testErc20 = await TestERC20.deploy(ethers.parseEther("10000"));

    network.config.gasTokenAddress = (await testErc20.getAddress()) as any;
    await deployments.fixture(undefined, { keepExistingDeployments: false });

    const GasTank = await deployments.get("GasTank");
    const gasTank = LocalGasTank__factory.connect(GasTank.address, owner);

    await gasTank.grantRole(await gasTank.ROLE_SIGNER(), signer.getAddress()).then((x) => x.wait());

    const FeeAccountantPrimary = await deployments.get("FeeAccountantPrimary");
    const feeAccountantPrimary = FeeAccountantPrimary__factory.connect(FeeAccountantPrimary.address, owner);

    const MockV3Aggregator = await ethers.getContractFactory("MockV3Aggregator");
    const priceFeedLocal = await MockV3Aggregator.deploy(8, 1n * 10n ** 8n);
    const CHAIN_ID = await owner.provider.getNetwork().then((x) => x.chainId);
    await feeAccountantPrimary.setPriceFeed(CHAIN_ID, priceFeedLocal.getAddress()).then((x) => x.wait());

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
      feeAccountantPrimary,
      priceFeedLocal,
      CHAIN_ID,
      SampleSmartWallet,
      sampleSmartWallet,
      sampleContract,
    };
  }

  it("Should execute tx and record fee", async function () {
    const { owner, signer, gasTank, sampleSmartWallet, sampleContract, testErc20, feeAccountantPrimary, CHAIN_ID } =
      await loadFixture(deployFixture);
    expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);

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
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(CHAIN_ID, 0n, await sampleSmartWallet.getAddress(), anyValue, 0n, anyValue, 0n)
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());

    const tankReceived = await testErc20.balanceOf(gasTank.getAddress());
    expect(tankReceived).to.be.greaterThan(0n);

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
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(CHAIN_ID, 0n, await sampleSmartWallet.getAddress(), tankReceived, 1n, tankReceived, 0n)
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());

    await sampleSmartWallet.call(
      await testErc20.getAddress(),
      testErc20.interface.encodeFunctionData("transfer", [
        await owner.getAddress(),
        (await testErc20.balanceOf(sampleSmartWallet.getAddress())) - 100n,
      ])
    );

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
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(CHAIN_ID, 0n, await sampleSmartWallet.getAddress(), tankReceived, 2n, tankReceived, tankReceived - 100n)
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());
  });
  it("Should allow fee scaling", async function () {
    const { owner, signer, gasTank, sampleSmartWallet, sampleContract, testErc20, feeAccountantPrimary, CHAIN_ID } =
      await loadFixture(deployFixture);
    expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);

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
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(CHAIN_ID, 0n, await sampleSmartWallet.getAddress(), anyValue, 0n, anyValue, 0n)
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());

    const tankReceived = await testErc20.balanceOf(gasTank.getAddress());
    expect(tankReceived).to.be.greaterThan(0n);

    await gasTank
      .connect(owner)
      .setFeeRate(2n, 1n, 130000)
      .then((x) => x.wait());
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
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(CHAIN_ID, 0n, await sampleSmartWallet.getAddress(), tankReceived * 2n, 1n, tankReceived * 2n, 0n)
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());

    await gasTank
      .connect(owner)
      .setFeeRate(3n, 2n, 130000)
      .then((x) => x.wait());
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
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(
        CHAIN_ID,
        0n,
        await sampleSmartWallet.getAddress(),
        (tankReceived * 3n) / 2n,
        2n,
        (tankReceived * 3n) / 2n,
        0n
      )
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());
  });
  it("Should record fee for failed tx", async function () {
    const { signer, gasTank, sampleSmartWallet, testErc20, feeAccountantPrimary, CHAIN_ID } =
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
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(
        CHAIN_ID,
        ethers.hexlify(Buffer.alloc(32, 1)),
        await sampleSmartWallet.getAddress(),
        anyValue,
        0n,
        anyValue,
        0n
      );

    const tankReceived = await testErc20.balanceOf(gasTank.getAddress());
    expect(tankReceived).to.be.greaterThan(0n);
  });
  it("Should not change allowence with prepaid fee", async function () {
    const { signer, gasTank, sampleSmartWallet, sampleContract, testErc20, feeAccountantPrimary, CHAIN_ID } =
      await loadFixture(deployFixture);
    await sampleSmartWallet.call(
      await testErc20.getAddress(),
      testErc20.interface.encodeFunctionData("approve", [
        await feeAccountantPrimary.getAddress(),
        ethers.parseEther("1"),
      ])
    );
    await sampleSmartWallet.call(
      await feeAccountantPrimary.getAddress(),
      feeAccountantPrimary.interface.encodeFunctionData("payFee", [ethers.parseEther("1")])
    );
    expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(ethers.parseEther("1"));
    expect(await testErc20.allowance(sampleSmartWallet.getAddress(), feeAccountantPrimary.getAddress())).to.equal(0n);

    const { balance } = await feeAccountantPrimary.getWalletRecord(sampleSmartWallet.getAddress(), 1);

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
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(CHAIN_ID, 0n, await sampleSmartWallet.getAddress(), anyValue, 0n, anyValue, anyValue)
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());

    expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(ethers.parseEther("1"));
    expect(await testErc20.allowance(sampleSmartWallet.getAddress(), feeAccountantPrimary.getAddress())).to.equal(0n);
    const { balance: newBalance } = await feeAccountantPrimary.getWalletRecord(sampleSmartWallet.getAddress(), 1);
    expect(newBalance).to.greaterThan(balance);
  });
});
