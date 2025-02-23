import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { FeeAccountantPrimary__factory } from "../typechain-types";
import { getGasConfiguration } from "../lib/gas";

const PROXY_NAME = "FeeAccountantPrimary";
const DEPLOYMENT_NAME = PROXY_NAME + "-setStage2Fee";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const isPrimaryChain = !!hre.network.config.gasTokenAddress;
  if (!isPrimaryChain) return true;
  if (!hre.network.config.stage2Fee) {
    return;
  }

  const { getNamedAccounts, deployments, ethers } = hre;
  const { owner } = await getNamedAccounts();
  const ownerSigner = await ethers.getSigner(owner);

  const proxy = await deployments.get(PROXY_NAME);
  const proxyInstance = FeeAccountantPrimary__factory.connect(proxy.address, ownerSigner);

  const [fixedFee, feeNumerator, feeDenominator] = await proxyInstance.getStage2Fee();

  if (
    fixedFee !== hre.network.config.stage2Fee.fixedFee ||
    feeNumerator !== hre.network.config.stage2Fee.feeNumerator ||
    feeDenominator !== hre.network.config.stage2Fee.feeDenominator
  ) {
    deployments.log(
      `Setting stage2Fee to ${hre.network.config.stage2Fee.fixedFee}/${hre.network.config.stage2Fee.feeNumerator}/${hre.network.config.stage2Fee.feeDenominator}`
    );
    await proxyInstance
      .setStage2Fee(
        hre.network.config.stage2Fee.fixedFee,
        hre.network.config.stage2Fee.feeNumerator,
        hre.network.config.stage2Fee.feeDenominator,
        await getGasConfiguration(hre.ethers.provider)
      )
      .then((x) => x.wait());
  }
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = [PROXY_NAME, PROXY_NAME + "-upgrade", PROXY_NAME + "-initialization"];
export default func;
