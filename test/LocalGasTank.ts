import { loadFixture, mine } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers, deployments, network } from "hardhat";
import { FeeAccountantPrimary__factory, LocalGasTank__factory } from "../typechain-types";
import { AddressLike, BytesLike } from "ethers";

function closeTo(target: bigint, delta: bigint) {
  return (x: bigint) => !!expect(x).to.be.closeTo(target, delta);
}
function combine<T>(...fns: ((x: T) => boolean)[]) {
  return (x: T) => fns.every((fn) => fn(x));
}
function slot<T = unknown>() {
  const values = [] as T[];
  return {
    save: (x: T) => (values.push(x) ? true : true),
    check:
      (fn: (actual: T, stored: T) => boolean = (actual, stored) => actual === stored) =>
      (actual: T) =>
        Boolean(values.length && fn(actual, values.pop()!)),
  };
}

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
    network.config.gasTankSigner = await signer.getAddress();
    await deployments.fixture(undefined, { keepExistingDeployments: false });

    const GasTank = await deployments.get("GasTank");
    const gasTank = LocalGasTank__factory.connect(GasTank.address, owner);

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
      gasTankExecute: async (to: AddressLike, data: BytesLike, delegateCall: boolean, value = 0n) => {
        await network.provider.send("hardhat_setNextBlockBaseFeePerGas", [
          ethers.toBeHex(ethers.parseUnits("1", "gwei")),
        ]);
        const ret = sampleSmartWallet.delegateCall(
          await gasTank.getAddress(),
          gasTank.interface.encodeFunctionData("execute", [
            to,
            data,
            value,
            delegateCall,
            await signer.signMessage(
              ethers.getBytes(
                await gasTank.getSigningHashFromCallData(sampleSmartWallet.getAddress(), to, data, value, delegateCall)
              )
            ),
          ]),
          { maxFeePerGas: ethers.parseUnits("1", "gwei"), maxPriorityFeePerGas: ethers.parseUnits("1", "gwei") }
        );
        await expect(ret)
          .to.emit(feeAccountantPrimary, "BalanceUpdated")
          .withArgs(
            CHAIN_ID,
            await gasTank.getSynthesizedTransactionId(
              await sampleSmartWallet.getAddress(),
              to,
              data,
              value,
              delegateCall
            ),
            await sampleSmartWallet.getAddress(),
            anyValue,
            anyValue,
            anyValue,
            anyValue
          );
        return ret;
      },
    };
  }

  it("Should execute tx and record fee", async function () {
    const {
      owner,
      signer,
      gasTank,
      sampleSmartWallet,
      sampleContract,
      testErc20,
      feeAccountantPrimary,
      CHAIN_ID,
      gasTankExecute,
    } = await loadFixture(deployFixture);
    expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);

    await expect(
      gasTankExecute(
        await sampleContract.getAddress(),
        sampleContract.interface.encodeFunctionData("sampleMethod"),
        false
      )
    )
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(CHAIN_ID, anyValue, await sampleSmartWallet.getAddress(), anyValue, 0n, anyValue, 0n)
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());

    const tankReceivedInitial = await testErc20.balanceOf(gasTank.getAddress());
    expect(tankReceivedInitial).to.be.greaterThan(0n);

    await expect(
      gasTankExecute(
        await sampleContract.getAddress(),
        sampleContract.interface.encodeFunctionData("sampleMethod"),
        false
      )
    )
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(CHAIN_ID, anyValue, await sampleSmartWallet.getAddress(), anyValue, 1n, anyValue, 0n)
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());

    const tankReceived = (await testErc20.balanceOf(gasTank.getAddress())) - tankReceivedInitial;
    expect(tankReceived).to.be.greaterThan(0n);

    await expect(
      gasTankExecute(
        await sampleContract.getAddress(),
        sampleContract.interface.encodeFunctionData("sampleMethod"),
        false
      )
    )
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(
        CHAIN_ID,
        anyValue,
        await sampleSmartWallet.getAddress(),
        closeTo(tankReceived, ethers.parseUnits("5", "gwei")),
        2n,
        closeTo(tankReceived, ethers.parseUnits("5", "gwei")),
        0n
      )
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());

    await sampleSmartWallet.call(
      await testErc20.getAddress(),
      testErc20.interface.encodeFunctionData("transfer", [
        await owner.getAddress(),
        (await testErc20.balanceOf(sampleSmartWallet.getAddress())) - 100n,
      ])
    );

    const s = slot<bigint>();
    await expect(
      gasTankExecute(
        await sampleContract.getAddress(),
        sampleContract.interface.encodeFunctionData("sampleMethod"),
        false
      )
    )
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(
        CHAIN_ID,
        anyValue,
        await sampleSmartWallet.getAddress(),
        combine(closeTo(tankReceived, ethers.parseUnits("5", "gwei")), s.save, s.save),
        3n,
        s.check(),
        s.check((actual, stored) => actual === stored - 100n)
      )
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());
  });
  it("Should allow sending value", async function () {
    const {
      owner,
      signer,
      gasTank,
      sampleSmartWallet,
      sampleContract,
      testErc20,
      feeAccountantPrimary,
      CHAIN_ID,
      gasTankExecute,
    } = await loadFixture(deployFixture);
    expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);

    await owner.sendTransaction({
      to: await sampleSmartWallet.getAddress(),
      data: sampleSmartWallet.interface.encodeFunctionData("sampleMethod"),
      value: ethers.parseEther("2"),
    });

    expect(await owner.provider.getBalance(await sampleContract.getAddress())).to.equal(0n);

    await expect(
      gasTankExecute(
        await sampleContract.getAddress(),
        sampleContract.interface.encodeFunctionData("sampleMethod"),
        false,
        ethers.parseEther("1")
      )
    )
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());

    expect(await owner.provider.getBalance(await sampleContract.getAddress())).to.equal(ethers.parseEther("1"));
  });
  it("Should allow calling aggregate3Value", async function () {
    const {
      owner,
      signer,
      gasTank,
      sampleSmartWallet,
      sampleContract,
      testErc20,
      feeAccountantPrimary,
      CHAIN_ID,
      gasTankExecute,
    } = await loadFixture(deployFixture);
    expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);

    const abi = [
      "function aggregate3Value(tuple(address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)",
    ];
    const multicall3 = new ethers.Interface(abi);

    await owner.sendTransaction({
      to: await sampleSmartWallet.getAddress(),
      data: sampleSmartWallet.interface.encodeFunctionData("sampleMethod"),
      value: ethers.parseEther("2"),
    });

    expect(await owner.provider.getBalance(await sampleContract.getAddress())).to.equal(0n);

    await expect(
      gasTankExecute(
        "0xcA11bde05977b3631167028862bE2a173976CA11",
        multicall3.encodeFunctionData("aggregate3Value", [
          [
            {
              target: await sampleContract.getAddress(),
              allowFailure: false,
              value: ethers.parseEther("1"),
              callData: sampleContract.interface.encodeFunctionData("sampleMethod"),
            },
            {
              target: await sampleContract.getAddress(),
              allowFailure: false,
              value: ethers.parseEther("1"),
              callData: sampleContract.interface.encodeFunctionData("sampleMethod"),
            },
          ],
        ]),
        true,
        ethers.parseEther("2")
      )
    )
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());

    expect(await owner.provider.getBalance(await sampleContract.getAddress())).to.equal(ethers.parseEther("2"));
    expect(await owner.provider.getBalance(await sampleSmartWallet.getAddress())).to.equal(ethers.parseEther("0"));
  });
  it("Should allow sending native token to EOA", async function () {
    const {
      owner,
      signer,
      gasTank,
      sampleSmartWallet,
      sampleContract,
      testErc20,
      feeAccountantPrimary,
      CHAIN_ID,
      gasTankExecute,
    } = await loadFixture(deployFixture);
    expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);

    const eoaAddress = "0x1111111111111111111111111111111111111111";

    await owner.sendTransaction({
      to: await sampleSmartWallet.getAddress(),
      data: sampleSmartWallet.interface.encodeFunctionData("sampleMethod"),
      value: ethers.parseEther("2"),
    });

    expect(await owner.provider.getBalance(eoaAddress)).to.equal(0n);

    await expect(gasTankExecute(eoaAddress, "0x", false, ethers.parseEther("1"))).to.emit(
      feeAccountantPrimary,
      "BalanceUpdated"
    );

    expect(await owner.provider.getBalance(eoaAddress)).to.equal(ethers.parseEther("1"));
  });
  it("Should allow fee scaling", async function () {
    const {
      owner,
      signer,
      gasTank,
      sampleSmartWallet,
      sampleContract,
      testErc20,
      feeAccountantPrimary,
      CHAIN_ID,
      gasTankExecute,
    } = await loadFixture(deployFixture);
    expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);

    const { _baseGas } = await gasTank.getFeeRate();

    await expect(
      gasTankExecute(
        await sampleContract.getAddress(),
        sampleContract.interface.encodeFunctionData("sampleMethod"),
        false
      )
    )
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(CHAIN_ID, anyValue, await sampleSmartWallet.getAddress(), anyValue, 0n, anyValue, 0n)
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());

    const tankReceivedInitial = await testErc20.balanceOf(gasTank.getAddress());
    expect(tankReceivedInitial).to.be.greaterThan(0n);

    await expect(
      gasTankExecute(
        await sampleContract.getAddress(),
        sampleContract.interface.encodeFunctionData("sampleMethod"),
        false
      )
    )
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(CHAIN_ID, anyValue, await sampleSmartWallet.getAddress(), anyValue, 1n, anyValue, 0n)
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());

    const tankReceived = (await testErc20.balanceOf(gasTank.getAddress())) - tankReceivedInitial;
    expect(tankReceived).to.be.greaterThan(0n);

    const s = slot<bigint>();

    await gasTank
      .connect(owner)
      .setFeeRate(2n, 1n, _baseGas)
      .then((x) => x.wait());
    await expect(
      gasTankExecute(
        await sampleContract.getAddress(),
        sampleContract.interface.encodeFunctionData("sampleMethod"),
        false
      )
    )
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(
        CHAIN_ID,
        anyValue,
        await sampleSmartWallet.getAddress(),
        combine(closeTo(tankReceived * 2n, ethers.parseUnits("5", "gwei")), s.save),
        2n,
        s.check(),
        0n
      )
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());

    await gasTank
      .connect(owner)
      .setFeeRate(3n, 2n, _baseGas)
      .then((x) => x.wait());
    await expect(
      gasTankExecute(
        await sampleContract.getAddress(),
        sampleContract.interface.encodeFunctionData("sampleMethod"),
        false
      )
    )
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(
        CHAIN_ID,
        anyValue,
        await sampleSmartWallet.getAddress(),
        combine(closeTo((tankReceived * 3n) / 2n, ethers.parseUnits("5", "gwei")), s.save),
        3n,
        s.check(),
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
    const {
      signer,
      gasTank,
      sampleSmartWallet,
      sampleContract,
      testErc20,
      feeAccountantPrimary,
      CHAIN_ID,
      gasTankExecute,
    } = await loadFixture(deployFixture);
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
      gasTankExecute(
        await sampleContract.getAddress(),
        sampleContract.interface.encodeFunctionData("sampleMethod"),
        false
      )
    )
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(CHAIN_ID, anyValue, await sampleSmartWallet.getAddress(), anyValue, 0n, anyValue, anyValue)
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());

    expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(ethers.parseEther("1"));
    expect(await testErc20.allowance(sampleSmartWallet.getAddress(), feeAccountantPrimary.getAddress())).to.equal(0n);
    const { balance: newBalance } = await feeAccountantPrimary.getWalletRecord(sampleSmartWallet.getAddress(), 1);
    expect(newBalance).to.greaterThan(balance);
  });
  it("Synthesized transaction ID should be verifiable without contract", async function () {
    const { gasTank, sampleSmartWallet, sampleContract, testErc20, feeAccountantPrimary, CHAIN_ID, gasTankExecute } =
      await loadFixture(deployFixture);
    expect(await testErc20.balanceOf(gasTank.getAddress())).to.equal(0n);

    const address = await sampleSmartWallet.getAddress();
    await expect(
      gasTankExecute(
        await sampleContract.getAddress(),
        sampleContract.interface.encodeFunctionData("sampleMethod"),
        false
      )
    )
      .to.emit(feeAccountantPrimary, "BalanceUpdated")
      .withArgs(
        CHAIN_ID,
        (txid: string) => {
          const txidBigInt = ethers.toBigInt(txid);
          const hashPart = txidBigInt & 0x00000000_00000000_00000000_00000000_ffffffff_ffffffff_ffffffff_ffffffffn;
          const verificationPart = ethers.keccak256(
            ethers.getBytes(
              ethers.solidityPacked(
                ["bytes32", "address", "uint256", "uint256"],
                [ethers.getBytes(ethers.toBeHex(hashPart, 32)), address, 0n, CHAIN_ID]
              )
            )
          );
          const combined =
            (ethers.toBigInt(verificationPart) &
              0xffffffff_ffffffff_ffffffff_ffffffff_00000000_00000000_00000000_00000000n) |
            hashPart;
          return combined === txidBigInt;
        },
        await sampleSmartWallet.getAddress(),
        anyValue,
        0n,
        anyValue,
        0n
      )
      .and.to.emit(sampleContract, "SampleEvent")
      .withArgs(await sampleSmartWallet.getAddress());
  });
});
