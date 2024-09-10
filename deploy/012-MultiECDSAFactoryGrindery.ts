import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { getGasConfiguration } from "../lib/gas";
import { EntryPoint } from "userop/dist/v06";

const DEPLOYMENT_NAME = "MultiECDSAFactoryGrindery";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments, ethers } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();

  const kernel = await deployments.get("Kernel");
  const validator = await deployments.get("MultiECDSAValidatorNew");

  await deploy(DEPLOYMENT_NAME, {
    contract: DEPLOYMENT_NAME,
    from: owner,
    args: [owner, EntryPoint.DEFAULT_ADDRESS, kernel.address, validator.address],
    log: true,
    estimateGasExtra: 10000,
    deterministicDeployment: ethers.keccak256(ethers.getBytes(ethers.toUtf8Bytes(DEPLOYMENT_NAME))),
    waitConfirmations: 1,
    ...(await getGasConfiguration(hre.ethers.provider)),
  });
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = ["Kernel", "MultiECDSAValidatorNew"];
export default func;
