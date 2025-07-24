import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { getGasConfiguration } from "../lib/gas";

const DEPLOYMENT_NAME = "AIGasTankImpl";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments, ethers } = hre;
  const { deploy } = deployments;
  if (!(await deployments.getOrNull(DEPLOYMENT_NAME.replace(/Impl$/, "")))) {
    return true;
  }
  const { owner } = await getNamedAccounts();

  await deploy(DEPLOYMENT_NAME, {
    contract: "AIGasTank",
    from: owner,
    args: [hre.network.config.aiGasTankToken],
    log: true,
    estimateGasExtra: 10000,
    deterministicDeployment: ethers.keccak256(ethers.getBytes(ethers.toUtf8Bytes(DEPLOYMENT_NAME))),
    waitConfirmations: 1,
    ...(await getGasConfiguration(hre.ethers.provider)),
  });
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = [];
export default func;
