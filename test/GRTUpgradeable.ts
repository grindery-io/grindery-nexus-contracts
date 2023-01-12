import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, deployments, upgrades } from "hardhat";

describe("GRT Token contract", function () {

    async function deployFixture() {
		await deployments.fixture();
        /* Getting the signers from the hardhat network. */
		const [owner, user1, user2, user3] = await ethers.getSigners();
        /* Creating a new contract instance of GRTUpgradeable and deploying it. */
		const GRTUpgradeable = await ethers.getContractFactory("GRTUpgradeable");
		const grtUpgradeable = await upgrades.deployProxy(GRTUpgradeable);
    	await grtUpgradeable.deployed();
        /* Returning the contract factory and the contract instance. */
		return {
			GRTUpgradeable,
			grtUpgradeable,
			owner,
			user1,
			user2,
			user3,
        };
    }

	describe("Deployment and token information", function () {

		/* Checking that the owner of the contract is the same as the owner of the network. */
		it("Should set the right owner", async function () {
			const { grtUpgradeable, owner } = await loadFixture(deployFixture);
			/* This is a test that checks that the owner of the contract is the same as the owner of the
			network. */
			expect(await grtUpgradeable.owner()).to.equal(owner.address);
		});

        /* Checking that the name of the token is GRTToken. */
		it("Should assign the right name", async function () {
			const { grtUpgradeable } = await loadFixture(deployFixture);
			/* This is a test that checks that the name of the token is GRTToken. */
			expect(await grtUpgradeable.name()).to.equal("GRTToken");
		});

		/* This is a test that checks that the symbol of the token is GRT. */
		it("Should assign the right symbol", async function () {
			const { grtUpgradeable } = await loadFixture(deployFixture);
			/* This is a test that checks that the symbol of the token is GRT. */
			expect(await grtUpgradeable.symbol()).to.equal("GRT");
		});

		/* This is a test that checks that the decimals of the token is 18. */
		it("Should assign the right decimals", async function () {
			const { grtUpgradeable } = await loadFixture(deployFixture);
			/* This is a test that checks that the decimals of the token is 18. */
			expect(await grtUpgradeable.decimals()).to.equal(18);
		});

		/* This is a test that checks that the total supply of the token is 0. */
		it("Should assign the right total supply", async function () {
			const { grtUpgradeable } = await loadFixture(deployFixture);
			/* This is a test that checks that the total supply of the token is 0. */
			expect(await grtUpgradeable.totalSupply()).to.equal(0);
		});

		/* This is a test that checks that the initial balance of the owner is 0. */
		it("Should assign the right initial balance to users", async function () {
			const { grtUpgradeable, owner } = await loadFixture(deployFixture);
			/* This is a test that checks that the initial balance of the owner is 0. */
			expect(await grtUpgradeable.balanceOf(owner.address)).to.equal(0);
		});
	});

	describe("Mint and burn", function () {

		/* This is a test that checks that the mint function works as expected. */
		it("Should mint the appropriate token amount for the required user", async function () {
			const { grtUpgradeable, owner, user1 } = await loadFixture(deployFixture);
			await grtUpgradeable.connect(owner).mint(user1.address, 50);
			/* Checking that the balance of user1 is 50. */
			expect(await grtUpgradeable.balanceOf(user1.address)).to.equal(50);
		});

		/* This is a test that checks that the mint function emits the Transfer event. */
		it("Should emit Transfer Event during minting", async function () {
			const { grtUpgradeable, owner, user1 } = await loadFixture(deployFixture);
			/* This is a test that checks that the mint function emits the Transfer event. */
			await expect(await grtUpgradeable.connect(owner).mint(user1.address, 50))
			.to.emit(grtUpgradeable, "Transfer")
			.withArgs(ethers.constants.AddressZero, user1.address, 50);
		});

		/* This is a test that checks that the total supply of the token is 50. */
		it("Should update the total supply after minting", async function () {
			const { grtUpgradeable, owner, user1 } = await loadFixture(deployFixture);
			/* This is a function call to the mint function of the GRTUpgradeable contract. */
			await grtUpgradeable.connect(owner).mint(user1.address, 50);
			/* This is a test that checks that the total supply of the token is 50. */
			expect(await grtUpgradeable.totalSupply()).to.equal(50);
		});

		/* This is a test that checks that the balance of user1 is 10 after minting. */
		it("Should update the balance mapping after minting", async function () {
			const { grtUpgradeable, owner, user1 } = await loadFixture(deployFixture);
			/* This is a function call to the mint function of the GRTUpgradeable contract. */
			await grtUpgradeable.connect(owner).mint(user1.address, 10);
			/* This is a test that checks that the balance of user1 is 10. */
			expect(await grtUpgradeable.balanceOf(user1.address)).to.equal(10);
		});

		/* This is a test that checks that the burn function works as expected. */
		it("Should burn the appropriate token amount for the required user", async function () {
			const { grtUpgradeable, owner, user1 } = await loadFixture(deployFixture);
			/* This is a function call to the mint function of the GRTUpgradeable contract. */
			await grtUpgradeable.connect(owner).mint(user1.address, 50);
			/* Checking that the balance of user1 is 50. */
			expect(await grtUpgradeable.balanceOf(user1.address)).to.equal(50);
			await grtUpgradeable.connect(owner).burn(user1.address, 20);
			/* Checking that the balance of user1 is 50-20. */
			expect(await grtUpgradeable.balanceOf(user1.address)).to.equal(50-20);
		});

		/* This is a test that checks that the burn function emits the Transfer event. */
		it("Should emit Transfer Event during burning", async function () {
			const { grtUpgradeable, owner, user1 } = await loadFixture(deployFixture);
			/* This is a function call to the mint function of the GRTUpgradeable contract. */
			await grtUpgradeable.connect(owner).mint(user1.address, 50);
			/* This is a test that checks that the mint function emits the Transfer event. */
			await expect(await grtUpgradeable.connect(owner).burn(user1.address, 10))
			.to.emit(grtUpgradeable, "Transfer")
			.withArgs(user1.address, ethers.constants.AddressZero, 10);
		});

		/* This is a test that checks that the total supply of the token after burning. */
		it("Should update the total supply after burning", async function () {
			const { grtUpgradeable, owner, user1 } = await loadFixture(deployFixture);
			/* This is a function call to the mint function of the GRTUpgradeable contract. */
			await grtUpgradeable.connect(owner).mint(user1.address, 50);
			/* This is a function call to the burn function of the GRTUpgradeable contract. */
			await grtUpgradeable.connect(owner).burn(user1.address, 32);
			/* This is a test that checks that the total supply of the token is 50-32. */
			expect(await grtUpgradeable.totalSupply()).to.equal(50-32);
		});

		/* This is a test that checks that the balance of user1 is 10 after burning. */
		it("Should update the balance mapping after burning", async function () {
			const { grtUpgradeable, owner, user1 } = await loadFixture(deployFixture);
			/* This is a function call to the mint function of the GRTUpgradeable contract. */
			await grtUpgradeable.connect(owner).mint(user1.address, 10);
			/* This is a function call to the burn function of the GRTUpgradeable contract. */
			await grtUpgradeable.connect(owner).burn(user1.address, 2);
			/* This is a test that checks that the balance of user1 is 10 after minting. */
			expect(await grtUpgradeable.balanceOf(user1.address)).to.equal(10-2);
		});
	});

	describe("Transactions", function () {

		/* This is a test that checks that the transfer function works as expected. */
		it("Should transfer tokens between accounts", async function () {
			const { grtUpgradeable, owner, user1, user2, user3 } = await loadFixture(deployFixture);
			await grtUpgradeable.connect(owner).mint(user1.address, 50);
			/* Checking that the balance of user1 is 50. */
			expect(await grtUpgradeable.balanceOf(user1.address)).to.equal(50);
			await grtUpgradeable.connect(user1).transfer(user2.address, 35);
			/* Checking that the balance of user1 is 50-35. */
			expect(await grtUpgradeable.balanceOf(user1.address)).to.equal(50-35);
			/* Checking that the balance of user2 is 35. */
			expect(await grtUpgradeable.balanceOf(user2.address)).to.equal(35);
		});

		/* This is a test that checks that the transfer function emits the Transfer event. */
		it("Should emit Transfer Event during transfer tokens between accounts", async function () {
			const { grtUpgradeable, owner, user1, user2, user3 } = await loadFixture(deployFixture);
			/* This is a function call to the mint function of the GRTUpgradeable contract. */
			await grtUpgradeable.connect(owner).mint(user1.address, 50);
			/* This is a test that checks that the transfer function emits the Transfer event. */
			await expect(await grtUpgradeable.connect(user1).transfer(user2.address, 35))
			.to.emit(grtUpgradeable, "Transfer")
			.withArgs(user1.address, user2.address, 35);
		});

		/* This is a test that checks that the transfer function fails if the sender doesn't have enough
		tokens. */
		it("Should fail if sender doesn’t have enough tokens", async function () {
			const { grtUpgradeable, owner, user1 } = await loadFixture(deployFixture);
			const initialOwnerBalance = await grtUpgradeable.balanceOf(owner.address);
			/* Checking that the transfer fails. */
			await expect(
				grtUpgradeable.connect(user1).transfer(owner.address, 1)
			).to.be.revertedWith("ERC20: transfer amount exceeds balance");
			/* Checking that the balance of the owner has not changed. */
			expect(await grtUpgradeable.balanceOf(owner.address)).to.equal(
				initialOwnerBalance
			);
		});
	});
});