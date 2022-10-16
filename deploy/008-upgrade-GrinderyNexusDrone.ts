import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments } = hre;
  const impl = await deployments.get("GrinderyNexusDroneImpl");
  const beacon = await deployments.get("GrinderyNexusDroneBeacon");
  const beaconInstance = (await ethers.getContractFactory("UpgradeableBeacon")).attach(beacon.address);
  if (!ethers.BigNumber.from((await beaconInstance.implementation())).eq(impl.address)) {
    console.log(`Upgrading implementation of GrinderyNexusDrone (beacon: ${beaconInstance.address}) to ${impl.address}`);
    await beaconInstance.upgradeTo(impl.address).then((x) => x.wait());
  }
};
func.tags = ["upgrade-GrinderyNexusDrone"];
func.dependencies = ["GrinderyNexusDroneBeacon", "GrinderyNexusDroneImpl"];
export default func;
