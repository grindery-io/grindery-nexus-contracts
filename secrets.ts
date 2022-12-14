import "dotenv/config";

const OWNER_KEY = process.env.OWNER_KEY || "";
const OPERATOR_ADDRESS = process.env.OPERATOR_ADDRESS || "";
const DETERMINISTIC_DEPLOYMENT_KEY = process.env.DETERMINISTIC_DEPLOYMENT_KEY || "";

export { OWNER_KEY, OPERATOR_ADDRESS, DETERMINISTIC_DEPLOYMENT_KEY };