import { task } from "hardhat/config";

task("setFirstMintERC20", "Set first ERC20 mint")
    .addParam("address", "The ERC20 contract address")
    .setAction(async (taskArgs, hre) => {
    const { getNamedAccounts, ethers } = hre;
    const { owner } = await getNamedAccounts();
    const funToken = await ethers.getContractAt('GRTUpgradeable', taskArgs.address);
    const tx = await funToken.mint(owner, 10);
    await tx.wait();
    console.log("tx", tx);
});
