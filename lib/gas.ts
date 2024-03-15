import { Provider, ethers } from "ethers";

export async function getGasConfiguration(provider: Provider): Promise<
  | {
      maxFeePerGas: string;
      maxPriorityFeePerGas: string;
    }
  | { gasPrice: string }
> {
  if ((await provider.getNetwork()).chainId === 42161n) {
    return {
      maxFeePerGas: ethers.parseUnits("0.11", "gwei").toString(),
      maxPriorityFeePerGas: "0",
    };
  }
  let { maxFeePerGas, maxPriorityFeePerGas, gasPrice } = await provider.getFeeData();
  if (!maxFeePerGas || !maxPriorityFeePerGas) {
    if (!gasPrice) {
      throw new Error("No gas price");
    }
    return { gasPrice: gasPrice.toString() };
  }
  return {
    maxFeePerGas: (maxFeePerGas + ethers.parseUnits("20", "gwei")).toString(),
    maxPriorityFeePerGas: (maxPriorityFeePerGas + ethers.parseUnits("10", "gwei")).toString(),
  };
}
