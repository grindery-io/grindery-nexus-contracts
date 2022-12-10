// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v4.7.0) (token/ERC721/extensions/ERC721URIStorage.sol)

pragma solidity ^0.8.0;
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import '@openzeppelin/contracts/token/ERC721/extensions/ERC721Burnable.sol';

/**
 * @dev ERC721 token with storage based token URI management.
 */

 abstract contract ERC721MetadataStorage is ERC721Burnable {
    using Strings for uint256;

     struct Metadata {
        string name;
        string description;
        string tokenUri;
    }
    // Optional mapping for token URIs
    mapping(uint256 => Metadata) private _metaDatas;

    /**
     * @dev See {IERC721Metadata-tokenURI}.
     */
    function metaData(uint256 tokenId) public view virtual returns (Metadata memory) {
        _requireMinted(tokenId);

        Metadata memory data = _metaDatas[tokenId];
            return data;
    }

    /**
     * @dev Sets `_tokenURI` as the tokenURI of `tokenId`.
     *
     * Requirements:
     *
     * - `tokenId` must exist.
     */
    function _setTokenMetadata(uint256 tokenId, string memory _tokenURI, string memory _name, string memory _description) internal virtual {
        require(_exists(tokenId), "ERC721URIStorage: URI set of nonexistent token");
        _metaDatas[tokenId] = Metadata({ name: _name, description: _description, tokenUri: _tokenURI });
    }

    /**
     * @dev See {ERC721-_burn}. This override additionally checks to see if a
     * token-specific URI was set for the token, and if so, it deletes the token URI from
     * the storage mapping.
     */
    function _burn(uint256 tokenId) internal override {
        super._burn(tokenId);

        if (bytes(_metaDatas[tokenId].tokenUri).length != 0) {
            delete _metaDatas[tokenId];
        }
    }
}