import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();
  const hub = await deployments.get("GrinderyNexusHub");
  await hre.upgrades.validateImplementation(await ethers.getContractFactory("GrinderyNexusDrone"), {
    kind: "beacon",
    unsafeAllow: ["constructor", "state-variable-immutable", "state-variable-assignment"],
    ...{ constructorArgs: [hub.address] },
  });
  await deploy("GrinderyNexusDroneImpl", {
    contract: "GrinderyNexusDrone",
    from: owner,
    args: [hub.address],
    log: true,
    waitConfirmations: 1,
    gasPrice: await hre.ethers.provider.getGasPrice(),
  });
};
func.dependencies = ["GrinderyNexusHubImpl"];
func.tags = ["GrinderyNexusDroneImpl"];
export default func;
