import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { getGasConfiguration } from "../lib/gas";
import { MultiECDSAFactoryGrindery__factory } from "../typechain-types";

const CONTRACT_NAME = "MultiECDSAFactoryGrindery";
const DEPLOYMENT_NAME = CONTRACT_NAME + "-setOwner";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (hre.network.name === "hardhat") {
    return true;
  }
  const { getNamedAccounts, deployments, ethers } = hre;
  const { owner } = await getNamedAccounts();
  const ownerSigner = await ethers.getSigner(owner);
  if (!hre.network.config.txSigner) {
    throw new Error("txSigner is not set");
  }
  const txSigner = ethers.getAddress(hre.network.config.txSigner);

  const factory = await deployments.get(CONTRACT_NAME);
  const factoryInstance = MultiECDSAFactoryGrindery__factory.connect(factory.address, ownerSigner);
  const owners = await factoryInstance.getOwners();
  if (owners.length !== 1 || ethers.getAddress(owners[0]) !== txSigner) {
    deployments.log(`Setting owner for ${CONTRACT_NAME}`);
    await factoryInstance
      .setOwners([txSigner], { ...(await getGasConfiguration(ownerSigner.provider)) })
      .then((x) => x.wait());
  }
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = [CONTRACT_NAME];
export default func;
