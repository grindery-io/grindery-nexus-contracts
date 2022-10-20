import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();
  const stub = await deployments.get("ERC1967Stub");
  const impl = await deployments.get("GrinderyNexusHubImpl");

  const result = await deploy("GrinderyNexusHub", {
    contract: "ERC1967Proxy",
    from: owner,
    args: [stub.address, "0x"],
    log: true,
    deterministicDeployment: ethers.utils.keccak256(
      ethers.utils.arrayify(ethers.utils.toUtf8Bytes("GrinderyNexusHub"))
    ),
    waitConfirmations: 1,
    gasPrice: await hre.ethers.provider.getGasPrice(),
  });
  const factory = await ethers.getContractFactory("GrinderyNexusHub");
  const GrinderyNexusHub = factory.attach(result.address);
  try {
    await GrinderyNexusHub.upgradeToAndCall(
      impl.address,
      GrinderyNexusHub.interface.encodeFunctionData("initialize", [owner]),
      {
        gasPrice: await hre.ethers.provider.getGasPrice(),
      }
    ).then((x) => x.wait());
  } catch (e) {
    // The contract may be already deployed before, if it is in correct state, the next script should succeed
  }
  await hre.upgrades.forceImport(GrinderyNexusHub.address, factory, {
    kind: "uups",
    ...{ constructorArgs: [owner] },
  });
  return true;
};
func.id = "GrinderyNexusHub";
func.tags = ["GrinderyNexusHub"];
func.dependencies = ["DeterministicDeploymentProxy", "ERC1967Stub", "GrinderyNexusHubImpl"];
export default func;
