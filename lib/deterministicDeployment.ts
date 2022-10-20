import { ethers, Signer } from "ethers";
import { DETERMINISTIC_DEPLOYMENT_KEY } from "../secrets";
import { getGasConfiguration } from "./gas";
import { verifyContractAddress } from "./verify";

const nonce = 0;
const value = 0;
const data = ethers.utils.arrayify(
  "0x604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"
);

if (!DETERMINISTIC_DEPLOYMENT_KEY) {
  console.warn("Using test key for deterministic deployment setup");
}
const signer = new ethers.Wallet(
  DETERMINISTIC_DEPLOYMENT_KEY || ethers.utils.keccak256(ethers.utils.toUtf8Bytes("TEST"))
);

const signerAddress = signer.address;
const contractAddress = ethers.utils.getContractAddress({ from: signerAddress, nonce });

export const ensureDeploymentProxy = async function (owner: Signer) {
  if (!owner.provider) {
    throw new Error("Provider is not available");
  }
  verifyContractAddress(await owner.getChainId(), "DETERMINISTIC_DEPLOYMENT_PROXY", contractAddress);
  if ((await owner.provider.getCode(contractAddress).catch(() => "0x")) !== "0x") {
    return;
  }
  console.log(`Deploying deployment proxy...`);
  const signerWithProvider = signer.connect(owner.provider);
  const { maxFeePerGas, maxPriorityFeePerGas } = await getGasConfiguration(owner.provider);
  const gasLimit = (await owner.provider.estimateGas({ data })).mul(13).div(10);
  const funding = gasLimit.mul(maxFeePerGas);
  const balance = await signerWithProvider.getBalance();
  if (balance.lt(funding)) {
    const amount = balance.mul(-1).add(funding);
    console.log(`Sending gas fund ${ethers.utils.formatEther(amount)} to ${signerAddress}`);
    await (
      await owner.sendTransaction({
        to: signerAddress,
        value: amount,
        maxFeePerGas,
        maxPriorityFeePerGas,
        chainId: await owner.getChainId(),
      })
    ).wait();
  }
  const tx = await (
    await signerWithProvider.sendTransaction({
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasLimit,
      value,
      data,
      chainId: await owner.getChainId(),
    })
  ).wait();
  if ((await owner.provider.getCode(contractAddress).catch(() => "0x")) === "0x") {
    throw new Error("Failed to deploy deployment proxy to expected address");
  }
  console.log(`Deployed deployment proxy at ${contractAddress} (tx: ${tx.transactionHash})`);
};

export { signerAddress, contractAddress };
