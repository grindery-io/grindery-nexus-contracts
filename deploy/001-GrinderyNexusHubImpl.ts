import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();
  await deploy("GrinderyNexusHubImpl", {
    contract: "GrinderyNexusHub",
    from: owner,
    args: [owner],
    log: true,
    waitConfirmations: 1,
  });
};
func.tags = ["GrinderyNexusHubImpl"];
export default func;
