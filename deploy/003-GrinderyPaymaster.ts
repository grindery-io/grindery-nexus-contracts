import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { getGasConfiguration } from "../lib/gas";

const DEPLOYMENT_NAME = "GrinderyPaymaster";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments, ethers } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();

  await deploy(DEPLOYMENT_NAME, {
    contract: DEPLOYMENT_NAME,
    from: owner,
    args: [process.env.PAYMASTER_SIGNER_ADDRESS],
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
