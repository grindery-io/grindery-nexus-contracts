import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction, DeployOptions } from "hardhat-deploy/types";
import { getGasConfiguration } from "../lib/gas";

const DEPLOYMENT_NAME = "GasTankImpl";
const PROXY_NAME = "GasTank";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments, ethers } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();

  const isPrimaryChain = !!hre.network.config.gasTokenAddress;
  const proxy = await deployments.get(PROXY_NAME);
  const FeeAccountantPrimary = isPrimaryChain ? await deployments.get("FeeAccountantPrimary") : null;

  const options: Partial<DeployOptions> = isPrimaryChain
    ? {
        contract: "LocalGasTank",
        args: [proxy.address, hre.network.config.gasTokenAddress, FeeAccountantPrimary?.address],
      }
    : {
        contract: "RemoteGasTank",
        args: [proxy.address],
      };
  await deploy(DEPLOYMENT_NAME, {
    ...options,
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
func.dependencies = [PROXY_NAME, "FeeAccountantPrimary"];
export default func;
