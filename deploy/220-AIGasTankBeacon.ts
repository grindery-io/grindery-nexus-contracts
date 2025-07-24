import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { getGasConfiguration } from "../lib/gas";
import assert from "assert";

const DEPLOYMENT_NAME = "AIGasTankBeacon";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (!["polygon", "amoy", "hardhat"].includes(hre.network.name)) {
    return true;
  }
  if (!hre.network.config.gxTokenAddress) {
    return true;
  }

  const { getNamedAccounts, deployments, ethers } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();

  assert(typeof hre.config.deterministicDeployment === "function", "deterministicDeployment is not set");

  await deploy(DEPLOYMENT_NAME, {
    contract: "UpgradeableBeacon",
    from: owner,
    args: [hre.config.deterministicDeployment(hre.network.name)?.factory, owner],
    log: true,
    estimateGasExtra: 10000,
    deterministicDeployment: ethers.keccak256(ethers.getBytes(ethers.toUtf8Bytes(DEPLOYMENT_NAME + "USDC"))),
    waitConfirmations: 1,
    ...(await getGasConfiguration(hre.ethers.provider)),
  });
  return true;
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = [];
export default func;
