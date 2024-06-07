import { task } from "hardhat/config";
import { NAMED_ACCOUNTS } from "../lib/namedAccounts";

task("refund", "Send all remaining fund from deployer account to operator account").setAction(async (_, hre) => {
  const { getNamedAccounts, ethers } = hre;
  const { owner, operator } = await getNamedAccounts();
  const signer = await hre.ethers.getSigner(owner);
  const balance = await signer.provider?.getBalance?.(owner);
  if (!balance || balance < ethers.parseEther("0.001")) {
    console.log("Not much fund remains in the deployer account");
    return;
  }
  const gasConf = await signer.provider.getFeeData();
  const fee = (gasConf.maxFeePerGas || gasConf.gasPrice || ethers.parseUnits("1", "gwei")) * 21000n;
  const amount = balance - fee;
  console.log(`Sending ${ethers.formatEther(amount.toString())} to ${operator}...`);
  await signer.sendTransaction({ to: operator, value: amount, gasLimit: 21000, ...gasConf }).then((tx) => tx.wait());
});
