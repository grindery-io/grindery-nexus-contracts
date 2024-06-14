import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction, DeployOptions } from "hardhat-deploy/types";
import { getGasConfiguration } from "../lib/gas";

const PROXY_NAME = "KernelAccountOwnerUpdater";
const DEPLOYMENT_NAME = PROXY_NAME + "Impl";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments, ethers } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();

  const proxy = await deployments.get(PROXY_NAME);

  await deploy(DEPLOYMENT_NAME, {
    contract: PROXY_NAME,
    args: [proxy.address, "0x9392C6a8A0b5d49cc697B8242d477509bAE16700"],
    from: owner,
    log: true,
    estimateGasExtra: 10000,
    deterministicDeployment: ethers.keccak256(ethers.getBytes(ethers.toUtf8Bytes(DEPLOYMENT_NAME))),
    waitConfirmations: 1,
    ...(await getGasConfiguration(hre.ethers.provider)),
  });
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = [PROXY_NAME];
export default func;
