
import { expect } from "chai";
import { ethers } from "hardhat";

let contract: NFTMints;
let user1, user2;
describe("Multi Token Contract", function () {
    beforeEach(async () => {
        [user1, user2] = await ethers.getSigners();
        const deployedNFT = await ethers.getContractFactory("NFTMints");
        contract = await deployedNFT.deploy(user2.address);
        await contract.deployed();
    })

    it("Should mint an nft with tokenId of '1' for user 1, and when quering it's token Uri, it should return the tokenUri, and show the balance of that nft as 1 for said user",async () => {
        const mintedNft = await contract.mintNFTs(user1.address, 'token uri');
      const req = await mintedNft.wait()
      const metadata = await contract.uri(1);
      console.log('metadata', metadata)
      expect (metadata).to.equal('token uri');
      expect (await contract.balanceOf(user1.address, 1)).to.equal(1)
    })
})