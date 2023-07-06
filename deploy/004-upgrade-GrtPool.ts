import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";
import { getGasConfiguration } from "../lib/gas";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { owner } = await getNamedAccounts();
  const impl = await deployments.get("GrtPoolImpl");
  const proxy = await deployments.get("GrtPool");
  const factory = await ethers.getContractFactory("GrtPoolV2");
  const GrtPool = factory.attach(proxy.address).connect(await hre.ethers.getSigner(owner));
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
    console.log(`Upgrading implementation of GrtPool (${GrtPool.address}) to ${impl.address}`);
    await GrtPool.upgradeTo(impl.address, await getGasConfiguration(hre.ethers.provider)).then((x) =>
      x.wait()
    );
    await hre.upgrades.forceImport(GrtPool.address, factory, {
      kind: "uups",
    });
  }
};
func.tags = ["upgrade-GrtPool"];
func.dependencies = ["GrtPool", "GrtPoolImpl"];
export default func;
