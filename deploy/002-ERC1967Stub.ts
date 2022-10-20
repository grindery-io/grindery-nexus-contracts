import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();

  await deploy("ERC1967Stub", {
    contract: "ERC1967Stub",
    from: owner,
    args: [],
    log: true,
    deterministicDeployment: ethers.utils.keccak256(ethers.utils.arrayify(ethers.utils.toUtf8Bytes("ERC1967Stub"))),
    waitConfirmations: 1,
    gasPrice: await hre.ethers.provider.getGasPrice(),
  });
  return true;
};
func.id = "ERC1967Stub";
func.tags = ["ERC1967Stub"];
func.dependencies = ["DeterministicDeploymentProxy"];
export default func;
