import { ethers, upgrades } from "hardhat";


async function main() {

    const GRTUpgradeable = await ethers.getContractFactory("GRTUpgradeable")

    // Start deployment, returning a promise that resolves to a contract object
    const grtUpgradeable = await upgrades.deployProxy(GRTUpgradeable);
    await grtUpgradeable.deployed();
    console.log("Contract deployed to address:", grtUpgradeable.address);
    console.log("Name of the token:", await grtUpgradeable.name());
    console.log("Symbol of the token:", await grtUpgradeable.symbol());
    console.log("Owner of the token:", await grtUpgradeable.owner());
}

main()
.then(() => process.exit(0))
.catch((error) => {
    console.error(error)
    process.exit(1)
})
