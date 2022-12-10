//Contract based on [https://docs.openzeppelin.com/contracts/3.x/erc721](https://docs.openzeppelin.com/contracts/3.x/erc721)
// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/Counters.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./ERC721MetadataStorage.sol";

contract EVMNFTMint  is Ownable, ERC721MetadataStorage{
    using Counters for Counters.Counter;
    Counters.Counter private _tokenIds;

    constructor() ERC721("EVMNFTMint", "NFT") {}
    event NFTMinted (
        address indexed recipient,
        uint256 indexed tokenId,
        string indexed name,
        string description,
        string tokenUri
        );

    function mintNFT(string memory _name, string memory _description,address recipient, string memory tokenURI)
        public
        // returns (uint256, string memory, string memory, string memory)
        returns (uint)
    {
        _tokenIds.increment();
        uint256 newItemId = _tokenIds.current();
        _mint(recipient, newItemId);
        _setTokenMetadata(newItemId, tokenURI, _name, _description);

        // return (newItemId, _name, _description, tokenURI);
        emit NFTMinted (recipient, newItemId, _name, _description, tokenURI);
        return newItemId;
    }

}