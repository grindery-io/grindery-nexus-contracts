import "dotenv/config";
import { config } from "dotenv";

if (process.env.DEV) {
  config({ path: ".env.dev", override: true });
}

const OWNER_OLD_KEY = process.env.OWNER_OLD_KEY || "";
const OPERATOR_ADDRESS = process.env.OPERATOR_ADDRESS || "";
const DETERMINISTIC_DEPLOYMENT_KEY = process.env.DETERMINISTIC_DEPLOYMENT_KEY || "";
const OWNER_KMS_KEY_PATH = process.env.OWNER_KMS_KEY_PATH || "";
const OWNER_ADDRESS = process.env.OWNER_ADDRESS || "";
const POLYGONSCAN_API_KEY = process.env.POLYGONSCAN_API_KEY || "";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || "";
const OPBNB_API_KEY = process.env.OPBNB_API_KEY || "";
const ETHERSCAN_API_KEY = process.env._ETHERSCAN_API_KEY || "";
const GAS_TANK_SIGNER_TESTNET = process.env.GAS_TANK_SIGNER_TESTNET || "";
const FEE_ACCOUNTANT_OPERATOR_TESTNET = process.env.FEE_ACCOUNTANT_OPERATOR_TESTNET || "";
const GAS_TANK_SIGNER = process.env.GAS_TANK_SIGNER || "";
const FEE_ACCOUNTANT_OPERATOR = process.env.FEE_ACCOUNTANT_OPERATOR || "";
const TX_SIGNER_TESTNET = process.env.TX_SIGNER_TESTNET || "";
const TX_SIGNER = process.env.TX_SIGNER || "";

export {
  OWNER_OLD_KEY,
  OPERATOR_ADDRESS,
  DETERMINISTIC_DEPLOYMENT_KEY,
  OWNER_KMS_KEY_PATH,
  OWNER_ADDRESS,
  POLYGONSCAN_API_KEY,
  BSCSCAN_API_KEY,
  OPBNB_API_KEY,
  ETHERSCAN_API_KEY,
  GAS_TANK_SIGNER_TESTNET,
  FEE_ACCOUNTANT_OPERATOR_TESTNET,
  GAS_TANK_SIGNER,
  FEE_ACCOUNTANT_OPERATOR,
  TX_SIGNER_TESTNET,
  TX_SIGNER,
};
