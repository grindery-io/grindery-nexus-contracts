import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { FeeAccountantPrimary__factory } from "../typechain-types";
import { getGasConfiguration } from "../lib/gas";

const PROXY_NAME = "FeeAccountantPrimary";
const DEPLOYMENT_NAME = PROXY_NAME + "-setPriceFeed";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const isPrimaryChain = !!hre.network.config.gasTokenAddress;
  if (!isPrimaryChain) return true;

  const { getNamedAccounts, deployments, ethers } = hre;
  const { owner } = await getNamedAccounts();
  const ownerSigner = await ethers.getSigner(owner);

  const proxy = await deployments.get(PROXY_NAME);
  const proxyInstance = FeeAccountantPrimary__factory.connect(proxy.address, ownerSigner);

  for (const [id, address] of Object.entries(hre.network.config.priceFeeds || {})) {
    if ((await proxyInstance.getPriceFeed(id).then((x) => x.toLowerCase())) !== address.toLowerCase()) {
      deployments.log(`Setting price feed for chain ${id} to ${address}`);
      await proxyInstance
        .setPriceFeed(id, address, await getGasConfiguration(hre.ethers.provider))
        .then((x) => x.wait());
    }
  }
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = [PROXY_NAME, PROXY_NAME + "-upgrade", PROXY_NAME + "-initialization"];
export default func;
