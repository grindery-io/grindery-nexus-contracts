import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments } = hre;
  const impl = await deployments.get("GrinderyNexusHubImpl");
  const proxy = await deployments.get("GrinderyNexusHub");
  const GrinderyNexusHub = (await ethers.getContractFactory("GrinderyNexusHub")).attach(proxy.address);
  if (
    !ethers.BigNumber.from(
      await hre.ethers.provider.getStorageAt(
        proxy.address,
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
      )
    ).eq(impl.address)
  ) {
    console.log(`Upgrading implementation of GrinderyNexusHub (${GrinderyNexusHub.address}) to ${impl.address}`);
    await GrinderyNexusHub.upgradeTo(impl.address).then((x) => x.wait());
  }
};
func.tags = ["upgrade-GrinderyNexusHub"];
func.dependencies = ["GrinderyNexusHub", "GrinderyNexusHubImpl"];
export default func;
