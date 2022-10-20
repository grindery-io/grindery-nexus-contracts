import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre;
  const { deploy } = deployments;
  const { owner, operator } = await getNamedAccounts();
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
  });
  const GrinderyNexusHub = (await ethers.getContractFactory("GrinderyNexusHub")).attach(result.address);
  await GrinderyNexusHub.upgradeToAndCall(
    impl.address,
    GrinderyNexusHub.interface.encodeFunctionData("initialize", [owner])
  ).then((x) => x.wait());
  await GrinderyNexusHub.setOperator(operator);
  return true;
};
func.id = "GrinderyNexusHub";
func.tags = ["GrinderyNexusHub"];
func.dependencies = ["DeterministicDeploymentProxy", "ERC1967Stub", "GrinderyNexusHubImpl"];
export default func;
