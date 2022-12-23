import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import {
  ensureDeploymentProxy,
  contractAddress,
} from "../lib/deterministicDeployment";
import { ethers } from "hardhat";
import { getGasConfiguration } from "../lib/gas";

const func: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { getNamedAccounts, deployments } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();

  await deploy("NFTMints", {
    contract: "NFTMints",
    from: owner,
    log: true,
    estimateGasExtra: 10000,
    waitConfirmations: 1,
    deterministicDeployment: ethers.utils.keccak256(
      ethers.utils.arrayify(ethers.utils.toUtf8Bytes("NFTMint"))
    ),
    ...(await getGasConfiguration(hre.ethers.provider)),
  });
};
func.id = "NFTMints";
func.tags = ["NFTMints"];
func.dependencies = ["DeterministicDeploymentProxy"];
export default func;