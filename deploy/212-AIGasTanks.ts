import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { getGasConfiguration } from "../lib/gas";

const DEPLOYMENT_NAME = "AIGasTank";
const BEACON_NAME = "AIGasTankBeacon";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments, ethers } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();
  const beacon = await deployments.get(BEACON_NAME);

  await deploy(DEPLOYMENT_NAME, {
    contract: "StaticBeaconProxy",
    from: owner,
    args: [beacon.address],
    log: true,
    estimateGasExtra: 10000,
    deterministicDeployment: ethers.keccak256(ethers.getBytes(ethers.toUtf8Bytes(DEPLOYMENT_NAME))),
    waitConfirmations: 1,
    ...(await getGasConfiguration(hre.ethers.provider)),
  });
  // verifyContractAddress(await hre.network.provider.getChainId(), "HUB", result.address);
  return true;
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = [BEACON_NAME];
export default func;
