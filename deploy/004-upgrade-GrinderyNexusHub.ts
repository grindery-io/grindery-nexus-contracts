import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";
import { getGasConfiguration } from "../lib/gas";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { operator, owner } = await getNamedAccounts();
  const impl = await deployments.get("GrinderyNexusHubImpl");
  const proxy = await deployments.get("GrinderyNexusHub");
  const factory = await ethers.getContractFactory("GrinderyNexusHub");
  const GrinderyNexusHub = factory.attach(proxy.address).connect(await hre.ethers.getSigner(owner));
  await hre.upgrades.validateUpgrade(proxy.address, factory, {
    kind: "uups",
  });
  if (
    !ethers.BigNumber.from(
      await hre.ethers.provider.getStorageAt(
        proxy.address,
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
      )
    ).eq(impl.address)
  ) {
    console.log(`Upgrading implementation of GrinderyNexusHub (${GrinderyNexusHub.address}) to ${impl.address}`);
    await GrinderyNexusHub.upgradeTo(impl.address, await getGasConfiguration(hre.ethers.provider)).then((x) =>
      x.wait()
    );
    await hre.upgrades.forceImport(GrinderyNexusHub.address, factory, {
      kind: "uups",
    });
  }
  if ((await GrinderyNexusHub.getOperator()) !== operator) {
    console.log(`Setting operator of GrinderyNexusHub (${GrinderyNexusHub.address}) to ${operator}`);
    await GrinderyNexusHub.setOperator(operator, await getGasConfiguration(hre.ethers.provider)).then((tx) =>
      tx.wait()
    );
  }
};
func.tags = ["upgrade-GrinderyNexusHub"];
func.dependencies = ["GrinderyNexusHub", "GrinderyNexusHubImpl"];
export default func;
