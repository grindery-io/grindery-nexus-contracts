import { expect } from "chai";
import { Contract, Signer } from "ethers";
import { deployments, ethers } from "hardhat";
import { AIGasTank, AIGasTank__factory, TestERC20, TestERC20__factory } from "../typechain-types";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("AIGasTank", () => {
  let gasTank: AIGasTank;
  let testErc20: TestERC20;
  let testExternalToken: TestERC20;
  let deployer: Signer;
  let operator: Signer;
  let agent1: Signer;
  let agent2: Signer;
  let user: Signer;
  let deployerAddr: string;
  let operatorAddr: string;
  let agent1Addr: string;
  let agent2Addr: string;
  let userAddr: string;

  async function deployFixture() {
    const [owner, operator] = await ethers.getSigners();
    await deployments.fixture();

    const TestERC20Deployment = await deployments.get("TestGX");
    const testErc20 = TestERC20__factory.connect(TestERC20Deployment.address, owner);
    const testExternalToken = await new TestERC20__factory(owner).deploy(ethers.parseEther("10000"));
    await testErc20
      .connect(operator)
      .approve(operator.address, ethers.parseEther("5000"))
      .then((x) => x.wait());
    await testErc20
      .connect(operator)
      .transferFrom(operator.address, owner.address, ethers.parseEther("5000"))
      .then((x) => x.wait());
    const GasTank = await deployments.get("AIGasTank");
    const gasTank = AIGasTank__factory.connect(GasTank.address, owner);

    return {
      testErc20,
      gasTank,
      testExternalToken,
    };
  }

  beforeEach(async () => {
    [deployer, operator, agent1, agent2, user] = await ethers.getSigners();
    deployerAddr = await deployer.getAddress();
    operatorAddr = await operator.getAddress();
    agent1Addr = await agent1.getAddress();
    agent2Addr = await agent2.getAddress();
    userAddr = await user.getAddress();

    const fixture = await loadFixture(deployFixture);
    gasTank = fixture.gasTank;
    testErc20 = fixture.testErc20;
    testExternalToken = fixture.testExternalToken;
  });

  it("should set deployer as admin", async () => {
    const DEFAULT_ADMIN_ROLE = await gasTank.DEFAULT_ADMIN_ROLE();
    expect(await gasTank.hasRole(DEFAULT_ADMIN_ROLE, deployerAddr)).to.be.true;
  });

  it("should allow admin to grant operator role", async () => {
    const OPERATOR_ROLE = await gasTank.ROLE_OPERATOR();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);
    expect(await gasTank.hasRole(OPERATOR_ROLE, operatorAddr)).to.be.true;
  });

  it("should allow operator to report fees", async () => {
    const OPERATOR_ROLE = await gasTank.ROLE_OPERATOR();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);

    const structs = [
      { agent: agent1Addr, amount: ethers.parseEther("1.0"), user: userAddr },
      { agent: agent2Addr, amount: ethers.parseEther("2.5"), user: userAddr },
    ];

    const batchId = ethers.randomBytes(32);
    await expect(gasTank.connect(operator).reportFees(batchId, structs)).to.be.not.reverted;
  });

  it("should revert if non-operator tries to report fees", async () => {
    const structs = [{ agent: agent1Addr, amount: ethers.parseEther("1.0"), user: userAddr }];
    await expect(gasTank.connect(user).reportFees(ethers.randomBytes(32), structs)).to.be.revertedWithCustomError(
      gasTank,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("should allow user to deposit", async () => {
    await testErc20
      .connect(deployer)
      .transfer(user, ethers.parseEther("50"))
      .then((x) => x.wait());
    await testErc20
      .connect(user)
      .approve(gasTank.getAddress(), ethers.parseEther("10"))
      .then((x) => x.wait());
    await expect(gasTank.connect(user).deposit(ethers.parseEther("10"), userAddr))
      .to.emit(gasTank, "Deposit")
      .withArgs(userAddr, ethers.parseEther("10"));
    expect(await gasTank.balanceOf(user)).to.equal(ethers.parseEther("10"));
    expect(await testErc20.balanceOf(userAddr)).to.equal(ethers.parseEther("40"));
  });

  it("should allow user to deposit from another wallet", async () => {
    const OPERATOR_ROLE = await gasTank.ROLE_OPERATOR();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);
    await testErc20
      .connect(deployer)
      .transfer(agent1, ethers.parseEther("50"))
      .then((x) => x.wait());
    await testErc20
      .connect(agent1)
      .approve(gasTank.getAddress(), ethers.parseEther("10"))
      .then((x) => x.wait());
    await expect(gasTank.connect(operator).depositTo(ethers.parseEther("10"), userAddr, agent1Addr))
      .to.emit(gasTank, "Deposit")
      .withArgs(userAddr, ethers.parseEther("10"));
    expect(await gasTank.balanceOf(user)).to.equal(ethers.parseEther("10"));
    expect(await testErc20.balanceOf(agent1Addr)).to.equal(ethers.parseEther("40"));
  });
  /*
  it("should allow user to withdraw", async () => {
    await testErc20
      .connect(deployer)
      .transfer(user, ethers.parseEther("10"))
      .then((x) => x.wait());
    await testErc20
      .connect(user)
      .approve(gasTank.getAddress(), ethers.parseEther("10"))
      .then((x) => x.wait());
    await gasTank.connect(user).deposit(ethers.parseEther("10"), userAddr);
    await expect(gasTank.connect(user).withdraw(ethers.parseEther("5"), userAddr))
      .to.emit(gasTank, "Withdrawal")
      .withArgs(userAddr, ethers.parseEther("5"));
    expect(await gasTank.balanceOf(user)).to.equal(ethers.parseEther("5"));
    expect(await testErc20.balanceOf(userAddr)).to.equal(ethers.parseEther("5"));
  });
  */
  it("should allow user to withdraw to another wallet", async () => {
    const OPERATOR_ROLE = await gasTank.ROLE_OPERATOR();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);
    await testErc20
      .connect(deployer)
      .transfer(user, ethers.parseEther("10"))
      .then((x) => x.wait());
    await testErc20
      .connect(user)
      .approve(gasTank.getAddress(), ethers.parseEther("10"))
      .then((x) => x.wait());
    await gasTank.connect(user).deposit(ethers.parseEther("10"), userAddr);
    await expect(gasTank.connect(operator).withdrawTo(ethers.parseEther("5"), userAddr, agent1Addr))
      .to.emit(gasTank, "Withdrawal")
      .withArgs(userAddr, ethers.parseEther("5"));
    expect(await gasTank.balanceOf(user)).to.equal(ethers.parseEther("5"));
    expect(await testErc20.balanceOf(agent1Addr)).to.equal(ethers.parseEther("5"));
  });

  it("should allow operator to call deposit on behalf of user", async () => {
    const OPERATOR_ROLE = await gasTank.ROLE_OPERATOR();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);
    await testErc20
      .connect(deployer)
      .transfer(user, ethers.parseEther("50"))
      .then((x) => x.wait());
    await testErc20
      .connect(user)
      .approve(gasTank.getAddress(), ethers.parseEther("10"))
      .then((x) => x.wait());
    await expect(gasTank.connect(operator).deposit(ethers.parseEther("10"), userAddr))
      .to.emit(gasTank, "Deposit")
      .withArgs(userAddr, ethers.parseEther("10"));
    expect(await gasTank.balanceOf(operator)).to.equal(ethers.parseEther("0"));
    expect(await gasTank.balanceOf(user)).to.equal(ethers.parseEther("10"));
    expect(await testErc20.balanceOf(userAddr)).to.equal(ethers.parseEther("40"));
  });

  it("should allow operator to call deposit on behalf of user with external token", async () => {
    const OPERATOR_ROLE = await gasTank.ROLE_OPERATOR();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);
    await testExternalToken
      .connect(deployer)
      .transfer(user, ethers.parseEther("50"))
      .then((x) => x.wait());
    await testExternalToken
      .connect(user)
      .approve(gasTank.getAddress(), ethers.parseEther("10"))
      .then((x) => x.wait());
    await testErc20
      .connect(deployer)
      .approve(gasTank.getAddress(), ethers.MaxUint256)
      .then((x) => x.wait());
    const originalBaseTokenBalance = await testErc20.balanceOf(deployerAddr);
    await expect(
      gasTank
        .connect(operator)
        .depositWithExternalToken(
          ethers.parseEther("10"),
          userAddr,
          testExternalToken.getAddress(),
          3n,
          2n,
          deployerAddr
        )
    )
      .to.emit(gasTank, "Deposit")
      .withArgs(userAddr, (ethers.parseEther("10") * 3n) / 2n);
    expect(await gasTank.balanceOf(operator)).to.equal(ethers.parseEther("0"));
    expect(await gasTank.balanceOf(user)).to.equal((ethers.parseEther("10") * 3n) / 2n);
    expect(await testErc20.balanceOf(deployer)).to.equal(
      originalBaseTokenBalance - (ethers.parseEther("10") * 3n) / 2n
    );
    expect(await testExternalToken.balanceOf(userAddr)).to.equal(ethers.parseEther("40"));
  });

  it("should allow operator to deposit from treasury to user balance", async () => {
    const OPERATOR_ROLE = await gasTank.ROLE_OPERATOR();
    await gasTank.grantRole(OPERATOR_ROLE, operator);
    await testErc20
      .connect(deployer)
      .transfer(operatorAddr, ethers.parseEther("50"))
      .then((x) => x.wait());
    await testErc20
      .connect(operator)
      .approve(gasTank.getAddress(), ethers.parseEther("10"))
      .then((x) => x.wait());
    await expect(gasTank.connect(operator).depositInternal(ethers.parseEther("10"), userAddr))
      .to.emit(gasTank, "Deposit")
      .withArgs(userAddr, ethers.parseEther("10"));
    expect(await gasTank.balanceOf(operator)).to.equal(ethers.parseEther("0"));
    expect(await gasTank.balanceOf(user)).to.equal(ethers.parseEther("10"));
    expect(await testErc20.balanceOf(operatorAddr)).to.equal(ethers.parseEther("40"));
  });
  /*
  it("should allow operator to call withdraw on behalf of user", async () => {
    const OPERATOR_ROLE = await gasTank.ROLE_OPERATOR();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);
    await testErc20
      .connect(deployer)
      .transfer(user, ethers.parseEther("10"))
      .then((x) => x.wait());
    await testErc20
      .connect(user)
      .approve(gasTank.getAddress(), ethers.parseEther("10"))
      .then((x) => x.wait());
    await gasTank.connect(user).deposit(ethers.parseEther("10"), userAddr);
    await expect(gasTank.connect(operator).withdraw(ethers.parseEther("5"), userAddr))
      .to.emit(gasTank, "Withdrawal")
      .withArgs(userAddr, ethers.parseEther("5"));
    expect(await gasTank.balanceOf(operator)).to.equal(ethers.parseEther("0"));
    expect(await gasTank.balanceOf(user)).to.equal(ethers.parseEther("5"));
    expect(await testErc20.balanceOf(userAddr)).to.equal(ethers.parseEther("5"));
  });
  */
  it("should reject normal user from calling deposit on behalf of other user", async () => {
    await testErc20
      .connect(deployer)
      .transfer(user, ethers.parseEther("10"))
      .then((x) => x.wait());
    await testErc20
      .connect(user)
      .approve(gasTank.getAddress(), ethers.parseEther("10"))
      .then((x) => x.wait());
    await expect(gasTank.connect(agent1).deposit(ethers.parseEther("10"), userAddr)).to.be.revertedWithCustomError(
      gasTank,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("should reject normal user from calling internal deposit", async () => {
    await testErc20
      .connect(deployer)
      .transfer(user, ethers.parseEther("10"))
      .then((x) => x.wait());
    await testErc20
      .connect(user)
      .approve(gasTank.getAddress(), ethers.parseEther("10"))
      .then((x) => x.wait());
    await expect(
      gasTank.connect(agent1).depositInternal(ethers.parseEther("10"), userAddr)
    ).to.be.revertedWithCustomError(gasTank, "AccessControlUnauthorizedAccount");
  });
  /*
  it("should reject normal user from calling withdraw on behalf of other user", async () => {
    await testErc20
      .connect(deployer)
      .transfer(user, ethers.parseEther("10"))
      .then((x) => x.wait());
    await testErc20
      .connect(user)
      .approve(gasTank.getAddress(), ethers.parseEther("10"))
      .then((x) => x.wait());
    await gasTank.connect(user).deposit(ethers.parseEther("10"), userAddr);
    await expect(gasTank.connect(agent1).withdraw(ethers.parseEther("5"), userAddr)).to.be.revertedWithCustomError(
      gasTank,
      "AccessControlUnauthorizedAccount"
    );
  });
  */
  it("should allow operator to call withdraw on behalf of user with external token", async () => {
    const OPERATOR_ROLE = await gasTank.ROLE_OPERATOR();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);
    await testExternalToken
      .connect(deployer)
      .transfer(user, ethers.parseEther("50"))
      .then((x) => x.wait());
    await testExternalToken
      .connect(user)
      .approve(gasTank.getAddress(), ethers.parseEther("10"))
      .then((x) => x.wait());
    await testErc20
      .connect(deployer)
      .approve(gasTank.getAddress(), ethers.MaxUint256)
      .then((x) => x.wait());
    const originalBaseTokenBalance = await testErc20.balanceOf(deployerAddr);
    await expect(
      gasTank
        .connect(operator)
        .depositWithExternalToken(
          ethers.parseEther("10"),
          userAddr,
          testExternalToken.getAddress(),
          3n,
          2n,
          deployerAddr
        )
    )
      .to.emit(gasTank, "Deposit")
      .withArgs(userAddr, (ethers.parseEther("10") * 3n) / 2n);
    expect(await gasTank.balanceOf(operator)).to.equal(ethers.parseEther("0"));
    expect(await gasTank.balanceOf(user)).to.equal((ethers.parseEther("10") * 3n) / 2n);
    expect(await testErc20.balanceOf(deployer)).to.equal(
      originalBaseTokenBalance - (ethers.parseEther("10") * 3n) / 2n
    );
    expect(await testExternalToken.balanceOf(userAddr)).to.equal(ethers.parseEther("40"));
    await expect(
      gasTank
        .connect(operator)
        .withdrawWithExternalTokenTo(
          ethers.parseEther("3"),
          userAddr,
          testExternalToken.getAddress(),
          3n,
          2n,
          userAddr
        )
    )
      .to.emit(gasTank, "Withdrawal")
      .withArgs(userAddr, ethers.parseEther("3"));
    expect(await testExternalToken.balanceOf(userAddr)).to.equal(ethers.parseEther("42"));
  });
  it("should emit event when reporting fee", async () => {
    const OPERATOR_ROLE = await gasTank.ROLE_OPERATOR();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);

    await testErc20
      .connect(deployer)
      .transfer(user, ethers.parseEther("10"))
      .then((x) => x.wait());
    await testErc20
      .connect(user)
      .approve(gasTank.getAddress(), ethers.parseEther("10"))
      .then((x) => x.wait());
    await gasTank.connect(user).deposit(ethers.parseEther("10"), userAddr);

    const batchId = ethers.randomBytes(32);
    const structs = [{ agent: agent1Addr, amount: ethers.parseEther("1"), user: userAddr }];
    await expect(gasTank.connect(operator).reportFees(batchId, structs))
      .to.emit(gasTank, "FeeCharged")
      .withArgs(batchId, userAddr, agent1Addr, 0, ethers.parseEther("1"));

    expect(await gasTank.balanceOf(agent1)).to.equal(ethers.parseEther("1"));
  });

  it("should emit events when reporting multiple fees", async () => {
    const OPERATOR_ROLE = await gasTank.ROLE_OPERATOR();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);

    await testErc20
      .connect(deployer)
      .transfer(user, ethers.parseEther("10"))
      .then((x) => x.wait());
    await testErc20
      .connect(user)
      .approve(gasTank.getAddress(), ethers.parseEther("10"))
      .then((x) => x.wait());
    await gasTank.connect(user).deposit(ethers.parseEther("10"), userAddr);

    const structs = [
      { agent: agent1Addr, amount: ethers.parseEther("1"), user: userAddr },
      { agent: agent2Addr, amount: ethers.parseEther("2"), user: userAddr },
    ];
    const batchId = ethers.randomBytes(32);
    await expect(gasTank.connect(operator).reportFees(batchId, structs))
      .to.emit(gasTank, "FeeCharged")
      .withArgs(batchId, userAddr, agent1Addr, 0, ethers.parseEther("1"))
      .to.emit(gasTank, "FeeCharged")
      .withArgs(batchId, userAddr, agent2Addr, 1, ethers.parseEther("2"));

    expect(await gasTank.balanceOf(agent1)).to.equal(ethers.parseEther("1"));
    expect(await gasTank.balanceOf(agent2)).to.equal(ethers.parseEther("2"));
  });

  it("should emit failure event when balance is not enough", async () => {
    const OPERATOR_ROLE = await gasTank.ROLE_OPERATOR();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);

    await testErc20
      .connect(deployer)
      .transfer(user, ethers.parseEther("10"))
      .then((x) => x.wait());
    await testErc20
      .connect(user)
      .approve(gasTank.getAddress(), ethers.parseEther("1"))
      .then((x) => x.wait());
    await gasTank.connect(user).deposit(ethers.parseEther("1"), userAddr);

    const structs = [{ agent: agent1Addr, amount: ethers.parseEther("2"), user: userAddr }];
    const batchId = ethers.randomBytes(32);
    await expect(gasTank.connect(operator).reportFees(batchId, structs))
      .to.emit(gasTank, "FeeChargeFailed")
      .withArgs(batchId, userAddr, agent1Addr, 0, ethers.parseEther("2"));
    expect(await gasTank.balanceOf(user)).to.equal(ethers.parseEther("1"));
    expect(await gasTank.balanceOf(agent1)).to.equal(ethers.parseEther("0"));
  });

  it("should emit correct events when some charges fail", async () => {
    const OPERATOR_ROLE = await gasTank.ROLE_OPERATOR();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);

    await testErc20
      .connect(deployer)
      .transfer(user, ethers.parseEther("10"))
      .then((x) => x.wait());
    await testErc20
      .connect(user)
      .approve(gasTank.getAddress(), ethers.parseEther("1.5"))
      .then((x) => x.wait());
    await gasTank.connect(user).deposit(ethers.parseEther("1.5"), userAddr);

    const structs = [
      { agent: agent1Addr, amount: ethers.parseEther("1"), user: userAddr },
      { agent: agent2Addr, amount: ethers.parseEther("2"), user: userAddr },
    ];
    const batchId = ethers.randomBytes(32);
    await expect(gasTank.connect(operator).reportFees(batchId, structs))
      .to.emit(gasTank, "FeeCharged")
      .withArgs(batchId, userAddr, agent1Addr, 0, ethers.parseEther("1"))
      .to.emit(gasTank, "FeeChargeFailed")
      .withArgs(batchId, userAddr, agent2Addr, 1, ethers.parseEther("2"));

    expect(await gasTank.balanceOf(agent1)).to.equal(ethers.parseEther("1"));
    expect(await gasTank.balanceOf(agent2)).to.equal(ethers.parseEther("0"));
    expect(await gasTank.balanceOf(user)).to.equal(ethers.parseEther("0.5"));
  });

  it("should allow admin to revoke operator role", async () => {
    const OPERATOR_ROLE = await gasTank.ROLE_OPERATOR();
    await gasTank.grantRole(OPERATOR_ROLE, operatorAddr);
    expect(await gasTank.hasRole(OPERATOR_ROLE, operatorAddr)).to.be.true;
    await gasTank.revokeRole(OPERATOR_ROLE, operatorAddr);
    expect(await gasTank.hasRole(OPERATOR_ROLE, operatorAddr)).to.be.false;
  });
});
