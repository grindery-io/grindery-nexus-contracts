//Contract based on [https://docs.openzeppelin.com/contracts/3.x/erc721](https://docs.openzeppelin.com/contracts/3.x/erc721)
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/Counters.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

contract NFTMints is ERC721URIStorage, Ownable {
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
    function mintNfts (address _addr, string memory _tokenUri) public {
         _tokenIds.increment();
        uint256 newItemId = _tokenIds.current();
        _mint(_addr, newItemId, 1, '');
        setTokenUri(newItemId, _tokenUri, _addr);
    }

    function uri(uint256 tokenId) override public view returns (string memory){
        return _tokenURIs[tokenId];
    }


    function setTokenUri(uint256 tokenId, string memory uri, address _addr ) internal {
        require(balanceOf(_addr, tokenId) > 0, "Tokens do not exists for this user");
        _tokenURIs[tokenId] = uri;
    }
}
}
