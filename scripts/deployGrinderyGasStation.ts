import { ethers, upgrades } from "hardhat";

async function main() {
    /* Deploying the contract to the network. */
    const grinderyGasStation = await (
        await ethers.getContractFactory("GrinderyGasStation")
    ).deploy();
    await grinderyGasStation.deployed();
    /* Printing the address of the contract to the console. */
    console.log("Contract deployed to address:", grinderyGasStation.address);
}

main()
.then(() => process.exit(0))
.catch((error) => {
    console.error(error)
    process.exit(1)
})
