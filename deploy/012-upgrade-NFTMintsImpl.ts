import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";
import { getGasConfiguration } from "../lib/gas";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { operator } = await getNamedAccounts();
  const impl = await deployments.get("NFTMintsImpl");
  const proxy = await deployments.get("NFTMints");
  const factory = await ethers.getContractFactory("NFTMints");
  const NFTMints = factory.attach(proxy.address);
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
    console.log(`Upgrading implementation of NFTMints (${NFTMints.address}) to ${impl.address}`);
    await NFTMints.upgradeTo(impl.address, await getGasConfiguration(hre.ethers.provider)).then((x) =>
      x.wait()
    );
    await hre.upgrades.forceImport(NFTMints.address, factory, {
      kind: "uups",
    });
  }
  if ((await NFTMints.getOperator()) !== operator) {
    console.log(`Setting operator of NFTMints (${NFTMints.address}) to ${operator}`);
    await NFTMints.setOperator(operator, await getGasConfiguration(hre.ethers.provider)).then((tx) =>
      tx.wait()
    );
  }
};
func.tags = ["upgrade-NFTMintsImpl"];
func.dependencies = ["NFTMints", "NFTMintsImpl"];
export default func;
