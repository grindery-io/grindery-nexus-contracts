import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "hardhat-deploy";
import { ethers } from "ethers";
import { signerAddress, contractAddress } from "./lib/deterministicDeployment";
import { OPERATOR_ADDRESS, OWNER_KEY, BSCSCAN_KEY } from "./secrets";
import "@nomiclabs/hardhat-etherscan";
import "./tasks/refund";
import "./tasks/mintERC20";

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
      // allowUnlimitedContractSize: true
    },
    goerli: {
      // url: `https://rpc.ankr.com/eth_goerli`,
      url: `https://eth-goerli.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
      accounts: [OWNER_KEY],
    },
    mumbai: {
      url: `https://rpc.ankr.com/polygon_mumbai`,
      accounts: [OWNER_KEY],
    },
    chapel: {
      url: `https://rpc.ankr.com/bsc_testnet_chapel`,
      accounts: [OWNER_KEY],
    },
    polygon: {
      live: true,
      url: `https://rpc.ankr.com/polygon`,
      accounts: [OWNER_KEY],
    },
    harmony: {
      live: true,
      url: `https://rpc.ankr.com/harmony`,
      accounts: [OWNER_KEY],
    },
    celo: {
      live: true,
      url: `https://rpc.ankr.com/celo`,
      accounts: [OWNER_KEY],
    },
    fantom: {
      live: true,
      url: `https://rpc.ankr.com/fantom`,
      accounts: [OWNER_KEY],
    },
    gnosis: {
      live: true,
      url: `https://rpc.ankr.com/gnosis`,
      accounts: [OWNER_KEY],
    },
    avalanche: {
      live: true,
      url: `https://rpc.ankr.com/avalanche`,
      accounts: [OWNER_KEY],
    },
    bsc: {
      url: `https://rpc.ankr.com/bsc`,
      accounts: [OWNER_KEY],
    },
    bscTestnet: {
      url: `https://rpc.ankr.com/bsc_testnet_chapel`,
      accounts: [OWNER_KEY],
    },
    eth: {
      url: `https://rpc.ankr.com/eth`,
      accounts: [OWNER_KEY],
    },
    arbitrum: {
      url: `https://arb1.arbitrum.io/rpc`,
      accounts: [OWNER_KEY],
    },
    cronos: {
      url: `https://evm.cronos.org`,
      accounts: [OWNER_KEY],
    },
    cronostestnet: {
      url: `https://evm-t3.cronos.org/`,
      accounts: [OWNER_KEY],
    },
  },
  etherscan: {
    apiKey: {
      bscTestnet: BSCSCAN_KEY!
    }
  },
  solidity: {
    // Do not change any compiler setting
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
      // default: "0xbD4CAF9E8aBC11bFeBba6f12c408144621f76949",
      // default: "0xB201fDd90b14cc930bEc2c4E9f432bC1CA5Ad7C5",
      default: "0x710f35C7c7CEC6B4f80D63ED506c356160eB58d1",
      31337: 0,
    },
    operator: {
      default: OPERATOR_ADDRESS || 1,
      31337: 1,
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
