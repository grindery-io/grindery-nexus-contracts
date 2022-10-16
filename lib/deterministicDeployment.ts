import { ethers, Signer } from "ethers";

const nonce = 0;
const gasPrice = process.env.GAS_PRICE || 100 * 10 ** 9;
// actual gas costs last measure: 59159; we don't want to run too close though because gas costs can change in forks and we want our address to be retained
const gasLimit = process.env.GAS_LIMIT || 100000;
const value = 0;
const data = ethers.utils.arrayify(
  "0x604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"
);

const signer = new ethers.Wallet(ethers.utils.keccak256(ethers.utils.toUtf8Bytes("TEST")));

const signerAddress = signer.address;
const contractAddress = ethers.utils.getContractAddress({ from: signerAddress, nonce });
const funding = ethers.BigNumber.from(gasLimit).mul(gasPrice).toHexString();

export const ensureDeploymentProxy = async function (owner: Signer) {
  if (!owner.provider) {
    throw new Error("Provider is not available");
  }
  if ((await owner.provider.getCode(contractAddress).catch(() => "0x")) !== "0x") {
    return;
  }
  console.log(`Deploying deployment proxy...`);
  const signerWithProvider = signer.connect(owner.provider);
  const balance = await signerWithProvider.getBalance();
  if (balance.lte(funding)) {
    const amount = balance.mul(-1).add(funding);
    console.log(`Sending gas fund ${ethers.utils.formatEther(amount)} to ${signerAddress}`);
    await owner.sendTransaction({
      to: signerAddress,
      value: amount,
      chainId: await owner.getChainId(),
    });
  }
  const tx = await signerWithProvider.sendTransaction({
    nonce,
    gasPrice,
    gasLimit,
    value,
    data,
    chainId: await owner.getChainId(),
  });
  if ((await owner.provider.getCode(contractAddress).catch(() => "0x")) === "0x") {
    throw new Error("Failed to deploy deployment proxy to expected address");
  }
  console.log(`Deployed deployment proxy at ${contractAddress} (tx: ${tx.hash})`);
};

export { signerAddress, contractAddress, funding };
