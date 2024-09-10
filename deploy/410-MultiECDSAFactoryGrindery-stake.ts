import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { getGasConfiguration } from "../lib/gas";
import { IEntryPoint__factory, MultiECDSAFactoryGrindery__factory } from "../typechain-types";
import { EntryPoint } from "userop/dist/v06";

const CONTRACT_NAME = "MultiECDSAFactoryGrindery";
const DEPLOYMENT_NAME = CONTRACT_NAME + "-stake";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  if (hre.network.name === "hardhat") {
    return true;
  }
  const { getNamedAccounts, deployments, ethers } = hre;
  const { owner } = await getNamedAccounts();
  const ownerSigner = await ethers.getSigner(owner);

  const factory = await deployments.get(CONTRACT_NAME);
  const factoryInstance = MultiECDSAFactoryGrindery__factory.connect(factory.address, ownerSigner);
  const entryPoint = IEntryPoint__factory.connect(EntryPoint.DEFAULT_ADDRESS, ownerSigner);
  const depositInfo = await entryPoint.getDepositInfo(factory.address);
  if (!depositInfo.staked) {
    deployments.log(`Adding stake for ${CONTRACT_NAME}`);
    await factoryInstance
      .addStake(1, { ...(await getGasConfiguration(ownerSigner.provider)), value: "1" })
      .then((x) => x.wait());
  }
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = [CONTRACT_NAME];
export default func;
