# grindery-nexus-contracts

Smart contracts for supporting EVM operations of Grindery Nexus

Try running some of the following tasks:

```shell
npx hardhat help
npx hardhat test
REPORT_GAS=true npx hardhat test
npx hardhat node
npx hardhat deploy
```

# Notes

Please do not upgrade `@openzeppelin/contracts` and `@openzeppelin/contracts-upgradeable` to any other version, and do not change solidity settings in `hardhat.config.ts`. We need these to stay exactly the same to get stable contract address.