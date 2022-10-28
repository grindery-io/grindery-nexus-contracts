import { task } from "hardhat/config";
import { getGasConfiguration } from "../lib/gas";

task("refund", "Send all remaining fund from deployer account to operator account").setAction(async (_, hre) => {
  const { getNamedAccounts, ethers } = hre;
  const { owner, operator } = await getNamedAccounts();
  const signer = await hre.ethers.getSigner(owner);
  const balance = await signer.getBalance();
  if (balance.lte(ethers.utils.parseEther("0.001"))) {
    console.log("Not much fund remains in the deployer account");
    return;
  }
  const gasConf = await getGasConfiguration(ethers.provider);
  const fee = ("maxFeePerGas" in gasConf ? gasConf.maxFeePerGas : gasConf.gasPrice).mul(21000);
  const amount = balance.sub(fee);
  console.log(`Sending ${ethers.utils.formatEther(amount.toString())} to ${operator}...`);
  await signer.sendTransaction({ to: operator, value: amount, ...gasConf }).then(tx => tx.wait());
});
