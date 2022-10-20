import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";
import { getGasConfiguration } from "../lib/gas";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();
  const beacon = await deployments.get("GrinderyNexusDroneBeacon");

  const result = await deploy("GrinderyNexusDrone", {
    contract: "StaticBeaconProxy",
    from: owner,
    args: [beacon.address],
    log: true,
    deterministicDeployment: ethers.utils.keccak256(
      ethers.utils.arrayify(ethers.utils.toUtf8Bytes("GrinderyNexusDrone"))
    ),
    waitConfirmations: 1,
    ...(await getGasConfiguration(hre.ethers.provider)),
  });
  const GrinderyNexusHub = (await ethers.getContractFactory("GrinderyNexusHub")).attach(
    (await deployments.get("GrinderyNexusHub")).address
  );
  if ((await GrinderyNexusHub.getDroneImplementation()) !== result.address) {
    await GrinderyNexusHub.setDroneImplementation(result.address, await getGasConfiguration(hre.ethers.provider));
  }
  return true;
};
func.id = "GrinderyNexusDrone";
func.tags = ["GrinderyNexusDrone"];
func.dependencies = ["DeterministicDeploymentProxy", "GrinderyNexusDroneBeacon", "GrinderyNexusHub"];
export default func;
