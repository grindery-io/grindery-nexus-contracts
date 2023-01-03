// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts/utils/Counters.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
contract NFTMints is Initializable, Ownable2StepUpgradeable, UUPSUpgradeable, ERC1155Upgradeable {
     using Counters for Counters.Counter;
    Counters.Counter private _tokenIds;
    address private operator;

    mapping(uint256 => string) private _tokenURIs;
    // address owner;

    // constructor(address _owner) public ERC1155Upgradeable("") {
    //     owner = _owner;
    // }

    // modifier onlyOwner () override virtual {
    //     require(msg.sender == owner, "Not owner");
    //     _;
    // }

    event OperatorChanged(
        address indexed oldOperator,
        address indexed newOperator
    );

    function _authorizeUpgrade(address) internal override onlyOwner onlyProxy {}

    function setOperator(address newOperator) public onlyOwner onlyProxy {
        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
    }

    function getOperator() public view onlyProxy returns (address) {
        return operator;
    }

    function initialize(address __ERC1155_init) public initializer {
        __Ownable2Step_init();
        OwnableUpgradeable.transferOwnership(__ERC1155_init);
    }
    function mintNFTs (address recipient, string memory _tokenUri) public returns (uint256) {
         _tokenIds.increment();
        uint256 newItemId = _tokenIds.current();
        _mint(recipient, newItemId, 1, '');
        setTokenUri(newItemId, _tokenUri, recipient);

        return newItemId;
    }

    function uri(uint256 tokenId) override public view returns (string memory){
        return _tokenURIs[tokenId];
    }


    function setTokenUri(uint256 tokenId, string memory uri, address recipient ) internal {
        require(balanceOf(recipient, tokenId) > 0, "Tokens do not exists for this user");
        _tokenURIs[tokenId] = uri;
    }
}