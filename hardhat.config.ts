import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-abi-exporter";

import { OWNER_KMS_KEY_PATH, OWNER_ADDRESS, POLYGONSCAN_API_KEY, GAS_TANK_SIGNER_TESTNET, FEE_ACCOUNTANT_OPERATOR_TESTNET, TX_SIGNER_TESTNET, TX_SIGNER_TO_DISABLE_TESTNET, ETHERSCAN_API_KEY } from "./secrets";
import { registerSigner } from "./lib/gcpSigner";
registerSigner(OWNER_ADDRESS, OWNER_KMS_KEY_PATH);

import "hardhat-deploy";
import { ethers } from "ethers";

import "./tasks/refund";

interface NetworkConfigExtra {
  gasTokenAddress?: `0x${string}`;
  gasTankSigner?: string;
  feeAccountantOperator?: string;
  priceFeeds?: { [chainId: number]: `0x${string}` };
  baseGas?: bigint;
  feeNumerator?: bigint;
  feeDenominator?: bigint;
  txSigner?: string;
  txSignersToDisable?: string[];
}

declare module "hardhat/types/config" {
  interface HardhatNetworkUserConfig extends NetworkConfigExtra {}
  interface HardhatNetworkConfig extends NetworkConfigExtra {}
  interface HttpNetworkConfig extends NetworkConfigExtra {}
}

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
      gasTokenAddress: "0x0000000000000000000000000000000000000000",
      gasTankSigner: "0x1111111111111111111111111111111111111111",
    },
    goerli: {
      url: `https://rpc.ankr.com/eth_goerli`,
      accounts: [],
    },
    sepolia: {
      url: `https://ethereum-sepolia.blockpi.network/v1/rpc/public`,
      gasTankSigner: GAS_TANK_SIGNER_TESTNET,
      accounts: [],
      txSigner: TX_SIGNER_TESTNET,
      txSignersToDisable: TX_SIGNER_TO_DISABLE_TESTNET.split(","),
      verify: {
        etherscan: {
          apiKey: ETHERSCAN_API_KEY,
        },
      },
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
      url: `https://rpc-amoy.polygon.technology`,
      gasTokenAddress: "0xC3493D5787d4fF987d56855C64aAd60F382B5959",
      gasTankSigner: GAS_TANK_SIGNER_TESTNET,
      feeAccountantOperator: FEE_ACCOUNTANT_OPERATOR_TESTNET,
      priceFeeds: {
        80002: "0x001382149eBa3441043c1c66972b4772963f5D43",
        11155111: "0xF0d50568e3A7e8259E16663972b11910F89BD8e7",
      },
      baseGas: 230000n,
      accounts: [],
      verify: {
        etherscan: {
          apiUrl: "https://api-amoy.polygonscan.com",
          apiKey: POLYGONSCAN_API_KEY,
        },
      },
      txSigner: TX_SIGNER_TESTNET,
      txSignersToDisable: TX_SIGNER_TO_DISABLE_TESTNET.split(","),
    },
    chapel: {
      url: `https://rpc.ankr.com/bsc_testnet_chapel`,
      accounts: [],
    },
    polygon: {
      live: true,
      gasTokenAddress: "0x0Fd9e8d3aF1aaee056EB9e802c3A762a667b1904",
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
    },
  },
  deterministicDeployment: () => {
    return {
      factory: "0x4e59b44847b379578588920ca78fbf26c0b4956c",
      deployer: "0x3fab184622dc19b6109349b94811493bf2a45362",
      funding: ethers.parseUnits(String(100 * 100000), "gwei").toString(),
      signedTx:
        "0xf8a58085174876e800830186a08080b853604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf31ba02222222222222222222222222222222222222222222222222222222222222222a02222222222222222222222222222222222222222222222222222222222222222",
    };
  },
  abiExporter: {
    path: "./abi",
    runOnCompile: true,
    clear: true,
    flat: true,
    format: "json",
  },
};

export default config;
