// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "./GrtOffer.sol";

contract GrtPoolV2 is OwnableUpgradeable, GrtOffer, UUPSUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    struct Trade {
        bool isComplete;
        address buyerAddress;
        address destAddress;
        TokenInfo deposit;
        bytes32 offerId;
        uint256 amountOffer;
    }

    struct TokenInfo {
        address token;
        uint256 amount;
        uint256 chainId;
    }

    mapping(bytes32 => Trade) private _trades;
    mapping(address => uint256) private _noncesTrade;
    address private _tokenMRI;

    event LogNewTrade(
        address indexed _seller,
        bytes32 indexed _tradeId,
        address indexed _token,
        uint256 _amount,
        bytes32 _offerId
    );

    function initialize(address tokenMRI) external initializer {
        __Ownable_init();
        _tokenMRI = tokenMRI;
    }

    function _authorizeUpgrade(address) internal override onlyOwner onlyProxy {}

    receive() external payable {}

    function withdrawNative(uint256 amount, address to) external onlyOwner {
        require(amount <= address(this).balance, "Grindery Pool: insufficient balance.");
        (bool success, ) = to.call{ value: amount }("");
        require(success, "Grindery Pool: withdrawNative failed.");
    }

    function withdrawERC20Tokens(address token, uint256 amount, address to) external onlyOwner {
        IERC20Upgradeable(token).safeTransfer(to, amount);
    }

    function depositNativeAndAcceptOffer(
        bytes32 offerId,
        address destAddress,
        uint256 amountOffer
    ) external payable returns (bytes32) {
        require(msg.value > 0, "Grindery Pool: transfered amount must be positive.");
        require(destAddress != address(0), "Grindery Pool: zero address as destination address is not allowed.");
        require(_offers[offerId].isActive, "Grindery Pool: the offer is inactive.");

        bytes32 tradeId = setInfoTrade(destAddress, address(0), msg.value, offerId, amountOffer);

        (bool sent, ) = address(this).call{ value: msg.value }("");
        require(sent, "Grindery Pool: failed to send native tokens.");

        return tradeId;
    }

    function depositMRITokenAndAcceptOffer(
        address token,
        uint256 amount,
        bytes32 offerId,
        address destAddress,
        uint256 amountOffer
    ) external returns (bytes32) {
        require(token != address(0), "Grindery Pool: the token must not be zero address.");
        require(token == _tokenMRI, "Grindery Pool: the token sent must be the test token.");
        require(amount > 0, "Grindery Pool: transfered amount must be positive.");
        require(destAddress != address(0), "Grindery Pool: zero address as destination address is not allowed.");
        require(_offers[offerId].isActive, "Grindery Pool: the offer is inactive.");

        bytes32 tradeId = setInfoTrade(destAddress, _tokenMRI, amount, offerId, amountOffer);

        IERC20Upgradeable(_tokenMRI).safeTransferFrom(msg.sender, address(this), amount);

        return tradeId;
    }

    function setInfoTrade(
        address destAddress,
        address token,
        uint256 amount,
        bytes32 offerId,
        uint256 amountOffer
    ) internal returns (bytes32) {
        bytes32 tradeId = keccak256(abi.encodePacked(msg.sender, _noncesTrade[msg.sender], block.chainid));
        Trade storage trade = _trades[tradeId];
        trade.buyerAddress = msg.sender;
        trade.destAddress = destAddress;
        trade.deposit = setTokenInfo(token, amount, block.chainid);
        trade.offerId = offerId;
        trade.amountOffer = amountOffer;
        _noncesTrade[msg.sender]++;
        emit LogNewTrade(getSellerOffer(offerId), tradeId, token, amount, offerId);
        return tradeId;
    }

    function setMRIToken(address tokenMRI) external onlyOwner {
        _tokenMRI = tokenMRI;
    }

    function setCompleteTrade(bytes32 tradeId) external returns (bool) {
        require(!_trades[tradeId].isComplete, "Grindery Pool: the order is already complete.");
        require(msg.sender == _trades[tradeId].buyerAddress, "Grindery Pool: you are not the user who made the order.");

        _trades[tradeId].isComplete = true;
        return true;
    }

    function getPaymentInfoTrade(
        bytes32 tradeId
    ) external view returns (bytes32 offerId, address destAddress, address token, uint256 amount) {
        return (
            _trades[tradeId].offerId,
            _trades[tradeId].destAddress,
            _offers[_trades[tradeId].offerId].token,
            _trades[tradeId].amountOffer
        );
    }

    function getMRIToken() external view returns (address) {
        return _tokenMRI;
    }

    function getNonceUserTrade(address user) external view returns (uint256) {
        return _noncesTrade[user];
    }

    function isCompleteTrade(bytes32 tradeId) external view returns (bool) {
        return _trades[tradeId].isComplete;
    }

    function getAmountOfferForTrade(bytes32 tradeId) external view returns (uint256) {
        return _trades[tradeId].amountOffer;
    }

    function getOfferIdForTrade(bytes32 tradeId) external view returns (bytes32) {
        return _trades[tradeId].offerId;
    }

    function getBuyerTrade(bytes32 tradeId) external view returns (address) {
        return _trades[tradeId].buyerAddress;
    }

    function getDestinationAddressTrade(bytes32 tradeId) external view returns (address) {
        return _trades[tradeId].destAddress;
    }

    function getDepositTokenTrade(bytes32 tradeId) external view returns (address) {
        return _trades[tradeId].deposit.token;
    }

    function getDepositAmountTrade(bytes32 tradeId) external view returns (uint256) {
        return _trades[tradeId].deposit.amount;
    }

    function getDepositChainIdTrade(bytes32 tradeId) external view returns (uint256) {
        return _trades[tradeId].deposit.chainId;
    }

    function setTokenInfo(address token, uint256 amount, uint256 chainId) internal pure returns (TokenInfo memory) {
        return TokenInfo(token, amount, chainId);
    }
}
