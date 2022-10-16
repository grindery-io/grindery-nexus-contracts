import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "hardhat-deploy";
import { ethers } from "ethers";
import { signerAddress, contractAddress, funding } from "./lib/deterministicDeployment";

function randomKey(salt: string) {
  return ethers.utils.keccak256(ethers.utils.arrayify(ethers.utils.toUtf8Bytes("GrinderyTestAccount" + salt)));
}

const config: HardhatUserConfig = {
  networks: {
    hardhat: {
      accounts: Array(10)
        .fill(0)
        .map((_, index) => ({ balance: ethers.utils.parseEther("10000").toString(), privateKey: randomKey(index.toString()) })),
    },
  },
  solidity: {
    version: "0.8.17",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000,
      },
    },
  },
  namedAccounts: {
    owner: {
      default: 0,
    },
    operator: {
      default: 1,
    },
  },
  deterministicDeployment: () => {
    return {
      factory: contractAddress,
      deployer: signerAddress,
      funding,
      signedTx: "0x0", // We will deploy from our own script
    };
  },
};

export default config;
