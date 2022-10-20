import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { getNamedAccounts, deployments } = hre;
  const { deploy } = deployments;
  const { owner } = await getNamedAccounts();

  const stub = await deployments.get("ERC1967Stub");
  await deploy("GrinderyNexusDroneBeacon", {
    contract: "GrinderyNexusDroneBeacon",
    from: owner,
    args: [stub.address, owner],
    log: true,
    deterministicDeployment: ethers.utils.keccak256(
      ethers.utils.arrayify(ethers.utils.toUtf8Bytes("GrinderyNexusDroneBeacon"))
    ),
    waitConfirmations: 1,
  });
  return true;
};
func.id = "GrinderyNexusDroneBeacon";
func.tags = ["GrinderyNexusDroneBeacon"];
func.dependencies = ["DeterministicDeploymentProxy", "ERC1967Stub"];
export default func;
