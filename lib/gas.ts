import { Provider, ethers } from "ethers";

export async function getGasConfiguration(provider: Provider): Promise<
  | {
      maxFeePerGas: string;
      maxPriorityFeePerGas: string;
    }
  | { gasPrice: string }
> {
  const block = await provider.getBlock("latest", true);
  if (!block) {
    throw new Error("No block");
  }
  if (typeof block.baseFeePerGas !== "bigint") {
    let { gasPrice } = await provider.getFeeData();
    if (!gasPrice) {
      throw new Error("No gas price");
    }
    return { gasPrice: ((gasPrice * 12n) / 10n).toString() };
  }
  const baseFee = (block.baseFeePerGas * 13n) / 10n;
  if (block.transactions.length === 0) {
    const extraFee = ethers.parseUnits("0.0001", "gwei");
    return { maxFeePerGas: (baseFee + extraFee).toString(), maxPriorityFeePerGas: extraFee.toString() };
  }
  if (!block.prefetchedTransactions.length) {
    throw new Error("No prefetched transactions");
  }
  let sum = 0n;
  for (const tx of block.prefetchedTransactions) {
    sum += tx.maxPriorityFeePerGas || 0n;
  }
  if (sum === 0n) {
    throw new Error("No priority fee");
  }
  const priorityFee = ((sum / BigInt(block.prefetchedTransactions.length)) * 15n) / 10n;
  console.log({ baseFee: ethers.formatUnits(baseFee, "gwei"), priorityFee: ethers.formatUnits(priorityFee, "gwei") });
  return {
    maxFeePerGas: (baseFee + priorityFee).toString(),
    maxPriorityFeePerGas: priorityFee.toString(),
  };
}
