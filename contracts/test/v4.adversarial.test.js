// Adversarial V4 component cases added on the 2026-09-22 release-day pass. Component coverage only:
// the production curve/factory/reward integration does not exist yet, so nothing here proves the
// end-to-end V4 launch path.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deploy, deployHook, sqrt } = require('./helpers/v4');
const E = ethers.parseEther;
const MIN = 4295128740n;
const MAX = 1461446703485210103287273052203988822378723970341n;

async function fixture({ taxedQuote = false } = {}) {
  const [owner, creator, rewards, ...actors] = await ethers.getSigners();
  const manager = await deploy('PoolManager', owner.address);
  const graduator = await deploy('CensusV4Graduator', manager.target, owner.address, owner.address);
  const hook = await deployHook(manager.target, graduator.target, owner.address);
  await graduator.setHook(hook.target);
  const coin = await deploy('LaunchToken', 'Adversarial', 'ADV', E('1000000000'), 18, owner.address);
  const quote = taxedQuote ? await deploy('AuditQuote') : await deploy('LaunchToken', 'Quote', 'Q', E('1000000'), 18, owner.address);
  if (taxedQuote) await quote.mint(owner.address, E('1000000'));
  const coin0 = BigInt(coin.target) < BigInt(quote.target);
  const coinAmount = E('214285714'), quoteAmount = E('4');
  const amount0 = coin0 ? coinAmount : quoteAmount, amount1 = coin0 ? quoteAmount : coinAmount;
  const sqrtPriceX96 = sqrt((amount1 << 192n) / amount0);
  const key = { currency0: coin0 ? coin.target : quote.target, currency1: coin0 ? quote.target : coin.target, fee: 0, tickSpacing: 60, hooks: hook.target };
  await coin.approve(graduator.target, coinAmount);
  await quote.approve(graduator.target, quoteAmount);
  const now = (await ethers.provider.getBlock('latest')).timestamp;
  await graduator.graduate({ coin: coin.target, quote: quote.target, creator: creator.address, rewards: rewards.address, reflectionBps: 400, launchedAt: now - 10, coinAmount, quoteAmount, sqrtPriceX96 });
  const router = await deploy('CensusV4Router', manager.target, hook.target);
  for (const a of actors.slice(0, 3)) {
    await quote.transfer(a.address, E('10'));
    await coin.connect(a).approve(router.target, ethers.MaxUint256);
    await quote.connect(a).approve(router.target, ethers.MaxUint256);
  }
  const buy = (actor, amount = E('0.1')) => ({ key, zeroForOne: !coin0, amountIn: amount, minOut: 1n, sqrtPriceLimitX96: coin0 ? MAX : MIN, recipient: actor.address, deadline: ethers.MaxUint256 });
  const sell = (actor, amount) => ({ ...buy(actor), zeroForOne: coin0, amountIn: amount, sqrtPriceLimitX96: coin0 ? MIN : MAX });
  const snapshot = async (actor) => ({ q: await quote.balanceOf(actor.address), c: await coin.balanceOf(actor.address), reserved: await hook.totalReserved(quote.target), hookQ: await quote.balanceOf(hook.target) });
  return { owner, creator, rewards, actors, manager, graduator, hook, coin, quote, key, coin0, router, buy, sell, snapshot, sqrtPriceX96 };
}

