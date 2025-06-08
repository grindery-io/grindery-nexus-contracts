import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { getGasConfiguration } from "../lib/gas";

const DEPLOYMENT_NAME = "GrinderyGenesisNFT";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (!hre.network.config.genesisOwner) {
    return true;
  }

  const { getNamedAccounts, deployments, ethers } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();

  await deploy(DEPLOYMENT_NAME, {
    contract: DEPLOYMENT_NAME,
    from: owner,
    args: [hre.network.config.genesisOwner],
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
