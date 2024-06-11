import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { FeeAccountantPrimary__factory } from "../typechain-types";
import { getGasConfiguration } from "../lib/gas";

const PROXY_NAME = "FeeAccountantPrimary";
const DEPLOYMENT_NAME = PROXY_NAME + "-addOperator";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const isPrimaryChain = !!hre.network.config.gasTokenAddress;
  if (!isPrimaryChain) return true;

  if (!hre.network.config.feeAccountantOperator) {
    return;
  }

  const { getNamedAccounts, deployments, ethers } = hre;
  const { owner } = await getNamedAccounts();
  const ownerSigner = await ethers.getSigner(owner);

  const proxy = await deployments.get(PROXY_NAME);
  const proxyInstance = FeeAccountantPrimary__factory.connect(proxy.address, ownerSigner);

  if (
    !(await proxyInstance.hasRole(
      await proxyInstance.ROLE_OPERATOR(),
      ethers.getAddress(hre.network.config.feeAccountantOperator)
    ))
  ) {
    deployments.log(`Granting signer role of FeeAccountantPrimary to ${hre.network.config.feeAccountantOperator}`);
    await proxyInstance
      .grantRole(
        await proxyInstance.ROLE_OPERATOR(),
        hre.network.config.feeAccountantOperator,
        await getGasConfiguration(hre.ethers.provider)
      )
      .then((x) => x.wait());
  }
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = [PROXY_NAME, PROXY_NAME + "-upgrade", PROXY_NAME + "-initialization"];
export default func;
