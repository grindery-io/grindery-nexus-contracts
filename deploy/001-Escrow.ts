import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";
import { getGasConfiguration } from "../lib/gas";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();
  await deploy("Escrow", {
    contract: "Escrow",
    from: owner,
    log: true,
    estimateGasExtra: 10000,
    waitConfirmations: 1,
    deterministicDeployment: ethers.keccak256(ethers.getBytes(ethers.toUtf8Bytes("Escrow"))),
    ...(await getGasConfiguration(hre.ethers.provider)),
  });
};
func.tags = ["Escrow"];
export default func;
