import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { getGasConfiguration } from "../lib/gas";
import { UpgradeableBeacon__factory } from "../typechain-types";

const PROXY_NAME = "FeeAccountantPrimary";
const DEPLOYMENT_NAME = PROXY_NAME + "-upgrade";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const isPrimaryChain = !!hre.network.config.gasTokenAddress;
  if (!isPrimaryChain) return true;

  const { getNamedAccounts, deployments, ethers } = hre;
  const { owner } = await getNamedAccounts();
  const ownerSigner = await ethers.getSigner(owner);

  const beacon = await deployments.get(PROXY_NAME + "Beacon");
  const impl = await deployments.get(PROXY_NAME + "Impl");

  const beaconInstance = UpgradeableBeacon__factory.connect(beacon.address, ownerSigner);
  if ((await beaconInstance.implementation().then((x) => x.toLowerCase())) !== impl.address.toLowerCase()) {
    deployments.log(`Upgrading implementation of ${PROXY_NAME} (beacon: ${beacon.address}) to ${impl.address}`);
    await beaconInstance.upgradeTo(impl.address, await getGasConfiguration(hre.ethers.provider)).then((x) => x.wait());
  }
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = [PROXY_NAME + "Beacon", PROXY_NAME + "Impl"];
export default func;
