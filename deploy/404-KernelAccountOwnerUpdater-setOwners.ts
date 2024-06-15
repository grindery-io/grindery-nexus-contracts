import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { getGasConfiguration } from "../lib/gas";
import { KernelAccountOwnerUpdater__factory } from "../typechain-types";
import _ from "lodash";

const PROXY_NAME = "KernelAccountOwnerUpdater";
const DEPLOYMENT_NAME = PROXY_NAME + "-setOwners";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments, ethers } = hre;
  const { owner } = await getNamedAccounts();
  const ownerSigner = await ethers.getSigner(owner);
  const OWNERS = [hre.network.config.txSigner || "0x1111111111111111111111111111111111111111"].map(ethers.getAddress);
  const OWNERS_TO_DISABLE = (hre.network.config.txSignersToDisable || []).map(ethers.getAddress);

  const proxy = await deployments.get(PROXY_NAME);
  const proxyInstance = KernelAccountOwnerUpdater__factory.connect(proxy.address, ownerSigner);
  const currentOwners = await proxyInstance.getOwners();
  const currentOwnersToDisable = await proxyInstance.getOwnersToDisable();
  if (_.xor(currentOwners, OWNERS).length || _.xor(currentOwnersToDisable, OWNERS_TO_DISABLE).length) {
    deployments.log(
      `Updating owners of ${PROXY_NAME}: adding ${OWNERS.join(", ") || "(none)"} and removing ${OWNERS_TO_DISABLE || "(none)"}`
    );
    await proxyInstance
      .setOwners(OWNERS, OWNERS_TO_DISABLE, await getGasConfiguration(hre.ethers.provider))
      .then((x) => x.wait());
  }
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = [PROXY_NAME, PROXY_NAME + "-upgrade", PROXY_NAME + "-initialization"];
export default func;
