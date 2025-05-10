import { expect } from "chai";
import { Contract, Signer } from "ethers";
import { ethers, upgrades } from "hardhat";

describe("AIGasTank", () => {
  let gasTank: Contract;
  let deployer: Signer;
  let operator: Signer;
  let agent1: Signer;
  let agent2: Signer;
  let other: Signer;
  let deployerAddr: string;
  let operatorAddr: string;
  let agent1Addr: string;
  let agent2Addr: string;

  beforeEach(async () => {
    [deployer, operator, agent1, agent2, other] = await ethers.getSigners();
    deployerAddr = await deployer.getAddress();
    operatorAddr = await operator.getAddress();
    agent1Addr = await agent1.getAddress();
    agent2Addr = await agent2.getAddress();

    const AIGasTank = await ethers.getContractFactory("AIGasTank");
    gasTank = await upgrades.deployProxy(AIGasTank, [], {
      initializer: "initialize",
    });
    await gasTank.deployed();
  });

  it("should set deployer as admin", async () => {
    const DEFAULT_ADMIN_ROLE = await gasTank.DEFAULT_ADMIN_ROLE();
    expect(await gasTank.hasRole(DEFAULT_ADMIN_ROLE, deployerAddr)).to.be.true;
  });

  it("should allow admin to grant operator role", async () => {
    const OPERATOR_ROLE = await gasTank.OPERATOR_ROLE();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);
    expect(await gasTank.hasRole(OPERATOR_ROLE, operatorAddr)).to.be.true;
  });

  it("should allow only operator to report fees", async () => {
    const OPERATOR_ROLE = await gasTank.OPERATOR_ROLE();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);

    const structs = [
      { agent: agent1Addr, amount: ethers.utils.parseEther("1.0") },
      { agent: agent2Addr, amount: ethers.utils.parseEther("2.5") },
    ];

    await expect(
      gasTank.connect(operator).reportFees(structs)
    ).to.emit(gasTank, "FeeReported").withArgs(agent1Addr, ethers.utils.parseEther("1.0"));

    expect(await gasTank.agentBalances(agent1Addr)).to.equal(ethers.utils.parseEther("1.0"));
    expect(await gasTank.agentBalances(agent2Addr)).to.equal(ethers.utils.parseEther("2.5"));
  });

  it("should revert if non-operator tries to report fees", async () => {
    const structs = [
      { agent: agent1Addr, amount: ethers.utils.parseEther("1.0") },
    ];
    await expect(gasTank.connect(other).reportFees(structs)).to.be.revertedWith(
      `AccessControl: account ${await other.getAddress().toLowerCase()} is missing role ${await gasTank.OPERATOR_ROLE()}`
    );
  });

  it("should emit events when reporting multiple fees", async () => {
    const OPERATOR_ROLE = await gasTank.OPERATOR_ROLE();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);

    const structs = [
      { agent: agent1Addr, amount: ethers.utils.parseEther("1") },
      { agent: agent2Addr, amount: ethers.utils.parseEther("2") },
    ];

    const tx = await gasTank.connect(operator).reportFees(structs);
    const receipt = await tx.wait();

    const feeEvents = receipt.events?.filter((e) => e.event === "FeeReported");
    expect(feeEvents?.length).to.equal(2);
    expect(feeEvents?.[0].args?.agent).to.equal(agent1Addr);
    expect(feeEvents?.[1].args?.agent).to.equal(agent2Addr);
  });

  it("should allow admin to revoke operator role", async () => {
    const OPERATOR_ROLE = await gasTank.OPERATOR_ROLE();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);
    await gasTank.revokeRole(OPERATOR_ROLE, operatorAddr);
    expect(await gasTank.hasRole(OPERATOR_ROLE, operatorAddr)).to.be.false;
  });
});
