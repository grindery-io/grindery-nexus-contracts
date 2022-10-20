import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();
  await hre.upgrades.validateImplementation(await ethers.getContractFactory("GrinderyNexusHub"), {
    kind: "uups",
    unsafeAllow: ["constructor"],
    ...{ constructorArgs: [owner] },
  });
  await deploy("GrinderyNexusHubImpl", {
    contract: "GrinderyNexusHub",
    from: owner,
    args: [owner],
    log: true,
    waitConfirmations: 1,
    gasPrice: await hre.ethers.provider.getGasPrice(),
  });
};
func.tags = ["GrinderyNexusHubImpl"];
export default func;
