import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";

import { OWNER_KMS_KEY_PATH, OWNER_ADDRESS } from "./secrets";
import { registerSigner } from "./lib/gcpSigner";
registerSigner(OWNER_ADDRESS, OWNER_KMS_KEY_PATH);

import "hardhat-deploy";
import { ethers } from "ethers";
import { signerAddress, contractAddress } from "./lib/deterministicDeployment";

import "./tasks/refund";
import "./tasks/switchOwner";

function randomKey(salt: string) {
  return ethers.utils.keccak256(ethers.utils.arrayify(ethers.utils.toUtf8Bytes("GrinderyTestAccount" + salt)));
}
const TEST_ACCOUNTS = Array(10)
  .fill(0)
  .map((_, index) => ({
    balance: ethers.utils.parseEther("10000").toString(),
    privateKey: randomKey(index.toString()),
  }));

const config: HardhatUserConfig = {
  networks: {
    hardhat: {
      accounts: TEST_ACCOUNTS,
    },
    goerli: {
      url: `https://rpc.ankr.com/eth_goerli`,
    },
    sepolia: {
      url: `https://rpc.ankr.com/eth_sepolia`,
    },
    mumbai: {
      url: `https://rpc.ankr.com/polygon_mumbai`,
    },
    chapel: {
      url: `https://rpc.ankr.com/bsc_testnet_chapel`,
    },
    polygon: {
      live: true,
      url: `https://rpc.ankr.com/polygon`,
    },
    harmony: {
      live: true,
      url: `https://rpc.ankr.com/harmony`,
    },
    celo: {
      live: true,
      url: `https://rpc.ankr.com/celo`,
    },
    fantom: {
      live: true,
      url: `https://rpc.ankr.com/fantom`,
    },
    fantom_testnet: {
      url: `https://rpc.testnet.fantom.network/`,
    },
    gnosis: {
      live: true,
      url: `https://rpc.ankr.com/gnosis`,
    },
    avalanche: {
      live: true,
      url: `https://rpc.ankr.com/avalanche`,
    },
    bsc: {
      live: true,
      url: `https://rpc.ankr.com/bsc`,
    },
    eth: {
      live: true,
      url: `https://rpc.ankr.com/eth`,
    },
    arbitrum: {
      live: true,
      url: `https://arb1.arbitrum.io/rpc`,
    },
    cronos: {
      live: true,
      url: `https://evm.cronos.org`,
    },
    cronos_testnet: {
      url: `https://evm-t3.cronos.org`,
    },
    polygon_zkevm_testnet: {
      url: `https://rpc.ankr.com/polygon_zkevm_testnet`,
    },
    celo_alfajores: {
      url: `https://alfajores-forno.celo-testnet.org`,
    },
    evmos_testnet: {
      url: `https://eth.bd.evmos.dev:8545`,
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
      default: OWNER_ADDRESS,
      31337: 0,
    },
  },
  deterministicDeployment: () => {
    return {
      factory: contractAddress,
      deployer: signerAddress,
      funding: "0",
      signedTx: "0x0", // We will deploy from our own script
    };
  },
};

export default config;
