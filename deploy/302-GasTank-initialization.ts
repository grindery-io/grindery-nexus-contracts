import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { BaseGasTank__factory } from "../typechain-types";
import { getGasConfiguration } from "../lib/gas";

const PROXY_NAME = "GasTank";
const DEPLOYMENT_NAME = PROXY_NAME + "-initialization";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments, ethers } = hre;
  const { owner } = await getNamedAccounts();
  const ownerSigner = await ethers.getSigner(owner);

  const proxy = await deployments.get(PROXY_NAME);
  const proxyInstance = BaseGasTank__factory.connect(proxy.address, ownerSigner);
  if ((await proxyInstance.owner()) === ethers.ZeroAddress) {
    deployments.log(`Initializing ${PROXY_NAME}`);
    await proxyInstance.initialize(1, 1, 130000, await getGasConfiguration(hre.ethers.provider)).then((x) => x.wait());
  }
  return true;
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = [PROXY_NAME];
export default func;
