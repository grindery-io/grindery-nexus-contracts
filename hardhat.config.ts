import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-abi-exporter";

import {
  OWNER_KMS_KEY_PATH,
  OWNER_ADDRESS,
  POLYGONSCAN_API_KEY,
  GAS_TANK_SIGNER_TESTNET,
  FEE_ACCOUNTANT_OPERATOR_TESTNET,
  TX_SIGNER_TESTNET,
  ETHERSCAN_API_KEY,
  GAS_TANK_SIGNER,
  FEE_ACCOUNTANT_OPERATOR,
  BSCSCAN_API_KEY,
  OPBNB_API_KEY,
  TX_SIGNER,
} from "./secrets";
import { registerSigner } from "./lib/gcpSigner";
registerSigner(OWNER_ADDRESS, OWNER_KMS_KEY_PATH);

import "hardhat-deploy";
import { ethers } from "ethers";

import "./tasks/refund";
import "./tasks/paymasterDeposit";
import "./tasks/gasReport";

interface NetworkConfigExtra {
  gasTokenAddress?: `0x${string}`;
  gasTankSigner?: string;
  feeAccountantOperator?: string;
  priceFeeds?: { [chainId: number]: `0x${string}` };
  baseGas?: bigint;
  feeNumerator?: bigint;
  feeDenominator?: bigint;
  txSigner?: string;
  gasPrice?: bigint;
  stage2Fee?: {
    fixedFee: bigint;
    feeNumerator: bigint;
    feeDenominator: bigint;
  };
  gxTokenAddress?: string;
  gxTonBridgeOperator?: string;
  aiGasTankOperator?: string;
  aiGasTankToken?: string;
  genesisOwner?: string;
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
      gxTokenAddress: "0xC3493D5787d4fF987d56855C64aAd60F382B5959",
      aiGasTankToken: "0xC3493D5787d4fF987d56855C64aAd60F382B5959",
    },
    goerli: {
      url: `https://rpc.ankr.com/eth_goerli`,
      accounts: [],
    },
    sepolia: {
      url: `https://sepolia.gateway.tenderly.co`,
      gasTankSigner: GAS_TANK_SIGNER_TESTNET,
      txSigner: TX_SIGNER_TESTNET,
      accounts: [],
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
      url: `https://polygon-amoy-bor-rpc.publicnode.com`,
      gasTokenAddress: "0xC3493D5787d4fF987d56855C64aAd60F382B5959",
      gasTankSigner: GAS_TANK_SIGNER_TESTNET,
      feeAccountantOperator: FEE_ACCOUNTANT_OPERATOR_TESTNET,
      txSigner: TX_SIGNER_TESTNET,
      priceFeeds: {
        0: "0x1b8739bB4CdF0089d07097A9Ae5Bd274b29C6F16", // Use USDC as anchor
        80002: "0x001382149eBa3441043c1c66972b4772963f5D43",
        11155111: "0xF0d50568e3A7e8259E16663972b11910F89BD8e7",
        9007199254740990: "0x1b8739bB4CdF0089d07097A9Ae5Bd274b29C6F16", // TON, no Chainlink feed so using USDC feed
      },
      stage2Fee: {
        fixedFee: ethers.parseEther("0.015"),
        feeNumerator: 1000n,
        feeDenominator: 49n,
      },
      baseGas: 230000n,
      accounts: [],
      verify: {
        etherscan: {
          apiUrl: "https://api-amoy.polygonscan.com",
          apiKey: POLYGONSCAN_API_KEY,
        },
      },
    },
    chapel: {
      url: `https://bsc-testnet.public.blastapi.io`,
      gasTankSigner: GAS_TANK_SIGNER_TESTNET,
      txSigner: TX_SIGNER_TESTNET,
      accounts: [],
    },
    base: {
      live: true,
      url: `https://base-rpc.publicnode.com`,
      gasTankSigner: GAS_TANK_SIGNER,
      txSigner: TX_SIGNER,
      genesisOwner: "0xb64A61AF640514B0dC656AB1710a5D5e733D0d29",
      accounts: [],
    },
    polygon: {
      live: true,
      gasTokenAddress: "0xC3493D5787d4fF987d56855C64aAd60F382B5959",
      gasTankSigner: GAS_TANK_SIGNER,
      feeAccountantOperator: FEE_ACCOUNTANT_OPERATOR,
      txSigner: TX_SIGNER,
      priceFeeds: {
        0: "0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7", // Use USDC as anchor
        1: "0xF9680D99D6C9589e2a93a78A04A279e509205945",
        137: "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0",
        56: "0x82a6c4AF830caa6c97bb504425f6A66165C2c26e",
        204: "0x82a6c4AF830caa6c97bb504425f6A66165C2c26e",
        9007199254740990: "0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7", // TON, no Chainlink feed so using USDC feed
      },
      stage2Fee: {
        fixedFee: ethers.parseEther("0.015"),
        feeNumerator: 1000000n,
        feeDenominator: 5239n,
      },
      baseGas: 230000n,

      gxTokenAddress: "0x8730762Cad4a27816A467fAc54e3dd1E2e9617A1",
      gxTonBridgeOperator: "0x318f6E453fBd005cBa2c40dBfF8d0B4661c4c47d",
      aiGasTankOperator: "0x280a6A1D7fB1113AaB9C5Af5E6586a32D3A5F2C8",
      aiGasTankToken: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // USDC
      genesisOwner: "0xb64A61AF640514B0dC656AB1710a5D5e733D0d29",
      url: `https://polygon-rpc.com`,
      accounts: [],
      verify: {
        etherscan: {
          apiKey: ETHERSCAN_API_KEY,
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
      url: `https://bsc.blockrazor.xyz`,
      gasTankSigner: GAS_TANK_SIGNER,
      txSigner: TX_SIGNER,
      accounts: [],
      verify: {
        etherscan: {
          apiUrl: "https://api.bscscan.com",
          apiKey: BSCSCAN_API_KEY,
        },
      },
    },
    opbnb: {
      live: true,
      url: `https://opbnb-rpc.publicnode.com`,
      gasTankSigner: GAS_TANK_SIGNER,
      txSigner: TX_SIGNER,
      accounts: [],
      verify: {
        etherscan: {
          apiUrl: "https://api-opbnb.bscscan.com",
          apiKey: OPBNB_API_KEY,
        },
      },
    },
    eth: {
      live: true,
      url: `https://ethereum.blockpi.network/v1/rpc/public`,
      gasTankSigner: GAS_TANK_SIGNER,
      txSigner: TX_SIGNER,
      accounts: [],
      verify: {
        etherscan: {
          apiKey: ETHERSCAN_API_KEY,
        },
      },
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
    compilers: [
      {
        version: "0.8.25",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1000000,
          },
        },
      },
      {
        version: "0.8.30",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1000000,
          },
          viaIR: true,
        },
      },
    ],
    overrides: {
      "contracts/ZeroLC.sol": {
        version: "0.8.30",
        settings: {
          optimizer: {
            enabled: true,
            runs: 20000,
          },
          viaIR: true,
        },
      },
      "contracts/test/SettlementCaller.sol": {
        version: "0.8.30",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
          },
        },
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
    except: ["Ownable.sol", "ECDSA.sol", "EIP712.sol", "IEntryPoint.sol"],
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS ? true : false,
  },
};

export default config;
