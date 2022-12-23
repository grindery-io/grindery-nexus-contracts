// contracts/GameItems.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/utils/Counters.sol";
contract NFTMints is ERC1155 {
     using Counters for Counters.Counter;
    Counters.Counter private _tokenIds;

    mapping(uint256 => string) private _tokenURIs;
    event multiTokensMinted (
        address indexed recipient,
        uint256 indexed tokenId,
        uint256 indexed amount,
        string tokenUri
        );
    

    constructor() public ERC1155("") {}

    function mintNFTs (uint _amount, bytes memory data, string memory _tokenUri) public {
         _tokenIds.increment();
        uint256 newItemId = _tokenIds.current();
        _mint(msg.sender, newItemId, _amount, data);
        setTokenUri(newItemId, _tokenUri);
        emit multiTokensMinted(msg.sender, newItemId, _amount, _tokenUri);
    }

    function uri(uint256 tokenId) override public view returns (string memory){
        return _tokenURIs[tokenId];
    }


    function setTokenUri(uint256 tokenId, string memory uri ) internal {
        require(balanceOf(msg.sender, tokenId) > 0, "Tokens do not exists for this user");
        _tokenURIs[tokenId] = uri;
    }
}