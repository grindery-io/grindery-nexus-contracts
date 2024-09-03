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
  if (typeof block.baseFeePerGas !== "bigint" || block.baseFeePerGas === 0n) {
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
  let sum = 1n;
  for (const tx of block.prefetchedTransactions) {
    if (tx.gasPrice) {
      sum += tx.gasPrice - block.baseFeePerGas;
      if (sum < 0n) {
        sum = 1n;
      }
    } else {
      sum += tx.maxPriorityFeePerGas === null ? 0n : tx.maxPriorityFeePerGas || 1n;
    }
  }
  const priorityFee = ((sum / BigInt(block.prefetchedTransactions.length)) * 15n) / 10n;
  return {
    maxFeePerGas: (baseFee + priorityFee).toString(),
    maxPriorityFeePerGas: priorityFee.toString(),
  };
}
