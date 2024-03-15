import { ethers, Signer } from "ethers";
import { DETERMINISTIC_DEPLOYMENT_KEY } from "../secrets";
import { getGasConfiguration } from "./gas";
import { verifyContractAddress } from "./verify";

const nonce = 0;
const value = 0;
const data =
  "0x604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

if (!DETERMINISTIC_DEPLOYMENT_KEY) {
  console.warn("Using test key for deterministic deployment setup");
}
const signer = new ethers.Wallet(DETERMINISTIC_DEPLOYMENT_KEY || ethers.keccak256(ethers.toUtf8Bytes("TEST")));

const signerAddress = signer.address;
const contractAddress = ethers.getCreateAddress({ from: signerAddress, nonce });

export const ensureDeploymentProxy = async function (owner: Signer) {
  if (!owner.provider) {
    throw new Error("Provider is not available");
  }
  verifyContractAddress((await owner.provider.getNetwork()).chainId, "DETERMINISTIC_DEPLOYMENT_PROXY", contractAddress);
  if ((await owner.provider.getCode(contractAddress).catch(() => "0x")) !== "0x") {
    return;
  }
  console.log(`Deploying deployment proxy...`);
  const signerWithProvider = signer.connect(owner.provider);
  const gasConf = await getGasConfiguration(owner.provider);
  const gasLimit = ((await owner.provider.estimateGas({ data })) * 13n) / 10n;
  const funding =
    gasLimit * ("maxFeePerGas" in gasConf ? BigInt(gasConf.maxFeePerGas) : (BigInt(gasConf.gasPrice) * 11n) / 10n);
  const balance = await owner.provider.getBalance(signer.getAddress());
  const chainId = (await owner.provider.getNetwork()).chainId;
  if (balance < funding) {
    const amount = balance * -1n + funding;
    console.log(`Sending gas fund ${ethers.formatEther(amount)} to ${signerAddress}`);
    await (
      await owner.sendTransaction({
        to: signerAddress,
        value: amount,
        ...gasConf,
        chainId,
      })
    ).wait();
  }
  const tx = await (
    await signerWithProvider.sendTransaction({
      nonce,
      ...gasConf,
      gasLimit,
      value,
      data,
      chainId,
    })
  ).wait();
  if ((await owner.provider.getCode(contractAddress).catch(() => "0x")) === "0x") {
    throw new Error("Failed to deploy deployment proxy to expected address");
  }
  console.log(`Deployed deployment proxy at ${contractAddress} (tx: ${(await tx?.getTransaction())?.hash})`);
};

export { signerAddress, contractAddress };
