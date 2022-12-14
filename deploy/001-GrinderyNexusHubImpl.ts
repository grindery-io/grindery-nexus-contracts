import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";
import { getGasConfiguration } from "../lib/gas";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();
  await hre.upgrades.validateImplementation(await ethers.getContractFactory("GrinderyNexusHub"), {
    kind: "uups",
  });
  await deploy("GrinderyNexusHubImpl", {
    contract: "GrinderyNexusHub",
    from: owner,
    log: true,
    estimateGasExtra: 10000,
    waitConfirmations: 1,
    deterministicDeployment: ethers.utils.keccak256(
      ethers.utils.arrayify(ethers.utils.toUtf8Bytes("GrinderyNexusHubImpl"))
    ),
    ...(await getGasConfiguration(hre.ethers.provider)),
  });
};
func.tags = ["GrinderyNexusHubImpl"];
export default func;
