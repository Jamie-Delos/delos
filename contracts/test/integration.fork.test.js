// End-to-end integration test against a fork of Base mainnet (real Uniswap V3).
//
// Run with:
//   BASE_FORK_RPC_URL=https://mainnet.base.org npx hardhat test test/integration.fork.test.js
//
// If no fork RPC is configured (the Uniswap contracts aren't present), the suite skips itself.
const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const ADDR = require("../scripts/addresses");
const { computeLaunchParams, computeGraduationTick } = require("../scripts/lib/launchParams");

const UNI = ADDR.base; // Base mainnet addresses (state provided by the fork)
const FEE = 10000; // 1% tier — the launch standard
const LAUNCH_PRICE = 1e-8;

const WETH_ABI = [
  "function deposit() payable",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];

describe("launch -> buy -> collect fees, with graduation split (Base fork)", function () {
  this.timeout(180000);

  let deployer, creator, buyer;
  let factory, locker, feeVault;

  before(async function () {
    const code = await ethers.provider.getCode(UNI.NonfungiblePositionManager);
    if (code === "0x") {
      console.log("      (no fork detected — set BASE_FORK_RPC_URL to run this suite)");
      this.skip();
    }
    [deployer, creator, buyer] = await ethers.getSigners();

    const FeeVault = await ethers.getContractFactory("FeeVault", deployer);
    feeVault = await FeeVault.deploy(deployer.address);
    await feeVault.waitForDeployment();

    const LaunchLocker = await ethers.getContractFactory("LaunchLocker", deployer);
    locker = await LaunchLocker.deploy(UNI.NonfungiblePositionManager, await feeVault.getAddress(), 2000);
    await locker.waitForDeployment();

    const LaunchFactory = await ethers.getContractFactory("LaunchFactory", deployer);
    factory = await LaunchFactory.deploy(UNI.NonfungiblePositionManager, UNI.WETH, await locker.getAddress());
    await factory.waitForDeployment();

    await (await locker.initFactory(await factory.getAddress())).wait();
  });

  // Launch a token whose graduation tick is placed either just at the launch price (so any buy
  // graduates it) or far in the appreciation direction (so a normal buy never reaches it).
  async function launch(mode) {
    const factoryAddr = await factory.getAddress();
    const nonce = await ethers.provider.getTransactionCount(factoryAddr);
    const predicted = ethers.getCreateAddress({ from: factoryAddr, nonce });

    const params = computeLaunchParams({ token: predicted, weth: UNI.WETH, tokenDecimals: 18, fee: FEE, priceWethPerToken: LAUNCH_PRICE });
    const launchTick = computeGraduationTick({ token: predicted, weth: UNI.WETH, tokenDecimals: 18, graduationPriceWethPerToken: LAUNCH_PRICE });
    const sign = params.tokenIsToken0 ? 1 : -1; // direction price moves as the token appreciates
    const graduationTick = mode === "immediate" ? launchTick : launchTick + sign * 500000;

    const totalSupply = 1_000_000_000n * 10n ** 18n;
    const tx = await factory.connect(creator).createLaunch({
      name: "Fork Test", symbol: "FORK", totalSupply, decimals: 18, fee: FEE,
      sqrtPriceX96: params.sqrtPriceX96, tickLower: params.tickLower, tickUpper: params.tickUpper, graduationTick,
    });
    const receipt = await tx.wait();
    const ev = receipt.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((p) => p && p.name === "Launched");
    return { token: ev.args.token, tokenId: ev.args.tokenId, pool: ev.args.pool, liquidity: ev.args.liquidity };
  }

  async function buy(tokenAddr, ethAmount) {
    const weth = new ethers.Contract(UNI.WETH, WETH_ABI, buyer);
    const router = new ethers.Contract(UNI.SwapRouter02, ROUTER_ABI, buyer);
    const amountIn = ethers.parseEther(ethAmount);
    await (await weth.deposit({ value: amountIn })).wait();
    await (await weth.approve(UNI.SwapRouter02, amountIn)).wait();
    await (await router.exactInputSingle({ tokenIn: UNI.WETH, tokenOut: tokenAddr, fee: FEE, recipient: buyer.address, amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0 })).wait();
  }

  async function collectAndMeasure(tokenId) {
    const weth = new ethers.Contract(UNI.WETH, WETH_ABI, deployer);
    const vaultAddr = await feeVault.getAddress();
    const cBefore = await weth.balanceOf(creator.address);
    const vBefore = await weth.balanceOf(vaultAddr);
    await (await locker.collectFees(tokenId)).wait();
    return {
      creatorGain: (await weth.balanceOf(creator.address)) - cBefore,
      vaultGain: (await weth.balanceOf(vaultAddr)) - vBefore,
    };
  }

  it("pre-graduation: creator keeps 100%, vault gets nothing", async function () {
    const { token, tokenId, liquidity } = await launch("never");
    expect(liquidity).to.be.greaterThan(0n);
    expect(await locker.isGraduated(tokenId)).to.equal(false);

    await buy(token, "0.5");
    expect(await locker.isGraduated(tokenId)).to.equal(false);

    const { creatorGain, vaultGain } = await collectAndMeasure(tokenId);
    console.log("      pre-grad  creator:", ethers.formatEther(creatorGain), " vault:", ethers.formatEther(vaultGain));
    expect(creatorGain).to.be.greaterThan(0n);
    expect(vaultGain).to.equal(0n);
  });

  it("post-graduation: fees split 80% creator / 20% vault", async function () {
    const { token, tokenId } = await launch("immediate");
    await buy(token, "0.5");
    expect(await locker.isGraduated(tokenId)).to.equal(true);

    const { creatorGain, vaultGain } = await collectAndMeasure(tokenId);
    console.log("      post-grad creator:", ethers.formatEther(creatorGain), " vault:", ethers.formatEther(vaultGain));
    expect(creatorGain).to.be.greaterThan(0n);
    expect(vaultGain).to.be.greaterThan(0n);
    // creator 80 / vault 20  => creator == 4x vault (allow rounding dust).
    const ratio = Number(creatorGain) / Number(vaultGain);
    expect(ratio).to.be.greaterThan(3.9);
    expect(ratio).to.be.lessThan(4.1);
  });
});
