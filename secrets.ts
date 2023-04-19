import "dotenv/config";
import { config } from "dotenv";

if (process.env.DEV) {
  config({ path: ".env.dev", override: true });
}

const OWNER_KEY = process.env.OWNER_KEY || "";
const OPERATOR_ADDRESS = process.env.OPERATOR_ADDRESS || "";
const DETERMINISTIC_DEPLOYMENT_KEY = process.env.DETERMINISTIC_DEPLOYMENT_KEY || "";
const OWNER_KMS_KEY_PATH = process.env.OWNER_KMS_KEY_PATH || "";

export { OWNER_KEY, OPERATOR_ADDRESS, DETERMINISTIC_DEPLOYMENT_KEY, OWNER_KMS_KEY_PATH };
