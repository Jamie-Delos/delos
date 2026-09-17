// AUDIT (2026-09-17), CX-H1 residual (raised by Neil): a direct post-graduation pool trade was
// estimated from an impact-FREE spot, then given a fixed 2% minimum-out. On a shallow freshly-graduated
// pool a normal trade's real price impact exceeds 2%, so the linear-estimate minimum-out makes it
// REVERT even though liquidity is healthy. The fix quotes the real route with Uniswap QuoterV2
// (impact-aware) and bases the minimum-out on that. This test proves both halves against REAL Uniswap:
//   (a) the impact-free linear estimate overstates output vs the QuoterV2 quote for a normal trade; and
//   (b) a swap with minOut = 98% of the LINEAR estimate reverts, while minOut = 98% of the QUOTER quote fills.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const E = ethers.parseEther;
const UF = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
const NPM = require('@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json');
const ROUTER = require('@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json');
const QUOTER = require('@uniswap/v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json');
const POOL = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json');

async function deploy(name, ...args) { const c = await (await ethers.getContractFactory(name)).deploy(...args); await c.waitForDeployment(); return c; }
async function uni(a, signer, ...args) { const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args); await c.waitForDeployment(); return c; }

describe('AUDIT CX-H1 (Neil): direct-pool trades must be quoted with price impact (QuoterV2), not a spot estimate', function () {
  this.timeout(120000);
  it('the impact-free estimate overstates output and its minOut reverts; the QuoterV2 quote fills', async () => {
    const [owner, platform, creator, buyer] = await ethers.getSigners();
    const weth = await deploy('WETH9');
    const uf = await uni(UF, owner);
    const npm = await uni(NPM, owner, uf.target, weth.target, ethers.ZeroAddress);
    const router = await uni(ROUTER, owner, ethers.ZeroAddress, uf.target, npm.target, weth.target);
    const quoter = await uni(QUOTER, owner, uf.target, weth.target); // QuoterV2(factory, WETH9)
    const locker = await deploy('LaunchLocker', npm.target, platform.address, 2500);
    const curve = await deploy('CensusCurve', npm.target, platform.address, locker.target, weth.target, router.target);
    await locker.initFactory(curve.target);
    const factory = await deploy('LaunchFactory', weth.target, curve.target);
    await curve.setFactory(factory.target, true);

    const params = ['Impact', 'IMP', E('1000000000'), 18, 10000, E('1.5'), E('4')];
    const rc = await (await factory.connect(creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32)'](params, ethers.ZeroHash)).wait();
    const coin = rc.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(e => e && e.name === 'Launched').args.token;

    await network.provider.send('hardhat_mine', ['0x65']);
    await curve.connect(buyer).buyWithETH(coin, 0, { value: E('5') }); // fill and
    const grad = await (await curve.graduate(coin)).wait();             // graduate into a shallow ~4 ETH pool
    const pool = grad.logs.map(l => { try { return curve.interface.parseLog(l); } catch { return null; } }).find(e => e && e.name === 'Graduated').args.pool;
    const poolC = new ethers.Contract(pool, POOL.abi, owner);

    // A normal buy: 0.5 WETH -> coin on the fresh pool.
    const amountIn = E('0.5');
    const FEE = 10000;

    // (a) The impact-free linear estimate — exactly the old poolSpotOut math.
    const slot0 = await poolC.slot0();
    const t0 = (await poolC.token0()).toLowerCase();
    const raw = (Number(slot0.sqrtPriceX96) / 2 ** 96) ** 2;           // token1/token0
    const rate = weth.target.toLowerCase() === t0 ? raw : 1 / raw;      // coin(out) per WETH(in)
    const linearOut = Number(amountIn) * rate * (1 - FEE / 1e6);        // float, coin base units

    // (b) The real, price-impact-aware quote from QuoterV2 (static call).
    const quoterOut = (await quoter.quoteExactInputSingle.staticCall({ tokenIn: weth.target, tokenOut: coin, amountIn, fee: FEE, sqrtPriceLimitX96: 0 }))[0];

    // The estimate overstates output, and by MORE than the 2% buffer — so a 2% minOut off the estimate
    // is unachievable (this is the revert bug).
    expect(Number(quoterOut)).to.be.lessThan(linearOut);
    expect(Number(quoterOut)).to.be.lessThan(linearOut * 0.98);

    // Fund the buyer and prove the two minOut regimes on the SAME trade.
    await weth.connect(buyer).deposit({ value: E('2') });
    await weth.connect(buyer).approve(router.target, ethers.MaxUint256);
    const doSwap = (minOut) => router.connect(buyer).exactInputSingle({ tokenIn: weth.target, tokenOut: coin, fee: FEE, recipient: buyer.address, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0 });

    const minOutLinear = BigInt(Math.floor(linearOut * 0.98)); // old behaviour
    const minOutQuoter = (quoterOut * 98n) / 100n;             // fixed behaviour
    await expect(doSwap(minOutLinear)).to.be.reverted;         // Neil's bug: healthy pool, trade still reverts
    const before = await (new ethers.Contract(coin, ['function balanceOf(address) view returns (uint256)'], owner)).balanceOf(buyer.address);
    await expect(doSwap(minOutQuoter)).not.to.be.reverted;     // the fix: quote includes impact, trade fills
    const after = await (new ethers.Contract(coin, ['function balanceOf(address) view returns (uint256)'], owner)).balanceOf(buyer.address);
    expect(after - before).to.be.gte(minOutQuoter);            // and delivers at least the quoted floor
  });
});
