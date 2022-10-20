import { Provider } from "@ethersproject/abstract-provider";
import { BigNumber } from "ethers";

export async function getGasConfiguration(provider: Provider): Promise<
  | {
      maxFeePerGas: BigNumber;
      maxPriorityFeePerGas: BigNumber;
    }
  | { gasPrice: BigNumber }
> {
  const { maxFeePerGas, maxPriorityFeePerGas } = await provider.getFeeData();
  if (!maxFeePerGas || !maxPriorityFeePerGas) {
    return { gasPrice: await provider.getGasPrice() };
  }
  return {
    maxFeePerGas: BigNumber.from(maxFeePerGas),
    maxPriorityFeePerGas: BigNumber.from(maxPriorityFeePerGas),
  };
}
