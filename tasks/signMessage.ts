import { task } from "hardhat/config";
import { string } from "hardhat/internal/core/params/argumentTypes";

task("sign-msg", "")
  .addPositionalParam("message", "Message to sign", undefined, string, false)
  .setAction(async (args, hre) => {
    const { getNamedAccounts } = hre;
    const { owner } = await getNamedAccounts();
    const signer = await hre.ethers.getSigner(owner);
    const message = args.message;
    console.log(`Message: ${message}`);
    console.log(`Signature: ${await signer.signMessage(hre.ethers.toUtf8Bytes(message))}`);
  });
