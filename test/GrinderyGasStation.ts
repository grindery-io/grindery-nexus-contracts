import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, deployments, upgrades } from "hardhat";



describe("Grindery Gas Station contract", function () {


    async function deployFixture() {
		await deployments.fixture();
        /* Getting the signers from the hardhat network. */
		const [owner, user1, user2, user3] = await ethers.getSigners();
        const userZero =  await ethers.getSigner(ethers.constants.AddressZero);

        // const grinderyGasStation = await upgrades.deployProxy(
        //     await ethers.getContractFactory("GrinderyGasStation")
        // );


        const grinderyGasStation = await (
            await ethers.getContractFactory("GrinderyGasStation")
        ).deploy();
    	await grinderyGasStation.deployed();


        // const sampleERC20 = await upgrades.deployProxy(
        //     await ethers.getContractFactory("sampleERC20")
        // );
        const sampleERC20 = await (
            await ethers.getContractFactory("SampleERC20")
        ).deploy();
        await sampleERC20.deployed();

        const addrToken = sampleERC20.address;

        /* Returning the contract factory and the contract instance. */
		return {
            grinderyGasStation,
            sampleERC20,
            addrToken,
            owner,
            userZero,
            user1,
            user2,
            user3,
        };
    }

    describe("Owner of the Grindery Gas Station", function () {

        it("Should set the proper initial owner", async function () {
            const { grinderyGasStation, owner } = await loadFixture(deployFixture);
            /* Checking that the owner of the contract is the same as the owner of the hardhat network. */
            expect(await grinderyGasStation.owner()).to.equal(owner.address);
        });

        it("A non owner account should not be able to transfer ownership", async function () {
            /* Loading the fixture. */
            const { grinderyGasStation, user1, user2 } = await loadFixture(deployFixture);
            /* Checking that the `transferOwnership` function is reverted with the message `Ownable:
            caller is not the owner`. */
            await expect(
                grinderyGasStation.connect(user2).transferOwnership(
                    user1.address
                )
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("After a transfer of ownership, the owner should be changed", async function () {
            /* Loading the fixture. */
            const { grinderyGasStation, owner, user1 } = await loadFixture(deployFixture);
            /* Calling the `transferOwnership` function of the `GrinderyGasStation` contract. */
            await grinderyGasStation.connect(owner).transferOwnership(
                user1.address
            );
            /* Checking that the owner of the contract is the same as the owner of the hardhat network. */
            expect(await grinderyGasStation.owner()).to.equal(user1.address);
        });

    });

    describe("Grindery Gas Station - Token exchanges", function () {

        describe("Initial Gas station balance", function () {

            it("Gas Station should get the correct initial token balance", async function () {
                const { grinderyGasStation, sampleERC20, addrToken, user1 } = await loadFixture(deployFixture);
                /* Checking that the balance of the user1 is 0. */
                expect(await sampleERC20.balanceOf(grinderyGasStation.address)).to.equal(0);
                expect(await grinderyGasStation.getContractBalanceToken(
                    addrToken
                )).to.equal(0);
            });

        });


        describe("Transfer from a user to Grindery Gas Station", function () {

            it("Should not allow the transfer if the user does not have enough tokens", async function () {
                /* Loading the fixture. */
                const { grinderyGasStation, sampleERC20, addrToken, owner } = await loadFixture(deployFixture);
                /* Checking that the transfer of 100000 tokens from the owner to the Grindery Gas Station
                contract is reverted. */
                await expect(
                    sampleERC20.connect(owner).transfer(grinderyGasStation.address, 100000)
                ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
            });

            it("Should get the correct balance after transfer", async function () {
                /* Loading the fixture. */
                const { grinderyGasStation, sampleERC20, addrToken, owner } = await loadFixture(deployFixture);
                /* Transferring 50 tokens from the owner to the Grindery Gas Station contract. */
                await sampleERC20.connect(owner).transfer(grinderyGasStation.address, 50);
                /* Checking that the balance of the owner of the token is 1000-50. */
                expect(await sampleERC20.balanceOf(owner.address)).to.equal(1000-50);
                /* Checking that the balance of the contract is 50. */
                expect(await sampleERC20.balanceOf(grinderyGasStation.address)).to.equal(50);
                /* Checking that the contract balance of the token is 50. */
                expect(await grinderyGasStation.getContractBalanceToken(sampleERC20.address)).to.equal(50);
            });

        });


        describe("Transfer from Grindery Gas Station to the user", function () {

            it("Should not allow the transfer to user if the gas station does not have enough tokens", async function () {
                /* Loading the fixture. */
                const { grinderyGasStation, sampleERC20, addrToken, owner, user1 } = await loadFixture(deployFixture);
                /* Checking that the transfer of 100000 tokens from the Grindery Gas Station contract to
                the user1 is reverted. */
                await expect(
                    grinderyGasStation.connect(owner).transfer(
                        addrToken,
                        100000
                    )
                ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
            });

            // it("Should not allow the transfer if the caller is not the owner", async function () {
            //     /* Loading the fixture. */
            //     const { grinderyGasStation, sampleERC20, addrToken, owner, user1 } = await loadFixture(deployFixture);
            //     /* Transferring 50 tokens from the owner to the Grindery Gas Station contract. */
            //     await sampleERC20.connect(owner).transfer(grinderyGasStation.address, 50);
            //     /* Checking that the `transferToken` function is reverted with the message `Ownable: caller
            //     is not the owner`. */
            //     await expect(
            //         grinderyGasStation.connect(user1).transferToken(
            //             addrToken,
            //             user1.address,
            //             10
            //         )
            //     ).to.be.revertedWith("Ownable: caller is not the owner");
            // });

            it("Should update the balance of Gas Station and user after transfer to user", async function () {
                /* Loading the fixture. */
                const { grinderyGasStation, sampleERC20, addrToken, owner, user1 } = await loadFixture(deployFixture);
                /* Transferring 50 tokens from the owner to the Grindery Gas Station contract. */
                await sampleERC20.connect(owner).transfer(grinderyGasStation.address, 50);
                /* Calling the `transferToken` function of the `GrinderyGasStation` contract. */
                await grinderyGasStation.connect(user1).transfer(
                    addrToken,
                    10
                );
                /* Checking that the balance of the user1 is 10. */
                expect(await sampleERC20.balanceOf(user1.address)).to.equal(10);
                /* Checking that the contract balance of the token is 50-10. */
                expect(await grinderyGasStation.getContractBalanceToken(addrToken)).to.equal(50-10);
            });

        });
    });

    describe("Grindery Gas Station - Native exchanges", function () {

        describe("Deposit of native tokens on the Grindery Gas station", function () {

            it("Initial native balance of the Grindery Gas station should be 0", async function () {
                /* Loading the fixture. */
                const { grinderyGasStation } = await loadFixture(deployFixture);
                /* Checking that the balance of the Grindery Gas Station contract is 0. */
                expect(await grinderyGasStation.getBalance()).to.equal(0);
            });

            it("Should update the balance of Gas Station and user after transfer from user", async function () {
                /* Loading the fixture. */
                const { grinderyGasStation, user1 } = await loadFixture(deployFixture);
                /* Sending 0.0000000001 Ether to the Grindery Gas Station contract. */
                await user1.sendTransaction({
                    to: grinderyGasStation.address,
                    value: ethers.utils.parseEther("0.0000000001")
                });
                /* Checking that the balance of the Grindery Gas Station contract is 2. */
                expect(await grinderyGasStation.getBalance())
                .to.equal(ethers.utils.parseEther("0.0000000001"));
            });

        });


        describe("Transaction from the Grindery Gas station to the user", function () {

            it("Should not allow the transaction if the Gas Station’s balance is insufficient", async function () {
                /* Loading the fixture. */
                const { grinderyGasStation, owner, user1 } = await loadFixture(deployFixture);
                /* Checking that the user cannot send more than their balance. */
                await expect(
                    grinderyGasStation.connect(owner).transfer(
                        ethers.constants.AddressZero,
                        ethers.utils.parseEther("0.0000000001")
                    )
                ).to.be.revertedWith("GasStation: Transfer amount exceeds balance");
            });

            it("Should update the balance of Gas Station and user after transfer to user", async function () {
                /* Loading the fixture. */
                const { grinderyGasStation, owner, user1 } = await loadFixture(deployFixture);
                /* Getting the balance of the user1 account. */
                const user1BalanceInit = await ethers.provider.getBalance(user1.address);
                /* Converting the string "0.0000000001" to a BigNumber. */
                const amountToSend = ethers.BigNumber.from(ethers.utils.parseEther("0.0000000001"));
                /* Adding the amount to send to the initial balance of the user1 account. */
                let expecteduser1Balance = user1BalanceInit.add(amountToSend);
                // /* Sending 1 Ether to the Grindery Gas Station contract. */
                // await owner.sendTransaction({
                //     to: grinderyGasStation.address,
                //     value: ethers.utils.parseEther("1")
                // });
                /* Sending 0.0000000001 Ether to the user1 account. */
                const tx = await grinderyGasStation.connect(user1).transfer(
                    ethers.constants.AddressZero,
                    ethers.utils.parseEther("0.0000000001"),
                    { value: ethers.utils.parseEther("1") }
                );
                /* Waiting for the transaction to be mined. */
                const receipt = await tx.wait();
                /* Calculating the gas cost for the transaction. */
                const gasCostForTxn = receipt.gasUsed.mul(receipt.effectiveGasPrice);
                /* Subtracting the gas cost from the expected balance of user1. */
                expecteduser1Balance = expecteduser1Balance.sub(gasCostForTxn);
                /* Subtracting 1 ether from the expecteduser1Balance. */
                expecteduser1Balance = expecteduser1Balance.sub(
                    ethers.BigNumber.from(ethers.utils.parseEther("1"))
                )
                /* Calculating the expected balance of the gas station contract. */
                const expectedGasStationBalance = ethers.BigNumber.from(
                    ethers.utils.parseEther("1")
                ).sub(
                    ethers.BigNumber.from(
                        ethers.utils.parseEther("0.0000000001")
                    )
                );
                /* Checking that the balance of the user1 account is equal to the expected balance. */
                expect(await ethers.provider.getBalance(user1.address)).to.equal(expecteduser1Balance);
                /* Checking that the balance of the Grindery Gas Station contract is equal to the
                expected balance. */
                expect(await ethers.provider.getBalance(grinderyGasStation.address))
                .to.equal(expectedGasStationBalance);
            });

        });
    });
})