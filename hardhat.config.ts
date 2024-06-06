import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

import { OWNER_KMS_KEY_PATH, OWNER_ADDRESS, POLYGONSCAN_API_KEY } from "./secrets";
import { registerSigner } from "./lib/gcpSigner";
registerSigner(OWNER_ADDRESS, OWNER_KMS_KEY_PATH);

import "hardhat-deploy";
import { ethers } from "ethers";
import { signerAddress, contractAddress } from "./lib/deterministicDeployment";

import "./tasks/refund";

function randomKey(salt: string) {
  return ethers.keccak256(ethers.getBytes(ethers.toUtf8Bytes("GrinderyTestAccount" + salt)));
}
const TEST_ACCOUNTS = Array(10)
  .fill(0)
  .map((_, index) => ({
    balance: ethers.parseEther("10000").toString(),
    privateKey: randomKey(index.toString()),
  }));

const config: HardhatUserConfig = {
  networks: {
    hardhat: {
      accounts: TEST_ACCOUNTS,
    },
    goerli: {
      url: `https://rpc.ankr.com/eth_goerli`,
      accounts: [],
    },
    sepolia: {
      url: `https://rpc.ankr.com/eth_sepolia`,
      accounts: [],
    },
    mumbai: {
      url: `https://rpc.ankr.com/polygon_mumbai`,
      accounts: [],
      verify: {
        etherscan: {
          apiKey: POLYGONSCAN_API_KEY,
        },
      },
    },
    amoy: {
      url: `https://rpc.ankr.com/polygon_amoy`,
      accounts: [],
      verify: {
        etherscan: {
          apiKey: POLYGONSCAN_API_KEY,
        },
      },
    },
    chapel: {
      url: `https://rpc.ankr.com/bsc_testnet_chapel`,
      accounts: [],
    },
    polygon: {
      live: true,
      url: `https://rpc.ankr.com/polygon`,
      accounts: [],
      verify: {
        etherscan: {
          apiKey: POLYGONSCAN_API_KEY,
        },
      },
    },
    harmony: {
      live: true,
      url: `https://rpc.ankr.com/harmony`,
      accounts: [],
    },
    celo: {
      live: true,
      url: `https://rpc.ankr.com/celo`,
      accounts: [],
    },
    fantom: {
      live: true,
      url: `https://rpc.ankr.com/fantom`,
      accounts: [],
    },
    fantom_testnet: {
      url: `https://rpc.testnet.fantom.network/`,
      accounts: [],
    },
    gnosis: {
      live: true,
      url: `https://rpc.ankr.com/gnosis`,
      accounts: [],
    },
    avalanche: {
      live: true,
      url: `https://rpc.ankr.com/avalanche`,
      accounts: [],
    },
    bsc: {
      live: true,
      url: `https://rpc.ankr.com/bsc`,
      accounts: [],
    },
    eth: {
      live: true,
      url: `https://rpc.ankr.com/eth`,
      accounts: [],
    },
    arbitrum: {
      live: true,
      url: `https://arb1.arbitrum.io/rpc`,
      accounts: [],
    },
    cronos: {
      live: true,
      url: `https://evm.cronos.org`,
      accounts: [],
    },
    cronos_testnet: {
      url: `https://evm-t3.cronos.org`,
      accounts: [],
    },
    polygon_zkevm_testnet: {
      url: `https://rpc.ankr.com/polygon_zkevm_testnet`,
      accounts: [],
    },
    celo_alfajores: {
      url: `https://alfajores-forno.celo-testnet.org`,
      accounts: [],
    },
    evmos_testnet: {
      url: `https://eth.bd.evmos.dev:8545`,
      accounts: [],
    },
  },
  solidity: {
    version: "0.8.25",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1000000,
      },
    },
  },
  namedAccounts: {
    owner: {
      default: OWNER_ADDRESS,
      31337: 0,
    }
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
