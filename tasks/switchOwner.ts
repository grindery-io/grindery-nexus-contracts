import { task } from "hardhat/config";
import { getGasConfiguration } from "../lib/gas";

task("switch-owner", "").setAction(async (_, hre) => {
  const { getNamedAccounts, ethers } = hre;
  const { owner, ownerOld } = await getNamedAccounts();
  const signer = await hre.ethers.getSigner(ownerOld);
  const newSigner = await hre.ethers.getSigner(owner);
  const newAddress = await newSigner.getAddress();
  const hub = await (
    await ethers.getContractFactory("GrinderyNexusHub")
  ).attach("0xC942DFb6cC8Aade0F54e57fe1eD4320411625F8B");
  if ((await hub.owner()).toLowerCase() === newAddress.toLowerCase()) {
    console.log("Ownership already transferred to ", newAddress);
    return;
  }
  if ((await hub.pendingOwner()).toLowerCase() !== newAddress.toLowerCase()) {
    console.log("Initiating...");
    const gasConf = await getGasConfiguration(ethers.provider);
    await (await hub.connect(signer).transferOwnership(newAddress, { ...gasConf })).wait();
  }
  const balance = await signer.getBalance();
  if ((await newSigner.getBalance()).lt(balance)) {
    const gasConf = await getGasConfiguration(ethers.provider);
    const fee = ("maxFeePerGas" in gasConf ? gasConf.maxFeePerGas : gasConf.gasPrice).mul(21000);
    const amount = balance.sub(fee);
    console.log(`Sending ${ethers.utils.formatEther(amount.toString())} to ${newAddress}...`);
    await signer
      .sendTransaction({ to: newAddress, value: amount, ...gasConf, gasLimit: 21000 })
      .then((tx) => tx.wait());
  }
  console.log("Committing...");
  const gasConf = await getGasConfiguration(ethers.provider);
  await (await hub.connect(newSigner as any).acceptOwnership({ ...gasConf })).wait();
  console.log("Ownership transferred to ", newAddress);
});
