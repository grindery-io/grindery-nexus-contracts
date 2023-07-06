import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";
import { getGasConfiguration } from "../lib/gas";
import { verifyContractAddress } from "../lib/verify";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();
  const stub = await deployments.get("ERC1967Stub");
  const impl = await deployments.get("GrtPoolImpl");

  const result = await deploy("GrtPool", {
    contract: "ERC1967Proxy",
    from: owner,
    args: [stub.address, "0x"],
    log: true,
    deterministicDeployment: ethers.utils.keccak256(
      ethers.utils.arrayify(ethers.utils.toUtf8Bytes("GrtPool"))
    ),
    waitConfirmations: 1,
    ...(await getGasConfiguration(hre.ethers.provider)),
  });
  verifyContractAddress(await hre.getChainId(), "POOL", result.address);
  const factory = await ethers.getContractFactory("GrtPoolV2");
  const GrtPool = factory.attach(result.address).connect(await hre.ethers.getSigner(owner));
  const currentImplAddress = ethers.BigNumber.from(
    await hre.ethers.provider.getStorageAt(
      result.address,
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
    )
  );
  if (currentImplAddress.eq(stub.address)) {
    await GrtPool.upgradeToAndCall(
      impl.address,
      GrtPool.interface.encodeFunctionData("initialize", [owner]),
      await getGasConfiguration(hre.ethers.provider)
    ).then((x) => x.wait());
  } else if ((await GrtPool.owner()) === "0x0000000000000000000000000000000000000000") {
    console.log("Calling initialize only");
    await GrtPool.initialize(owner, await getGasConfiguration(hre.ethers.provider)).then((x) => x.wait());
  }
  await hre.upgrades.forceImport(GrtPool.address, factory, {
    kind: "uups",
  });
  return true;
};
func.id = "GrtPool";
func.tags = ["GrtPool"];
func.dependencies = ["DeterministicDeploymentProxy", "ERC1967Stub", "GrtPoolImpl"];
export default func;
