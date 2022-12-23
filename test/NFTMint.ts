import { expect } from "chai";
import { ethers } from "hardhat";

describe('Minting the token and returning it', () => { 
    it("should the contract be able to mint a function and return it", async function () {
        //Random metadata url
        const url = "https://bafybeigqpgevjzw34neqc2oy2xvsokiwiirqdzqobputaww4oeft23t6ve.ipfs.nftstorage.link/";
        // Recipient address
        const account = "0x01Cd7A354C6FD07C061648A78E1ADa9ad7dfbDc0";
        // Getting the contract
        const NFTContract = await ethers.getContractFactory("NFTMint");
        //Deploying the Contract
        const nftContract = await NFTContract.deploy();

        // Minting the token
        const createTx = await nftContract.mintNFT(account, url);
        // Waiting for the token to be minted
        const tx = await createTx.wait();

        const event = tx.events[0];
        const value = event.args[2];
        // Getting the tokenID
        const tokenId = value.toNumber();
        // Using the tokenURI from ERC721 to retrieve metadata
        const tokenURI = await nftContract.tokenURI(tokenId);
        // Comparing and testing
        expect(tokenURI).to.be.equal(url);
    })
 })