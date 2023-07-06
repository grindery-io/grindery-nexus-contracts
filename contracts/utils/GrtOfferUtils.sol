// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

contract GrtOfferUtils {
    struct Offer {
        address seller;
        bool isActive;
        uint256 chainId;
        address token;
        bytes32 maxPriceLimit;
        bytes32 minPriceLimit;
    }

    mapping(bytes32 => Offer) internal _offers;
    mapping(address => uint256) internal _noncesOffer;

    function getSellerOffer(bytes32 offerId) public view returns (address) {
        return _offers[offerId].seller;
    }

    function getStatusOffer(bytes32 offerId) external view returns (bool) {
        return _offers[offerId].isActive;
    }

    function getMinPriceLimitHashOffer(bytes32 offerId) external view returns (bytes32) {
        return _offers[offerId].minPriceLimit;
    }

    function getMaxPriceLimitHashOffer(bytes32 offerId) external view returns (bytes32) {
        return _offers[offerId].maxPriceLimit;
    }

    function getTokenOffer(bytes32 offerId) external view returns (address) {
        return _offers[offerId].token;
    }

    function getChainIdOffer(bytes32 offerId) external view returns (uint256) {
        return _offers[offerId].chainId;
    }

    function getNonceOffer(address user) external view returns (uint256) {
        return _noncesOffer[user];
    }
}
