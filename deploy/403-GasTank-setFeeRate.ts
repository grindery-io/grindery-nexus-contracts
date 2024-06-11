import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { getGasConfiguration } from "../lib/gas";
import { BaseGasTank__factory } from "../typechain-types";

const PROXY_NAME = "GasTank";
const DEPLOYMENT_NAME = PROXY_NAME + "-setFeeRate";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments, ethers } = hre;
  const { owner } = await getNamedAccounts();
  const ownerSigner = await ethers.getSigner(owner);

  const proxy = await deployments.get(PROXY_NAME);
  const proxyInstance = BaseGasTank__factory.connect(proxy.address, ownerSigner);
  const FEE_NUMERATOR = hre.network.config.feeNumerator || 1n;
  const FEE_DENOMINATOR = hre.network.config.feeDenominator || 1n;
  const BASE_GAS = hre.network.config.baseGas || 180000n;
  const { _feeNumerator, _feeDenominator, _baseGas } = await proxyInstance.getFeeRate();
  if (_feeNumerator !== FEE_NUMERATOR || _feeDenominator !== FEE_DENOMINATOR || _baseGas !== BASE_GAS) {
    deployments.log(`Updating fee rate of ${PROXY_NAME}: ${FEE_NUMERATOR}/${FEE_DENOMINATOR}/${BASE_GAS}`);
    await proxyInstance.setFeeRate(FEE_NUMERATOR, FEE_DENOMINATOR, BASE_GAS).then((x) => x.wait());
  }
};
func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = [PROXY_NAME, PROXY_NAME + "-upgrade", PROXY_NAME + "-initialization"];
export default func;
