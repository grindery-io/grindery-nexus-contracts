import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";
import { getGasConfiguration } from "../lib/gas";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments } = hre;
  const impl = await deployments.get("GrinderyNexusDroneImpl");
  const beacon = await deployments.get("GrinderyNexusDroneBeacon");
  const beaconInstance = (await ethers.getContractFactory("UpgradeableBeacon")).attach(beacon.address);
  const factory = await ethers.getContractFactory("GrinderyNexusDrone");
  await hre.upgrades.validateUpgrade(beacon.address, factory, {
    kind: "beacon",
    unsafeAllow: ["constructor", "state-variable-immutable", "state-variable-assignment"],
    ...{ constructorArgs: [impl.address] },
  });
  if (!ethers.BigNumber.from(await beaconInstance.implementation()).eq(impl.address)) {
    console.log(
      `Upgrading implementation of GrinderyNexusDrone (beacon: ${beaconInstance.address}) to ${impl.address}`
    );
    await beaconInstance.upgradeTo(impl.address, await getGasConfiguration(hre.ethers.provider)).then((x) => x.wait());
    await hre.upgrades.forceImport(beaconInstance.address, factory, {
      kind: "beacon",
      ...{ constructorArgs: [impl.address] },
    });
  }
};
func.tags = ["upgrade-GrinderyNexusDrone"];
func.dependencies = ["GrinderyNexusDroneBeacon", "GrinderyNexusDroneImpl"];
export default func;
