import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();
  const hub = await deployments.get("GrinderyNexusHub");
  await deploy("GrinderyNexusDroneImpl", {
    contract: "GrinderyNexusDrone",
    from: owner,
    args: [hub.address],
    log: true,
    waitConfirmations: 1,
  });
};
func.dependencies = ["GrinderyNexusHubImpl"];
func.tags = ["GrinderyNexusDroneImpl"];
export default func;
