const EXPECTED_ADDRESSES = {
  DETERMINISTIC_DEPLOYMENT_PROXY: "0x327E469C621d8A67e803b294fe363cd7fAcD9638",
  HUB: "0xC942DFb6cC8Aade0F54e57fe1eD4320411625F8B",
  DRONE: "0xbF10077a690CE1Aad62836F01B9d6B2803cCb793",
  DRONE_BEACON: "0x6c0C5B7B7cc6bB8BD7D94844acF1214cE20aAF5E",
};

export function verifyContractAddress(chainId: number | string, type: keyof typeof EXPECTED_ADDRESSES, address: string) {
  if (chainId.toString() === "31337") {
    // Hardhat chain
    return;
  }
  if (address !== EXPECTED_ADDRESSES[type]) {
    throw new Error(`[${type}] Unexpected address: ${address}`);
  }
}
