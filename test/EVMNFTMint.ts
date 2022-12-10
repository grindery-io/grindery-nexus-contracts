import { expect } from "chai";
import { ethers } from "hardhat";
import { EVMNFTMint } from "../typechain-types";

let evmNFTMint: EVMNFTMint;
let user1, user2;
let tokenURI =
  "https://bafybeigqpgevjzw34neqc2oy2xvsokiwiirqdzqobputaww4oeft23t6ve.ipfs.nftstorage.link/";
describe("EVM NFT Contract", () => {
  beforeEach(async () => {
    [user1, user2] = await ethers.getSigners();
    const deployedEVMContract = await ethers.getContractFactory("EVMNFTMint");
    evmNFTMint = await deployedEVMContract.deploy();
    await evmNFTMint.deployed();
  });

  it("Should mint nft from user1 and when quering it's metadata, it should return the name, description and tokenUri", async () => {
    const mintNFT = await evmNFTMint.mintNFT(
      "My NFT",
      "This is a Test NFT",
      user1.address,
      tokenURI
    );

    const req = await mintNFT.wait();
    const tokenId = req.events[0].args.tokenId.toString();
    const metadata = await evmNFTMint.metaData(tokenId);
    expect(metadata.name).to.equal("My NFT");
    expect(metadata.description).to.equal("This is a Test NFT");
    expect(metadata.tokenUri).to.equal(tokenURI);
  });

  it("Should burn an NFT and burn its metadata as well", async () => {
    const mintNFT = await evmNFTMint.mintNFT(
      "My NFT",
      "This is a Test NFT",
      user1.address,
      tokenURI
    );
    await mintNFT.wait();
    await evmNFTMint.burn(1);
    await expect(evmNFTMint.metaData(1)).to.be.revertedWith(
      "ERC721: invalid token ID"
    );
  });
});
