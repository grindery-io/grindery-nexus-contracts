import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { getGasConfiguration } from "../lib/gas";
import { BaseGasTank__factory } from "../typechain-types";

const PROXY_NAME = "GasTank";
const DEPLOYMENT_NAME = PROXY_NAME + "-addSigner";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (!hre.network.config.gasTankSigner) {
    return;
  }
  const { getNamedAccounts, deployments, ethers } = hre;
  const { owner } = await getNamedAccounts();
  const ownerSigner = await ethers.getSigner(owner);

  const proxy = await deployments.get(PROXY_NAME);
  const proxyInstance = BaseGasTank__factory.connect(proxy.address, ownerSigner);
  if (
    !(await proxyInstance.hasRole(
      await proxyInstance.ROLE_SIGNER(),
      ethers.getAddress(hre.network.config.gasTankSigner)
    ))
  ) {
    deployments.log(`Granting signer role of GasTank to ${hre.network.config.gasTankSigner}`);
    await proxyInstance
      .grantRole(
        await proxyInstance.ROLE_SIGNER(),
        hre.network.config.gasTankSigner,
        await getGasConfiguration(hre.ethers.provider)
      )
      .then((x) => x.wait());
  }
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = [PROXY_NAME, PROXY_NAME + "-upgrade", PROXY_NAME + "-initialization"];
export default func;
