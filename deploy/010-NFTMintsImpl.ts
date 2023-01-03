import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";
import { getGasConfiguration } from "../lib/gas";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();
  await hre.upgrades.validateImplementation(await ethers.getContractFactory("NFTMints"), {
    kind: "uups",
  });
  await deploy("NFTMintsImpl", {
    contract: "NFTMints",
    from: owner,
    log: true,
    estimateGasExtra: 10000,
    waitConfirmations: 1,
    deterministicDeployment: ethers.utils.keccak256(
      ethers.utils.arrayify(ethers.utils.toUtf8Bytes("NFTMintsImpl"))
    ),
    ...(await getGasConfiguration(hre.ethers.provider)),
  });
};
func.tags = ["NFTMintsImpl"];
export default func;
