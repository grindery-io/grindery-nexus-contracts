// contracts/GameItems.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/utils/Counters.sol";
contract NFTMints is ERC1155 {
     using Counters for Counters.Counter;
    Counters.Counter private _tokenIds;

    mapping(uint256 => string) private _tokenURIs;
    address owner;

    constructor(address _owner) public ERC1155("") {
        owner = _owner;
    }

    modifier onlyOwner () {
        require(msg.sender == owner, "Not owner");
        _;
    }
    function mintNFTs (address recipient, string memory _tokenUri) public {
         _tokenIds.increment();
        uint256 newItemId = _tokenIds.current();
        _mint(recipient, newItemId, 1, '');
        setTokenUri(newItemId, _tokenUri, recipient);
    }

    function uri(uint256 tokenId) override public view returns (string memory){
        return _tokenURIs[tokenId];
    }


    function setTokenUri(uint256 tokenId, string memory uri, address recipient ) internal {
        require(balanceOf(recipient, tokenId) > 0, "Tokens do not exists for this user");
        _tokenURIs[tokenId] = uri;
    }
}