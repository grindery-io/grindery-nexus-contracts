import { expect } from "chai";
import { parseUnits } from "ethers";
import { ethers } from "hardhat";
import { AgentBondingCurve, TestToken } from "../typechain-types";

describe("AgentBondingCurve", function () {
  let bondingCurve: AgentBondingCurve;
  let gxToken: TestToken;
  let owner: any;
  let user: any;

  const P_max = parseUnits("1", 18); // 1 ETH max price
  const S_mid = parseUnits("500000", 18); // midpoint supply
  const k = parseUnits("0.00001", 18); // curvature
  const C = parseUnits("0", 18); // constant
  const fee = 200; // 2%

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();

    // Deploy mock GX token
    const GXToken = await ethers.getContractFactory("TestERC20");
    gxToken = await GXToken.deploy("GX Token", "GX", 18);
    await gxToken.waitForDeployment();

    // Mint GX to bonding curve for sell liquidity
    await gxToken.mint(owner.address, parseUnits("1000000", 18));

    // Deploy bonding curve
    const AgentBondingCurve = await ethers.getContractFactory("AgentBondingCurve");
    bondingCurve = await AgentBondingCurve.deploy(
      await gxToken.getAddress(),
      owner.address, // treasury
      P_max,
      S_mid,
      k,
      C,
      fee
    );
    await bondingCurve.waitForDeployment();

    // Approve bonding curve to spend GX
    await gxToken.connect(owner).approve(await bondingCurve.getAddress(), parseUnits("1000000", 18));
  });

  it("should deploy with correct parameters", async function () {
    expect(await bondingCurve.gxToken()).to.equal(await gxToken.getAddress());
    expect(await bondingCurve.owner()).to.equal(owner.address);
  });

  it("should calculate price for buying", async function () {
    const price = await bondingCurve.getPrice(parseUnits("1000", 18));
    expect(price).to.be.gt(0);
  });

  it("should allow user to buy GX tokens", async function () {
    const amount = parseUnits("1000", 18);
    const price = await bondingCurve.getPrice(amount);

    await bondingCurve.connect(user).buy(amount, {
      value: price,
    });

    const balance = await gxToken.balanceOf(user.address);
    expect(balance).to.equal(amount);
  });

  it("should allow user to sell GX tokens", async function () {
    const amount = parseUnits("1000", 18);
    const price = await bondingCurve.getPrice(amount);

    // Buy first
    await bondingCurve.connect(user).buy(amount, {
      value: price,
    });

    // Approve for selling
    await gxToken.connect(user).approve(await bondingCurve.getAddress(), amount);

    // Sell back
    await bondingCurve.connect(user).sell(amount);

    const balanceAfter = await gxToken.balanceOf(user.address);
    expect(balanceAfter).to.equal(0);
  });
});