describe('V4 adversarial: partial fills, repeated claims, dust, bypass disclosure, registration', function () {
  this.timeout(180000);

  it('rejects a price-limited partial buy and partial sell atomically: no fee accrues, no balance moves', async () => {
    const f = await fixture(); const a = f.actors[0];
    // A limit 0.5% away from the pool price cannot absorb a 2.5%-of-reserve buy: the manager fills
    // partially, the hook (fee charged on the full specified input) must refuse rather than overcharge.
    const before = await f.snapshot(a);
    const buyLimit = f.coin0 ? f.sqrtPriceX96 * 10025n / 10000n : f.sqrtPriceX96 * 9975n / 10000n;
    await expect(f.router.connect(a).swapExactInput({ ...f.buy(a), sqrtPriceLimitX96: buyLimit })).to.be.reverted;
    expect(await f.snapshot(a)).to.deep.equal(before);
    // Acquire coins normally, then attempt a sell whose limit forces a partial fill.
    await f.router.connect(a).swapExactInput(f.buy(a, E('0.05')));
    const held = await f.coin.balanceOf(a.address);
    const mid = await f.snapshot(a);
    // The sell walks the price back from its post-buy level toward the launch price; a limit 0.5% short of
    // the launch price sits inside that path, so the manager can only fill part of the order.
    const sellLimit = f.coin0 ? f.sqrtPriceX96 * 10050n / 10000n : f.sqrtPriceX96 * 9950n / 10000n;
    await expect(f.router.connect(a).swapExactInput({ ...f.sell(a, held), sqrtPriceLimitX96: sellLimit })).to.be.revertedWithCustomError(f.router, 'IncompleteFill');
    expect(await f.snapshot(a)).to.deep.equal(mid);
    // A zero-input request is refused outright.
    await expect(f.router.connect(a).swapExactInput({ ...f.buy(a), amountIn: 0n })).to.be.revertedWithCustomError(f.router, 'InvalidRequest');
  });

  it('pays a repeated claim nothing and keeps the reserve ledger exact; a 1 wei buy rounds the fee to zero without breaking custody', async () => {
    const f = await fixture(); const a = f.actors[0];
    await f.router.connect(a).swapExactInput(f.buy(a));
    const owed = await f.hook.claimable(f.quote.target, f.creator.address);
    expect(owed).to.be.gt(0);
    await f.hook.claimFor(f.quote.target, f.creator.address);
    const reservedAfter = await f.hook.totalReserved(f.quote.target);
    const balanceAfter = await f.quote.balanceOf(f.creator.address);
    await expect(f.hook.connect(a).claimFor(f.quote.target, f.creator.address)).to.emit(f.hook, 'FeesClaimed').withArgs(f.quote.target, f.creator.address, 0n);
    expect(await f.quote.balanceOf(f.creator.address)).to.equal(balanceAfter);
    expect(await f.hook.totalReserved(f.quote.target)).to.equal(reservedAfter);
    expect(await f.quote.balanceOf(f.hook.target)).to.equal(reservedAfter);
    // Dust: 1 wei of quote => fee 0 (integer floor). The pool still settles and the ledger stays solvent.
    const receipt = await (await f.router.connect(a).swapExactInput(f.buy(a, 1n))).wait();
    const fee = receipt.logs.map((l) => { try { return f.hook.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'FeeAccrued').args;
    expect(fee.protocolFee + fee.creatorFee + fee.holderFee).to.equal(0n);
    expect(await f.hook.totalReserved(f.quote.target)).to.equal(reservedAfter);
    expect(await f.quote.balanceOf(f.hook.target)).to.equal(reservedAfter);
  });

  it('DISCLOSURE: an independent hookless pool on the same manager trades the same pair with no Census fee', async () => {
    const f = await fixture(); const stranger = f.actors[2];
    const open = { ...f.key, fee: 3000, hooks: ethers.ZeroAddress };
    await f.manager.connect(stranger).initialize(open, f.sqrtPriceX96); // nobody can stop this
    const lp = await deploy('PoolModifyLiquidityTest', f.manager.target);
    const swapper = await deploy('PoolSwapTest', f.manager.target);
    await f.coin.transfer(stranger.address, E('1000000'));
    for (const t of [f.coin, f.quote]) { await t.connect(stranger).approve(lp.target, ethers.MaxUint256); await t.connect(stranger).approve(swapper.target, ethers.MaxUint256); }
    await lp.connect(stranger)['modifyLiquidity((address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)'](open, { tickLower: -887220, tickUpper: 887220, liquidityDelta: E('100'), salt: ethers.ZeroHash }, '0x');
    const reservedBefore = await f.hook.totalReserved(f.quote.target);
    const coinBefore = await f.coin.balanceOf(stranger.address);
    await swapper.connect(stranger).swap(open, { zeroForOne: !f.coin0, amountSpecified: -E('0.01'), sqrtPriceLimitX96: f.coin0 ? MAX : MIN }, { takeClaims: false, settleUsingBurn: false }, '0x');
    expect(await f.coin.balanceOf(stranger.address)).to.be.gt(coinBefore);
    expect(await f.hook.totalReserved(f.quote.target)).to.equal(reservedBefore); // zero Census fee: the bypass is real
    // The canonical pool cannot be re-initialized or shadowed under the hook by anyone else.
    await expect(f.manager.connect(stranger).initialize(f.key, f.sqrtPriceX96)).to.be.reverted;
    await expect(f.manager.connect(stranger).initialize({ ...f.key, tickSpacing: 10 }, f.sqrtPriceX96)).to.be.reverted;
  });

  it('refuses malformed or replayed registrations and a future launch timestamp', async () => {
    const [owner, creator, rewards, stranger] = await ethers.getSigners();
    const manager = await deploy('PoolManager', owner.address);
    const hook = await deployHook(manager.target, owner.address, owner.address);
    const a = await deploy('MockERC20', 'A', 'A'), b = await deploy('MockERC20', 'B', 'B');
    const [c0, c1] = [a, b].sort((x, y) => (BigInt(x.target) < BigInt(y.target) ? -1 : 1)).map((t) => t.target);
    const key = { currency0: c0, currency1: c1, fee: 0, tickSpacing: 60, hooks: hook.target };
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    await expect(hook.register({ ...key, fee: 3000 }, c0, creator.address, rewards.address, 100, now)).to.be.revertedWithCustomError(hook, 'InvalidPool');
    await expect(hook.register({ ...key, hooks: ethers.ZeroAddress }, c0, creator.address, rewards.address, 100, now)).to.be.revertedWithCustomError(hook, 'InvalidPool');
    await expect(hook.register(key, stranger.address, creator.address, rewards.address, 100, now)).to.be.revertedWithCustomError(hook, 'InvalidPool'); // quote not in the pair
    await expect(hook.register(key, c0, ethers.ZeroAddress, rewards.address, 100, now)).to.be.revertedWithCustomError(hook, 'InvalidPool');
    await expect(hook.register(key, c0, creator.address, ethers.ZeroAddress, 100, now)).to.be.revertedWithCustomError(hook, 'InvalidPool'); // reflection without a rewards sink
    await expect(hook.register(key, c0, creator.address, rewards.address, 100, now + 3600)).to.be.revertedWithCustomError(hook, 'InvalidPool'); // future launch
    await expect(hook.register(key, c0, creator.address, rewards.address, 50, now)).to.be.revertedWithCustomError(hook, 'InvalidReflection');
    await expect(hook.register(key, c0, creator.address, rewards.address, 401, now)).to.be.revertedWithCustomError(hook, 'InvalidReflection');
    await hook.register(key, c0, creator.address, ethers.ZeroAddress, 0, now); // disabled reflection needs no sink
    await expect(hook.register(key, c0, stranger.address, rewards.address, 0, now)).to.be.revertedWithCustomError(hook, 'InvalidPool'); // immutable once set
    await expect(hook.connect(stranger).register({ ...key, tickSpacing: 10 }, c0, creator.address, rewards.address, 0, now)).to.be.revertedWithCustomError(hook, 'Unauthorized');
  });

  it('reverts a sell whose quote output is taxed on transfer, leaving balances and the fee ledger untouched', async () => {
    const f = await fixture({ taxedQuote: true }); const a = f.actors[0];
    await f.router.connect(a).swapExactInput(f.buy(a, E('0.05')));
    const held = await f.coin.balanceOf(a.address);
    await f.quote.setTax(100);
    const before = await f.snapshot(a);
    await expect(f.router.connect(a).swapExactInput(f.sell(a, held))).to.be.reverted;
    expect(await f.snapshot(a)).to.deep.equal(before);
    await f.quote.setTax(0);
    await f.router.connect(a).swapExactInput(f.sell(a, held));
    expect(await f.coin.balanceOf(a.address)).to.equal(0n);
    expect(await f.quote.balanceOf(f.hook.target)).to.equal(await f.hook.totalReserved(f.quote.target));
  });
});
