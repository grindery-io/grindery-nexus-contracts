// SPDX-License-Identifier: MIT

pragma solidity 0.8.25;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC721URIStorage, ERC721} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

contract GrinderyGenesisNFT is ERC721URIStorage, Ownable {
    uint256 private _nextTokenId;

    constructor(address _owner) ERC721("Grindery Genesis", "GG") Ownable(_owner) {}

    function mint(
        address to,
        string memory tokenURI
    ) public onlyOwner returns (uint256) {
        uint256 tokenId = _nextTokenId++;
        _mint(to, tokenId);
        _setTokenURI(tokenId, tokenURI);

        return tokenId;
    }
}
