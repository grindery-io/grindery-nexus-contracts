import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";
import { getGasConfiguration } from "../lib/gas";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre;
  const { owner, ownerOld } = await getNamedAccounts();

  const beacon = await deployments.get("GrinderyNexusDroneBeacon");
  const GrinderyNexusDroneBeacon = (await ethers.getContractFactory("GrinderyNexusDroneBeacon")).attach(beacon.address);
  if ((await GrinderyNexusDroneBeacon.owner()) !== ownerOld) {
    return;
  }
  const ownerSigner = await hre.ethers.getSigner(owner);
  const ownerOldSigner = await hre.ethers.getSigner(ownerOld);
  const gas = (await GrinderyNexusDroneBeacon.connect(ownerOld).estimateGas.transferOwnership(owner)).mul(12).div(10);
  const gasConf = await getGasConfiguration(hre.ethers.provider);
  const gasPrice = "maxFeePerGas" in gasConf ? gasConf.maxFeePerGas : gasConf.gasPrice;
  const gasFee = gas.mul(gasPrice);
  if ((await ownerOldSigner.getBalance()).lte(gasFee)) {
    await ownerSigner.sendTransaction({ to: ownerOld, value: gasFee, ...gasConf }).then((x) => x.wait());
  }
  await GrinderyNexusDroneBeacon.connect(ownerOldSigner)
    .transferOwnership(owner, {
      ...(await getGasConfiguration(hre.ethers.provider)),
    })
    .then((x) => x.wait());
};
func.tags = ["GrinderyNexusDroneBeaconFixOwner"];
func.dependencies = ["GrinderyNexusDroneBeacon"];
export default func;
