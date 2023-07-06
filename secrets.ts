import "dotenv/config";
import { config } from "dotenv";

if (process.env.DEV) {
  config({ path: ".env.dev", override: true });
}

const DETERMINISTIC_DEPLOYMENT_KEY = process.env.DETERMINISTIC_DEPLOYMENT_KEY || "";
const OWNER_KMS_KEY_PATH = process.env.OWNER_KMS_KEY_PATH || "";
const OWNER_ADDRESS = process.env.OWNER_ADDRESS || "";

export { DETERMINISTIC_DEPLOYMENT_KEY, OWNER_KMS_KEY_PATH, OWNER_ADDRESS };
