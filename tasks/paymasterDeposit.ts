import { task } from "hardhat/config";
import { GrinderyPaymaster__factory } from "../typechain-types";
import { getGasConfiguration } from "../lib/gas";

task("paymasterDeposit", "Deposit fund for paymaster")
  .addParam("amount", "Amount to deposit")
  .setAction(async ({ amount }, hre) => {
    const { getNamedAccounts, ethers, deployments } = hre;
    const { owner } = await getNamedAccounts();
    const ownerSigner = await ethers.getSigner(owner);

    const paymaster = await deployments.get("GrinderyPaymaster");
    const paymasterInstance = GrinderyPaymaster__factory.connect(paymaster.address, ownerSigner);
    console.log(`Depositing ${amount} for ${paymaster.address}...`);
    await paymasterInstance
      .deposit({ ...(await getGasConfiguration(ownerSigner.provider)), value: ethers.parseEther(amount) })
      .then((x) => x.wait());
  });
