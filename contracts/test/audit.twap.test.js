// AUDIT (2026-09-17), CX-H1: graduation must enable a price TWAP on the locked pool.
// A fresh Uniswap V3 pool has observationCardinality 1 (spot only), so the frontend had to read a
// one-block-manipulable slot0. graduate() now grows the oracle buffer to GRAD_OBS_CARDINALITY; this
// test proves the buffer grew and that observe() serves a real time-weighted average after a couple of
// swaps — i.e. the frontend can price/mcap and bound trades off a TWAP instead of spot.
// Uses the REAL Uniswap V3 contracts (v3-core/periphery/swap-router), local Hardhat only.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const E = ethers.parseEther;
const UF = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
const NPM = require('@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json');
const ROUTER = require('@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json');
const POOL = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json');

async function deploy(name, ...args) { const c = await (await ethers.getContractFactory(name)).deploy(...args); await c.waitForDeployment(); return c; }
async function uni(a, signer, ...args) { const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args); await c.waitForDeployment(); return c; }

describe('AUDIT CX-H1: graduation enables a pool price TWAP', function () {
  this.timeout(120000);
  it('grows the observation cardinality and observe() serves a TWAP after swaps', async () => {
    const [owner, platform, creator, buyer] = await ethers.getSigners();
    const weth = await deploy('WETH9');
    const uf = await uni(UF, owner);
    const npm = await uni(NPM, owner, uf.target, weth.target, ethers.ZeroAddress);
    const router = await uni(ROUTER, owner, ethers.ZeroAddress, uf.target, npm.target, weth.target);
    const locker = await deploy('LaunchLocker', npm.target, platform.address, 2500);
    const curve = await deploy('CensusCurve', npm.target, platform.address, locker.target, weth.target, router.target);
    await locker.initFactory(curve.target);
    const factory = await deploy('LaunchFactory', weth.target, curve.target);
    await curve.setFactory(factory.target, true);

    const params = ['Twap', 'TWP', E('1000000000'), 18, 10000, E('1.5'), E('4')];
    const rc = await (await factory.connect(creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32)'](params, ethers.ZeroHash)).wait();
    const token = rc.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(e => e && e.name === 'Launched').args.token;

    await network.provider.send('hardhat_mine', ['0x65']); // past the launch tax window
    await curve.connect(buyer).buyWithETH(token, 0, { value: E('5') }); // fill the curve
    const grad = await (await curve.graduate(token)).wait();
    const pool = grad.logs.map(l => { try { return curve.interface.parseLog(l); } catch { return null; } }).find(e => e && e.name === 'Graduated').args.pool;

    const poolC = new ethers.Contract(pool, POOL.abi, owner);
    const expected = Number(await curve.GRAD_OBS_CARDINALITY());

    // The buffer's NEXT cardinality is grown immediately; the ACTIVE cardinality fills as swaps write
    // observations in later blocks.
    let slot0 = await poolC.slot0();
    expect(Number(slot0.observationCardinalityNext)).to.equal(expected); // enabling change worked
    expect(expected).to.be.greaterThan(1);

    // Trade on the pool across time so the oracle records observations, then read a TWAP.
    const tokenC = await ethers.getContractAt('LaunchToken', token);
    await weth.connect(buyer).deposit({ value: E('2') });
    await weth.connect(buyer).approve(router.target, ethers.MaxUint256);
    await tokenC.connect(buyer).approve(router.target, ethers.MaxUint256);
    const swap = async (tokenIn, tokenOut, amt) => router.connect(buyer).exactInputSingle({ tokenIn, tokenOut, fee: 10000, recipient: buyer.address, amountIn: amt, amountOutMinimum: 0, sqrtPriceLimitX96: 0 });
    for (let i = 0; i < 3; i++) {
      await network.provider.send('evm_increaseTime', [20]);
      await (await swap(weth.target, token, E('0.2'))).wait();
    }
    await network.provider.send('evm_increaseTime', [20]);
    await network.provider.send('evm_mine');

    // A 30-second TWAP must now be serveable (would revert 'OLD' on an ungrown, cardinality-1 pool).
    const [tickCumulatives] = await poolC.observe([30, 0]);
    const twapTick = Number((tickCumulatives[1] - tickCumulatives[0]) / 30n);
    const spotTick = Number((await poolC.slot0()).tick);
    expect(Number.isFinite(twapTick)).to.equal(true);
    // TWAP and spot are close in a quiet market but the TWAP is a distinct, averaged value — proving the
    // frontend now has a manipulation-resistant reference instead of only slot0.
    expect(Math.abs(twapTick - spotTick)).to.be.lessThan(2000);
  });
});
