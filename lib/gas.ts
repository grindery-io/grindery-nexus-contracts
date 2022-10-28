import { Provider } from "@ethersproject/abstract-provider";
import { BigNumber, ethers } from "ethers";

export async function getGasConfiguration(provider: Provider): Promise<
  | {
      maxFeePerGas: BigNumber;
      maxPriorityFeePerGas: BigNumber;
    }
  | { gasPrice: BigNumber }
> {
  if ((await provider.getNetwork()).chainId === 42161) {
    return {
      maxFeePerGas: BigNumber.from(ethers.utils.parseUnits("0.11", "gwei")),
      maxPriorityFeePerGas: BigNumber.from(0),
    };
  }
  let { maxFeePerGas, maxPriorityFeePerGas } = await provider.getFeeData();
  if (!maxFeePerGas || !maxPriorityFeePerGas) {
    return { gasPrice: await provider.getGasPrice().then((x) => x.mul(13).div(10)) };
  }
  return {
    maxFeePerGas: BigNumber.from(maxFeePerGas),
    maxPriorityFeePerGas: BigNumber.from(maxPriorityFeePerGas),
  };
}
