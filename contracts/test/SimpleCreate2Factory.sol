// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

/**
 * @title SimpleCreate2Factory
 * @dev A simple CREATE2 factory for testing ERC-6492 counterfactual signatures
 */
contract SimpleCreate2Factory {
    /**
     * @dev Deploys a contract using CREATE2
     * @param salt The salt for deterministic deployment
     * @param bytecode The bytecode of the contract to deploy
     * @return deployed The address of the deployed contract
     */
    function deploy(
        bytes32 salt,
        bytes memory bytecode
    ) external returns (address deployed) {
        assembly {
            deployed := create2(0, add(bytecode, 0x20), mload(bytecode), salt)
        }
        require(deployed != address(0), "SimpleCreate2Factory: deployment failed");
    }

    /**
     * @dev Computes the address of a contract deployed via CREATE2
     * @param salt The salt for deterministic deployment
     * @param bytecodeHash The keccak256 hash of the contract bytecode
     * @return predicted The predicted address
     */
    function getDeployedAddress(
        bytes32 salt,
        bytes32 bytecodeHash
    ) external view returns (address predicted) {
        predicted = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            address(this),
                            salt,
                            bytecodeHash
                        )
                    )
                )
            )
        );
    }

    /**
     * @dev Receive function to accept ETH
     */
    receive() external payable {}
}
