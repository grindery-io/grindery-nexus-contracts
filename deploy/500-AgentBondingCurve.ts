import { getBytes, keccak256, parseUnits, toUtf8Bytes } from "ethers";
import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { getGasConfiguration } from "../lib/gas";

const DEPLOYMENT_NAME = "AgentBondingCurve";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments, ethers } = hre;
  const { deploy } = deployments;

  const gxTokenAddress = "0x8730762Cad4a27816A467fAc54e3dd1E2e9617A1";
  const treasuryAddress = ""; //Treasury Contract Address
  const P_max = parseUnits("1", 18);
  const S_mid = parseUnits("500000", 18);
  const k = parseUnits("0.00001", 18);
  const C = parseUnits("0", 18);
  const fee = 100;

  const { owner } = await getNamedAccounts();

  const args = [
    gxTokenAddress,
    treasuryAddress,
    P_max,
    S_mid,
    k,
    C,
    fee,
  ];

  await deploy(DEPLOYMENT_NAME, {
    contract: DEPLOYMENT_NAME,
    from: owner,
    args,
    log: true,
    estimateGasExtra: 10000,
    deterministicDeployment: keccak256(getBytes(toUtf8Bytes(DEPLOYMENT_NAME))),
    waitConfirmations: 1,
    ...(await getGasConfiguration(hre.ethers.provider)),
  });

  return true;
};

func.id = DEPLOYMENT_NAME;
func.tags = [DEPLOYMENT_NAME];
func.dependencies = [];

export default func;
