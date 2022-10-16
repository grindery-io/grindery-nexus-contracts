import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ensureDeploymentProxy, contractAddress } from "../lib/deterministicDeployment";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre;
  const { owner } = await getNamedAccounts();
  await ensureDeploymentProxy(await hre.ethers.getSigner(owner));
  await deployments.save("DeterministicDeploymentProxy", {
    abi: [],
    address: contractAddress,
  });
  return true;
};
func.id = "DeterministicDeploymentProxy";
func.tags = ["DeterministicDeploymentProxy"];
export default func;
