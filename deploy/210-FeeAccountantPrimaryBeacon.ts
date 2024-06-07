import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { getGasConfiguration } from "../lib/gas";

const DEPLOYMENT_NAME = "FeeAccountantPrimaryBeacon";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const isPrimaryChain = !!hre.network.config.gasTokenAddress;
  if (!isPrimaryChain) return true;

  const { getNamedAccounts, deployments, ethers } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();
  const stub = await deployments.get("ERC1967Stub");

  await deploy(DEPLOYMENT_NAME, {
    contract: "UpgradeableBeacon",
    from: owner,
    args: [stub.address, owner],
    log: true,
    estimateGasExtra: 10000,
    deterministicDeployment: ethers.keccak256(ethers.getBytes(ethers.toUtf8Bytes(DEPLOYMENT_NAME))),
    waitConfirmations: 1,
    ...(await getGasConfiguration(hre.ethers.provider)),
  });
  return true;
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = ["ERC1967Stub"];
export default func;
