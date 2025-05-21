import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { getGasConfiguration } from "../lib/gas";
import { AIGasTank__factory } from "../typechain-types";

const PROXY_NAME = "AIGasTank";
const DEPLOYMENT_NAME = PROXY_NAME + "-addOperator";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (!hre.network.config.aiGasTankOperator) {
    return;
  }
  const { getNamedAccounts, deployments, ethers } = hre;
  if (!(await deployments.getOrNull(PROXY_NAME))) {
    return true;
  }
  const { owner } = await getNamedAccounts();
  const ownerSigner = await ethers.getSigner(owner);

  const proxy = await deployments.get(PROXY_NAME);
  const proxyInstance = AIGasTank__factory.connect(proxy.address, ownerSigner);

  if (
    !(await proxyInstance.hasRole(
      await proxyInstance.ROLE_OPERATOR(),
      ethers.getAddress(hre.network.config.aiGasTankOperator)
    ))
  ) {
    deployments.log(`Granting operator role of ${PROXY_NAME} to ${hre.network.config.aiGasTankOperator}`);
    await proxyInstance
      .grantRole(
        await proxyInstance.ROLE_OPERATOR(),
        hre.network.config.aiGasTankOperator,
        await getGasConfiguration(hre.ethers.provider)
      )
      .then((x) => x.wait());
  }
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = [PROXY_NAME + "Beacon", PROXY_NAME + "Impl"];
export default func;
