// End-to-end V4 product: LaunchFactoryV4 -> CensusCurveV4 (2% base, 90/10 Census/creator, optional
// 1-4% reflection, 3-second anti-snipe) -> CensusV4Graduator/CensusV4Hook (permanent V4 pool, 30/70
// after graduation) -> CensusRewardVault (basket of quoted assets only: the pairing asset and/or
// allow-listed tokenised stocks, never the coin; reward-debt checkpoints; custody exclusions).
// Real Uniswap V4 PoolManager, local only.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { deploy, deployHook } = require('./helpers/v4');
const E = ethers.parseEther;
const BPS = 10000n;
const MIN = 4295128740n;
const MAX = 1461446703485210103287273052203988822378723970341n;
const SIG = 'createLaunch((string,string,uint256,uint8,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])';

const ev = (receipt, contract, name) => receipt.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === name);
const at = (ts) => network.provider.send('evm_setNextBlockTimestamp', [ts]);
const latest = async () => (await ethers.provider.getBlock('latest')).timestamp;
const jump = async (seconds) => at(await latest() + seconds); // past the 3-second window without pinning to a drifted launch time
const mulDiv = (a, b, c) => (a * b) / c;
// Mirror of CensusFeeMath.rates/calculate.
function rates(reflection, elapsed, penalized) {
  let penalty = 0n;
  if (penalized && elapsed < 3) {
    const raw = 9900n >> BigInt(Math.floor((elapsed * 14) / 3));
    const cap = 9900n - 200n - reflection;
    penalty = raw < cap ? raw : cap;
  }
  return { total: 200n + reflection + penalty, penalty };
}
function fees(gross, reflection, elapsed, penalized, graduated) {
  const r = rates(reflection, elapsed, penalized);
  const total = mulDiv(gross, r.total, BPS), holders = mulDiv(gross, reflection, BPS), penalty = mulDiv(gross, r.penalty, BPS);
  const shared = total - holders;
  const protocol = mulDiv(shared, graduated ? 3000n : 9000n, BPS);
  return { total, holders, penalty, protocol, creator: shared - protocol };
}

async function stack() {
  const [owner, treasury, creator, alice, bob, carol, dave, keeper, stranger] = await ethers.getSigners();
  const weth = await deploy('MockWETH');
  const v3Router = await deploy('MockSwapRouter');
  const stock = await deploy('MockERC20', 'NVIDIA', 'NVDA');
  const stock2 = await deploy('MockERC20', 'Apple', 'AAPL');
  for (const s of [stock, stock2]) await s.mint(v3Router.target, E('1000000'));
  const manager = await deploy('PoolManager', owner.address);
  const curve = await deploy('CensusCurveV4', treasury.address, weth.target, v3Router.target);
  const graduator = await deploy('CensusV4Graduator', manager.target, curve.target, treasury.address);
  const hook = await deployHook(manager.target, graduator.target, treasury.address);
  await graduator.setHook(hook.target);
  await curve.setGraduator(graduator.target);
  const v4Router = await deploy('CensusV4Router', manager.target, hook.target);
  const vaultDeployer = await deploy('CensusRewardVaultDeployer');
  const factory = await deploy('LaunchFactoryV4', weth.target, curve.target, v3Router.target, 3000, ethers.ZeroAddress, v4Router.target, vaultDeployer.target);
  await vaultDeployer.setLaunchFactory(factory.target);
  await curve.setFactory(factory.target, true);
  await curve.setKeeper(keeper.address);
  await curve.setRewardAssetAllowed(stock.target, true); // NVDA listed at deploy; AAPL is listed later in a test
  for (const a of [alice, bob, carol, dave, stranger]) {
    await weth.connect(a).deposit({ value: E('50') });
    await weth.connect(a).approve(curve.target, ethers.MaxUint256);
    await weth.connect(a).approve(v4Router.target, ethers.MaxUint256);
  }
  const params = () => ['Census V4', 'CV4', E('1000000000'), 18, E('1.5'), E('4')];
  async function launch({ reflection = 0, basket = [], weights = [], paths = [], quote = weth.target, exempt = [], salt = ethers.ZeroHash, p = params() } = {}) {
    const receipt = await (await factory.connect(creator)[SIG](p, basket, weights, paths, salt, quote, reflection, exempt)).wait();
    const e = ev(receipt, factory, 'LaunchedV4')[0].args;
    const token = await ethers.getContractAt('LaunchToken', e.token);
    const vault = e.vault === ethers.ZeroAddress ? null : await ethers.getContractAt('CensusRewardVault', e.vault);
    for (const a of [alice, bob, carol, dave, stranger]) { await token.connect(a).approve(curve.target, ethers.MaxUint256); await token.connect(a).approve(v4Router.target, ethers.MaxUint256); }
    return { token, vault, launchedAt: Number(await curve.launchedAt(e.token)), receipt, event: e };
  }
  const key = (token, quote = weth.target) => {
    const coin0 = BigInt(token) < BigInt(quote);
    return { coin0, key: { currency0: coin0 ? token : quote, currency1: coin0 ? quote : token, fee: 0, tickSpacing: 60, hooks: hook.target } };
  };
  const poolBuy = (token, actor, amountIn, quote = weth.target) => { const k = key(token, quote); return { key: k.key, zeroForOne: !k.coin0, amountIn, minOut: 1n, sqrtPriceLimitX96: k.coin0 ? MAX : MIN, recipient: actor.address, deadline: ethers.MaxUint256 }; };
  const poolSell = (token, actor, amountIn, quote = weth.target) => { const k = key(token, quote); return { key: k.key, zeroForOne: k.coin0, amountIn, minOut: 1n, sqrtPriceLimitX96: k.coin0 ? MIN : MAX, recipient: actor.address, deadline: ethers.MaxUint256 }; };
  return { owner, treasury, creator, alice, bob, carol, dave, keeper, stranger, weth, v3Router, stock, stock2, manager, curve, graduator, hook, v4Router, vaultDeployer, factory, launch, params, key, poolBuy, poolSell };
}

async function balances(asset, addresses) { return Promise.all(addresses.map((a) => asset.balanceOf(typeof a === 'string' ? a : a.address ?? a.target))); }

describe('V4 product lifecycle (factory -> curve -> V4 pool -> rewards)', function () {
  this.timeout(600000);

  it('meme launch: 2% base fee split 90/10 on the curve, capped final fill with refund, V4 graduation, 30/70 after', async () => {
    const s = await stack();
    const { token, vault } = await s.launch();
    expect(vault).to.equal(null);
    const c = await s.curve.curves(token.target);
    expect(c.reflectionBps).to.equal(0); expect(c.quote).to.equal(s.weth.target); expect(c.creator).to.equal(s.creator.address);
    expect(await token.totalSupply()).to.equal(E('1000000000'));
    expect(await token.balanceOf(s.curve.target)).to.equal(E('1000000000')); // the whole real supply seeds the curve
    await jump(10);

    // Buy: fee 2% of gross, 90% Census / 10% creator, penalty 0 after the window.
    const before = await balances(s.weth, [s.treasury, s.creator]);
    let rc = await (await s.curve.connect(s.alice).buyWithETH(token.target, 0, { value: E('1') })).wait();
    let f = fees(E('1'), 0n, 10, true, false);
    expect(f.total).to.equal(E('0.02')); expect(f.protocol).to.equal(E('0.018')); expect(f.creator).to.equal(E('0.002'));
    let alloc = ev(rc, s.curve, 'FeeAllocated')[0].args;
    expect([alloc.protocolFee, alloc.creatorFee, alloc.holderFee, alloc.penalty]).to.deep.equal([f.protocol, f.creator, 0n, 0n]);
    expect(ev(rc, s.curve, 'Traded')[0].args.fee).to.equal(f.total);
    let after = await balances(s.weth, [s.treasury, s.creator]);
    expect(after[0] - before[0]).to.equal(f.protocol); expect(after[1] - before[1]).to.equal(f.creator);
    expect(ev(rc, s.curve, 'SnipeTaxCharged')).to.have.length(0);

    // Sell: 2% of gross proceeds, same split.
    const held = await token.balanceOf(s.alice.address);
    const quoted = await s.curve.quoteSell(token.target, held / 2n);
    const wethBefore = await s.weth.balanceOf(s.alice.address);
    rc = await (await s.curve.connect(s.alice).sell(token.target, held / 2n, quoted)).wait();
    const sold = ev(rc, s.curve, 'Traded')[0].args;
    expect(sold.isBuy).to.equal(false); expect(sold.amountOut).to.equal(quoted);
    expect(await s.weth.balanceOf(s.alice.address) - wethBefore).to.equal(quoted);
    alloc = ev(rc, s.curve, 'FeeAllocated')[0].args;
    expect(alloc.protocolFee + alloc.creatorFee).to.equal(sold.fee);
    expect(alloc.protocolFee).to.equal(mulDiv(sold.fee, 9000n, BPS));

    // Capped final fill: the gross that nets exactly the remaining reserve; the excess ETH is refunded.
    const preFill = await s.curve.curves(token.target);
    const maximum = await s.curve.maxQuoteInFor(token.target, s.bob.address);
    const ethBefore = await ethers.provider.getBalance(s.bob.address);
    rc = await (await s.curve.connect(s.bob).buyWithETH(token.target, 0, { value: E('10') })).wait();
    const refund = ev(rc, s.curve, 'BuyRefunded')[0].args;
    expect(refund.amount).to.equal(E('10') - maximum); expect(refund.nativeRefund).to.equal(true);
    expect(ethBefore - await ethers.provider.getBalance(s.bob.address) - rc.gasUsed * rc.gasPrice).to.equal(maximum);
    // The filling buy graduates the coin in the SAME transaction (automatic — no button, no keeper call):
    // everything moves into the hooked V4 pool; dust returns to the curve.
    const filled = await s.curve.curves(token.target);
    expect(filled.graduated).to.equal(true);
    expect(await s.curve.graduationProgress(token.target)).to.equal(BPS);
    const reserveTokens = preFill.tokenReserve - ev(rc, s.curve, 'Traded')[0].args.amountOut, reserveQuote = preFill.graduationQuote;
    const g = ev(rc, s.curve, 'Graduated')[0].args;
    expect(ev(rc, s.curve, 'GraduationDeferred')).to.have.length(0);
    // Buy + pool seeding must fit under GRADUATION_GAS_FLOOR (1.5M, 63/64 forwarded) with margin.
    expect(rc.gasUsed).to.be.lt(1_400_000n);
    expect(g.liquidity).to.be.gt(0n);
    expect(await s.curve.poolIds(token.target)).to.equal(g.poolId);
    expect(await s.graduator.poolIds(token.target)).to.equal(g.poolId);
    expect(g.tokensIn).to.be.gte(reserveTokens - reserveTokens / 10000n); expect(g.quoteIn).to.be.gte(reserveQuote - reserveQuote / 10000n);
    expect(await token.balanceOf(s.manager.target)).to.equal(g.tokensIn);
    expect(await s.weth.balanceOf(s.manager.target)).to.equal(g.quoteIn);
    expect(await token.balanceOf(s.curve.target)).to.equal(await s.curve.migrationTokenDust(token.target));
    expect(await s.weth.balanceOf(s.curve.target)).to.equal(await s.curve.migrationQuoteDust(token.target));
    expect(await token.balanceOf(s.graduator.target)).to.equal(0n); expect(await s.weth.balanceOf(s.graduator.target)).to.equal(0n);
    await expect(s.curve.connect(s.stranger).graduate(token.target)).to.be.revertedWithCustomError(s.curve, 'AlreadyGraduated');
    await expect(s.curve.connect(s.carol).buy(token.target, E('1'), 0)).to.be.revertedWithCustomError(s.curve, 'AlreadyGraduated');
    await expect(s.curve.connect(s.alice).sell(token.target, 1n, 0)).to.be.revertedWithCustomError(s.curve, 'AlreadyGraduated');
    // Nobody can remove the liquidity: the graduator has no such function.
    expect(s.graduator.interface.fragments.filter((x) => x.type === 'function' && /remove|withdraw|burn|collect/i.test(x.name))).to.have.length(0);

    // After graduation: same 2% base, now 30% Census / 70% creator, charged by the hook on every router.
    rc = await (await s.v4Router.connect(s.carol).swapExactInput(s.poolBuy(token.target, s.carol, E('0.1')))).wait();
    const accrued = ev(rc, s.hook, 'FeeAccrued')[0].args;
    expect(accrued.protocolFee).to.equal(E('0.0006')); expect(accrued.creatorFee).to.equal(E('0.0014')); expect(accrued.holderFee).to.equal(0n);
    expect(await s.hook.claimable(s.weth.target, s.treasury.address)).to.equal(E('0.0006'));
    expect(await s.hook.claimable(s.weth.target, s.creator.address)).to.equal(E('0.0014'));
    const carolCoins = await token.balanceOf(s.carol.address);
    rc = await (await s.v4Router.connect(s.carol).swapExactInput(s.poolSell(token.target, s.carol, carolCoins))).wait();
    const sellAcc = ev(rc, s.hook, 'FeeAccrued')[0].args;
    expect(sellAcc.buy).to.equal(false);
    expect(sellAcc.protocolFee + sellAcc.creatorFee).to.equal(mulDiv(sellAcc.quoteVolume, 200n, BPS));
    expect(sellAcc.protocolFee).to.equal(mulDiv(sellAcc.quoteVolume * 200n / BPS, 3000n, BPS));
    const tBefore = await s.weth.balanceOf(s.treasury.address);
    await s.hook.connect(s.stranger).claimFor(s.weth.target, s.treasury.address);
    expect(await s.weth.balanceOf(s.treasury.address) - tBefore).to.equal(E('0.0006') + sellAcc.protocolFee);
    expect(await s.weth.balanceOf(s.hook.target)).to.equal(await s.hook.totalReserved(s.weth.target));

    // Conservation: the 1B supply is fully accounted for; no dead surplus anywhere.
    const holders = [s.alice, s.bob, s.carol, s.manager, s.curve, s.hook, s.v4Router, s.graduator, s.treasury, s.creator];
    let sum = 0n; for (const b of await balances(token, holders)) sum += b;
    expect(sum).to.equal(await token.totalSupply());
  });

  it('launch window: 99% at the launch second, decay at +1s/+2s/+3s with reflection on top and the 90/10 split, creator and bundle exempt', async () => {
    const s = await stack();
    // Same-block launch + buy: predict the token (plain CREATE from the factory) and mine both together.
    const predicted = ethers.getCreateAddress({ from: s.factory.target, nonce: await ethers.provider.getTransactionCount(s.factory.target) });
    await network.provider.send('evm_setAutomine', [false]);
    let launchTx, buyTx;
    try {
      launchTx = await s.factory.connect(s.creator)[SIG](s.params(), [s.weth.target], [10000], ['0x'], ethers.ZeroHash, s.weth.target, 300, [s.bob.address], { gasLimit: 8000000 });
      buyTx = await s.curve.connect(s.alice).buy(predicted, E('1'), 0, { gasLimit: 1000000 });
      await network.provider.send('evm_mine');
    } finally { await network.provider.send('evm_setAutomine', [true]); }
    const launchRc = await launchTx.wait(), buyRc = await buyTx.wait();
    expect(launchRc.blockNumber).to.equal(buyRc.blockNumber);
    const token = await ethers.getContractAt('LaunchToken', ev(launchRc, s.factory, 'LaunchedV4')[0].args.token);
    expect(token.target).to.equal(predicted);
    const vault = ev(launchRc, s.factory, 'LaunchedV4')[0].args.vault;
    const launchedAt = Number(await s.curve.launchedAt(token.target));
    let f = fees(E('1'), 300n, 0, true, false);
    expect(f.total).to.equal(E('0.99')); // capped at 99% including the 3% reflection
    let alloc = ev(buyRc, s.curve, 'FeeAllocated')[0].args;
    expect([alloc.protocolFee, alloc.creatorFee, alloc.holderFee, alloc.penalty]).to.deep.equal([f.protocol, f.creator, f.holders, f.penalty]);
    expect(alloc.holderFee).to.equal(E('0.03'));
    expect(ev(buyRc, s.curve, 'SnipeTaxCharged')[0].args.amount).to.equal(f.penalty);
    expect(await s.weth.balanceOf(vault)).to.equal(f.holders);

    const expectedTotals = [1118n, 519n, 500n]; // 200 + 300 + (618 | 19 | 0)
    for (let second = 1; second <= 3; second++) {
      await at(launchedAt + second);
      const rc = await (await s.curve.connect(s.carol).buy(token.target, E('0.5'), 0)).wait();
      f = fees(E('0.5'), 300n, second, true, false);
      expect(rates(300n, second, true).total).to.equal(expectedTotals[second - 1]);
      const t = ev(rc, s.curve, 'Traded')[0].args, al = ev(rc, s.curve, 'FeeAllocated')[0].args;
      expect(t.fee).to.equal(f.total);
      expect([al.protocolFee, al.creatorFee, al.holderFee, al.penalty]).to.deep.equal([f.protocol, f.creator, f.holders, f.penalty]);
      expect(al.protocolFee).to.equal(mulDiv(f.total - f.holders, 9000n, BPS));
    }
    // Views agree with the executed rates (read at +4s, after the window: base + reflection only).
    await at(launchedAt + 4); await network.provider.send('evm_mine');
    expect(await s.curve.buyFeeBps(token.target, s.carol.address)).to.equal(500n);
    expect(await s.curve.sellFeeBps(token.target)).to.equal(500n);
    expect(await s.curve.currentSnipeTaxBps(token.target, s.carol.address)).to.equal(0n);
    // Creator and bundle wallet were exempt from the penalty from the first second.
    expect(await s.curve.snipeTaxExempt(token.target, s.creator.address)).to.equal(true);
    expect(await s.curve.snipeTaxExempt(token.target, s.bob.address)).to.equal(true);
    expect(await s.curve.snipeTaxExempt(token.target, s.carol.address)).to.equal(false);
  });

  it('company launch with 3% reflection: basket of quoted assets (pairing asset + stock), checkpoints, custody exclusions, claims before and after V4 graduation', async () => {
    const s = await stack();
    const { token, vault } = await s.launch({ reflection: 300, basket: [s.weth.target, s.stock.target], weights: [4000, 6000], paths: ['0x', '0x'] });
    expect(vault).to.not.equal(null);
    expect(await vault.basketLength()).to.equal(2n);
    expect(await vault.basket(0)).to.equal(s.weth.target);
    expect(await vault.basket(1)).to.equal(s.stock.target);
    expect(await vault.token()).to.equal(token.target);
    expect(await token.dividendVault()).to.equal(vault.target);
    for (const custody of [s.curve.target, s.factory.target, s.manager.target, s.hook.target, s.v4Router.target, s.graduator.target, vault.target]) expect(await vault.excluded(custody)).to.equal(true);
    // The vault has no way to buy, sell or convert the coin: rewards are always quoted assets.
    expect(vault.interface.fragments.some((x) => x.type === 'function' && /^(convert|buy|sell|swapExact)/i.test(x.name))).to.equal(false);
    await jump(10);

    // Fees: 2% base (90/10) + 3% reflection to the vault.
    let rc = await (await s.curve.connect(s.alice).buy(token.target, E('1'), 0)).wait();
    let f = fees(E('1'), 300n, 10, true, false);
    let al = ev(rc, s.curve, 'FeeAllocated')[0].args;
    expect([al.protocolFee, al.creatorFee, al.holderFee]).to.deep.equal([E('0.018'), E('0.002'), E('0.03')]);
    expect(await s.weth.balanceOf(vault.target)).to.equal(f.holders);
    await s.curve.connect(s.bob).buy(token.target, E('0.5'), 0);
    // Bob hands a third of his coins to Carol before any distribution: all three earn from now on.
    const bobBal = await token.balanceOf(s.bob.address);
    await token.connect(s.bob).transfer(s.carol.address, bobBal / 3n);

    // Eligible supply excludes the curve inventory and every custody address.
    const elig = await vault.eligibleSupply();
    const [a0, b0, c0] = await balances(token, [s.alice, s.bob, s.carol]);
    expect(elig).to.equal(a0 + b0 + c0);

    // Keeper distributes: the pairing-asset share is credited as-is, the stock share is routed through V3.
    const available = await vault.availableQuote();
    expect(available).to.be.gt(0n);
    await expect(vault.connect(s.stranger).distribute([0, 1])).to.be.revertedWithCustomError(vault, 'NotOperator');
    // F1 (security checklist 2026-09-23): the creator is NOT an operator — a caller-chosen minOut (and, on the
    // 0x path, caller calldata) would let them route the undistributed quote to themselves. Keeper only.
    expect(await vault.operator()).to.equal(s.keeper.address);
    await expect(vault.connect(s.creator).distribute([0, 1])).to.be.revertedWithCustomError(vault, 'NotOperator');
    await expect(vault.connect(s.creator).distributeVia0x([0, 0], ['0x', '0x'], [0, 1])).to.be.revertedWithCustomError(vault, 'NotOperator');
    expect(vault.interface.fragments.some((f) => f.type === 'function' && f.name === 'setOperator')).to.equal(false); // no delegation path exists
    await expect(vault.connect(s.keeper).distribute([0, 0])).to.be.revertedWithCustomError(vault, 'MinOut'); // a routed asset needs a real minimum
    rc = await (await vault.connect(s.keeper).distribute([0, 1])).wait();
    const reservedQuote = await vault.reserved(s.weth.target), reservedStock = await vault.reserved(s.stock.target);
    expect(reservedQuote).to.equal(mulDiv(available, 4000n, BPS)); expect(reservedStock).to.equal(mulDiv(available, 6000n, BPS));
    expect(await vault.availableQuote()).to.equal(0n);
    expect(await token.balanceOf(vault.target)).to.equal(0n); // the vault never holds the coin
    // Pro-rata by balance held at distribution time; the per-share accumulator carries 18 decimals so a
    // payout rounds down by at most balance/1e18 wei.
    for (const [who, bal] of [[s.alice, a0], [s.bob, b0], [s.carol, c0]]) {
      for (const [asset, total] of [[s.weth, reservedQuote], [s.stock, reservedStock]]) {
        expect(await vault.withdrawableOf(who.address, asset.target)).to.be.closeTo(mulDiv(total, bal, elig), bal / 10n ** 18n + 1n);
      }
    }
    // A buyer AFTER the distribution earns nothing from it (checkpoint), while the seller keeps hers.
    await s.curve.connect(s.dave).buy(token.target, E('0.2'), 0);
    expect(await vault.withdrawableOf(s.dave.address, s.stock.target)).to.equal(0n);
    const aliceOwedStock = await vault.withdrawableOf(s.alice.address, s.stock.target);
    await token.connect(s.alice).transfer(s.dave.address, a0 / 2n);
    expect(await vault.withdrawableOf(s.alice.address, s.stock.target)).to.equal(aliceOwedStock);
    expect(await vault.withdrawableOf(s.dave.address, s.stock.target)).to.equal(0n);
    // Claims pay each asset; a second claim pays nothing; the vault stays solvent for every reserve.
    const owed = await Promise.all([s.weth, s.stock].map((x) => vault.withdrawableOf(s.alice.address, x.target)));
    const preW = await s.weth.balanceOf(s.alice.address); const preS = await s.stock.balanceOf(s.alice.address);
    rc = await (await vault.connect(s.alice).claim()).wait();
    expect(ev(rc, vault, 'Claimed')).to.have.length(2);
    expect(await s.weth.balanceOf(s.alice.address) - preW).to.equal(owed[0]);
    expect(await s.stock.balanceOf(s.alice.address) - preS).to.equal(owed[1]);
    rc = await (await vault.connect(s.alice).claim()).wait();
    expect(ev(rc, vault, 'Claimed')).to.have.length(0);
    for (const x of [s.weth, s.stock]) expect(await x.balanceOf(vault.target)).to.be.gte(await vault.reserved(x.target));

    // Fill the curve and graduate; the PoolManager's balance is excluded from eligible supply.
    await s.curve.connect(s.stranger).buyWithETH(token.target, 0, { value: E('10') }); // fills and auto-graduates
    const managerBal = await token.balanceOf(s.manager.target);
    expect(managerBal).to.be.gt(E('100000000'));
    const excludedSum = (await balances(token, [s.curve, s.factory, s.manager, s.hook, s.v4Router, s.graduator, vault, '0x000000000000000000000000000000000000dEaD'])).reduce((a, b) => a + b, 0n);
    expect(await vault.eligibleSupply()).to.equal(await token.totalSupply() - excludedSum);

    // Post-graduation: the hook accrues 30/70 + 3% reflection; keeper pulls the vault's share and distributes again.
    rc = await (await s.v4Router.connect(s.bob).swapExactInput(s.poolBuy(token.target, s.bob, E('1')))).wait();
    const acc = ev(rc, s.hook, 'FeeAccrued')[0].args;
    expect([acc.protocolFee, acc.creatorFee, acc.holderFee]).to.deep.equal([E('0.006'), E('0.014'), E('0.03')]);
    expect(await s.hook.claimable(s.weth.target, vault.target)).to.equal(E('0.03'));
    await s.hook.connect(s.keeper).claimFor(s.weth.target, vault.target);
    expect(await s.hook.claimable(s.weth.target, vault.target)).to.equal(0n);
    // Undistributed quote = the 0.03 pulled from the hook plus the reflection the capped final fill paid before graduation.
    const available2 = await vault.availableQuote();
    expect(available2).to.be.gte(E('0.03'));
    const stockBefore = await vault.reserved(s.stock.target);
    await vault.connect(s.keeper).distribute([0, 1]);
    expect(await vault.reserved(s.stock.target) - stockBefore).to.equal(mulDiv(available2, 6000n, BPS)); // mock router pays 1:1
    expect(await vault.availableQuote()).to.equal(0n);
    expect(await s.weth.balanceOf(s.hook.target)).to.equal(await s.hook.totalReserved(s.weth.target));
  });

  it('reward assets: any coin is rejected, unlisted stocks are rejected, a stock listed later on-chain works without any redeploy', async () => {
    const s = await stack();
    const bad = (basket, weights, paths) => s.factory.connect(s.creator)[SIG](s.params(), basket, weights, paths, ethers.ZeroHash, s.weth.target, 200, []);
    // A launch's own token cannot be named (its address does not exist before deployment) and no other
    // coin can be either: only the quote and allow-listed stocks pass the factory.
    const { token: earlier } = await s.launch();
    await expect(bad([earlier.target], [10000], ['0x'])).to.be.revertedWithCustomError(s.factory, 'AssetNotAllowed').withArgs(earlier.target);
    await expect(bad([s.weth.target, s.stock2.target], [5000, 5000], ['0x', '0x'])).to.be.revertedWithCustomError(s.factory, 'AssetNotAllowed').withArgs(s.stock2.target);
    await expect(s.curve.connect(s.stranger).setRewardAssetAllowed(s.stock2.target, true)).to.be.revertedWithCustomError(s.curve, 'NotDeployer');
    await expect(s.curve.setRewardAssetAllowed(s.stranger.address, true)).to.be.revertedWithCustomError(s.curve, 'BadParams'); // must be a contract
    // Deployer lists AAPL: the same immutable contracts now accept it, and existing launches are untouched.
    await expect(s.curve.setRewardAssetAllowed(s.stock2.target, true)).to.emit(s.curve, 'RewardAssetAllowed').withArgs(s.stock2.target, true);
    const { token, vault } = await s.launch({ reflection: 200, basket: [s.weth.target, s.stock.target, s.stock2.target], weights: [2000, 3000, 5000], paths: ['0x', '0x', '0x'] });
    expect(await vault.basket(2)).to.equal(s.stock2.target);
    // Delisting only affects NEW launches: the frozen basket keeps paying AAPL.
    await s.curve.setRewardAssetAllowed(s.stock2.target, false);
    await expect(bad([s.stock2.target], [10000], ['0x'])).to.be.revertedWithCustomError(s.factory, 'AssetNotAllowed');
    await jump(10);
    await s.curve.connect(s.alice).buy(token.target, E('1'), 0);
    await vault.connect(s.keeper).distribute([0, 1, 1]);
    expect(await vault.reserved(s.stock2.target)).to.be.gt(0n);
    expect(await vault.withdrawableOf(s.alice.address, s.stock2.target)).to.be.gt(0n);
    // A vault can never be built with its coin as a reward, even by the factory (constructor guard).
    await expect(deploy('CensusRewardVault', s.weth.target, s.v3Router.target, 3000, [s.stock.target], [10000], ['0x'], ethers.ZeroAddress, s.stock.target, s.curve.target)).to.be.reverted;
  });

  it('rehearsal-sized target: 0.02 ETH graduation with the production 1.5 ETH virtual reserve fills, auto-graduates and trades in the pool', async () => {
    // The mainnet rehearsal build (VITE_REHEARSAL_GRADUATION_ETH=0.02) keeps START_FDV_ETH = 1.5 and only
    // shrinks the target, so the exit-price / two-leg consumption maths must hold for that shape too.
    const s = await stack();
    const { token } = await s.launch({ p: ['Rehearsal', 'TST1', E('1000000000'), 18, E('1.5'), E('0.02')] });
    await jump(10);
    await s.curve.connect(s.alice).buyWithETH(token.target, 0, { value: E('0.005') });
    const rc = await (await s.curve.connect(s.bob).buyWithETH(token.target, 0, { value: E('0.1') })).wait(); // capped fill + refund
    expect(ev(rc, s.curve, 'GraduationDeferred')).to.have.length(0);
    const g = ev(rc, s.curve, 'Graduated')[0].args;
    expect(g.liquidity).to.be.gt(0n);
    expect(g.quoteIn).to.be.gte(E('0.02') - E('0.02') / 10000n);
    expect((await s.curve.curves(token.target)).graduated).to.equal(true);
    await s.v4Router.connect(s.carol).swapExactInput(s.poolBuy(token.target, s.carol, E('0.001')));
    expect(await token.balanceOf(s.carol.address)).to.be.gt(0n);
  });

  it('graduation is automatic in the filling buy; a rejected pool seeding defers (curve frozen) and the permissionless retry completes it', async () => {
    const s = await stack();
    const aq = await deploy('AuditQuote');
    await s.curve.setQuoteAllowed(aq.target, true);
    for (const a of [s.alice, s.bob, s.stranger]) { await aq.mint(a.address, E('100')); await aq.connect(a).approve(s.curve.target, ethers.MaxUint256); }
    const { token } = await s.launch({ quote: aq.target });
    await jump(10);
    await s.curve.connect(s.alice).buy(token.target, E('1'), 0);
    // Make the pool seeding fail: the graduator cannot receive the quote, so the V4 pull reverts.
    await aq.setBlocked(s.graduator.target);
    let rc = await (await s.curve.connect(s.bob).buy(token.target, E('10'), 0)).wait(); // the fill itself succeeds
    expect(ev(rc, s.curve, 'Graduated')).to.have.length(0);
    expect(ev(rc, s.curve, 'GraduationDeferred')).to.have.length(1);
    const c = await s.curve.curves(token.target);
    expect(c.graduated).to.equal(false); expect(c.realQuote).to.equal(c.graduationQuote);
    expect(await s.curve.graduationProgress(token.target)).to.equal(BPS);
    // Frozen: nobody can push the reserve back under the target, and nobody can buy more.
    await expect(s.curve.connect(s.alice).sell(token.target, 1n, 0)).to.be.revertedWithCustomError(s.curve, 'CurveFilled');
    await expect(s.curve.connect(s.stranger).buy(token.target, E('1'), 0)).to.be.revertedWithCustomError(s.curve, 'CurveFilled');
    await expect(s.curve.connect(s.stranger).graduate(token.target)).to.be.reverted; // still rejected
    await expect(s.curve.connect(s.stranger).graduateFromBuy(token.target)).to.be.revertedWithCustomError(s.curve, 'NotSelf');
    await aq.setBlocked(ethers.ZeroAddress);
    rc = await (await s.curve.connect(s.stranger).graduate(token.target)).wait(); // permissionless retry (the keeper does this)
    const g = ev(rc, s.curve, 'Graduated')[0].args;
    expect(g.liquidity).to.be.gt(0n);
    expect((await s.curve.curves(token.target)).graduated).to.equal(true);
    expect(await token.balanceOf(s.manager.target)).to.equal(g.tokensIn);
    await expect(s.curve.connect(s.stranger).graduate(token.target)).to.be.revertedWithCustomError(s.curve, 'AlreadyGraduated');
  });

  for (const orderQuoteFirst of [true, false]) it(`6-decimal quote with quote ${orderQuoteFirst ? 'below' : 'above'} the coin address: curve, graduation and V4 trades reconcile`, async () => {
    const s = await stack();
    const predicted = ethers.getCreateAddress({ from: s.factory.target, nonce: await ethers.provider.getTransactionCount(s.factory.target) });
    let quote;
    for (let i = 0; i < 40 && !quote; i++) {
      const q = await deploy('LaunchToken', 'USD Stable', 'USD6', 1000000n * 10n ** 6n, 6, s.owner.address);
      if ((BigInt(q.target) < BigInt(predicted)) === orderQuoteFirst) quote = q;
    }
    await s.curve.setQuoteAllowed(quote.target, true);
    for (const a of [s.alice, s.bob]) { await quote.transfer(a.address, 100000n * 10n ** 6n); await quote.connect(a).approve(s.curve.target, ethers.MaxUint256); await quote.connect(a).approve(s.v4Router.target, ethers.MaxUint256); }
    const { token } = await s.launch({ reflection: 100, basket: [quote.target], weights: [10000], paths: ['0x'], quote: quote.target, p: ['Six', 'SIX', E('1000000000'), 18, 1500000n, 4000000n] });
    expect(token.target).to.equal(predicted);
    await jump(10);
    await s.curve.connect(s.alice).buy(token.target, 1000000n, 0);
    const held = await token.balanceOf(s.alice.address);
    await s.curve.connect(s.alice).sell(token.target, held / 4n, 0);
    const rc = await (await s.curve.connect(s.bob).buy(token.target, 10000000n, 0)).wait(); // fills and auto-graduates
    const c = await s.curve.curves(token.target);
    expect(c.graduated).to.equal(true);
    const g = ev(rc, s.curve, 'Graduated')[0].args;
    expect(g.quoteIn).to.be.gte(4000000n - 400n);
    expect(await token.balanceOf(s.manager.target)).to.be.gt(E('100000000'));
    const out = await s.v4Router.connect(s.bob).swapExactInput.staticCall(s.poolBuy(token.target, s.bob, 100000n, quote.target));
    await s.v4Router.connect(s.bob).swapExactInput({ ...s.poolBuy(token.target, s.bob, 100000n, quote.target), minOut: out });
    await s.v4Router.connect(s.bob).swapExactInput(s.poolSell(token.target, s.bob, out, quote.target));
    expect(await quote.balanceOf(s.hook.target)).to.equal(await s.hook.totalReserved(quote.target));
    expect(await s.hook.claimable(quote.target, s.treasury.address)).to.be.gt(0n);
  });

  it('rejects bad launches and unauthorised access: reflection range, basket shape, foreign factory, unwired curve, hook re-initialisation', async () => {
    const s = await stack();
    const bad = (args) => s.factory.connect(s.creator)[SIG](s.params(), ...args);
    await expect(bad([[s.weth.target], [10000], ['0x'], ethers.ZeroHash, s.weth.target, 50, []])).to.be.revertedWithCustomError(s.curve, 'InvalidReflection');
    await expect(bad([[s.weth.target], [10000], ['0x'], ethers.ZeroHash, s.weth.target, 401, []])).to.be.revertedWithCustomError(s.curve, 'InvalidReflection');
    await expect(bad([[], [], [], ethers.ZeroHash, s.weth.target, 200, []])).to.be.revertedWithCustomError(s.factory, 'BadBasket');
    await expect(bad([[s.weth.target], [10000], ['0x'], ethers.ZeroHash, s.weth.target, 0, []])).to.be.revertedWithCustomError(s.factory, 'BadBasket');
    await s.curve.setRewardAssetAllowed(s.stock2.target, true);
    await expect(bad([[s.weth.target, s.stock.target, s.stock2.target, s.v3Router.target], [2500, 2500, 2500, 2500], ['0x', '0x', '0x', '0x'], ethers.ZeroHash, s.weth.target, 200, []])).to.be.reverted; // > 3 assets / unlisted
    await expect(bad([[s.weth.target, s.stock.target], [6000, 3000], ['0x', '0x'], ethers.ZeroHash, s.weth.target, 200, []])).to.be.reverted; // weights != 10000
    await expect(bad([[s.stock.target, s.stock.target], [5000, 5000], ['0x', '0x'], ethers.ZeroHash, s.weth.target, 200, []])).to.be.reverted; // duplicate
    await expect(bad([[s.weth.target], [10000], ['0x1234'], ethers.ZeroHash, s.weth.target, 200, []])).to.be.reverted; // the quote entry is never routed
    await expect(bad([[], [], [], ethers.ZeroHash, s.stock.target, 0, []])).to.be.revertedWithCustomError(s.curve, 'QuoteNotSupported');
    await expect(s.curve.connect(s.stranger).register(s.stock.target, s.weth.target, s.stranger.address, ethers.ZeroAddress, 0, 1, 1, 1)).to.be.revertedWithCustomError(s.curve, 'NotFactory');
    await expect(s.curve.connect(s.stranger).setGraduator(s.graduator.target)).to.be.revertedWithCustomError(s.curve, 'NotDeployer');
    await expect(s.curve.setGraduator(s.graduator.target)).to.be.revertedWithCustomError(s.curve, 'AlreadyRegistered');
    // A curve without its graduator refuses registrations (never a launch that cannot graduate).
    const bare = await deploy('CensusCurveV4', s.treasury.address, s.weth.target, s.v3Router.target);
    await bare.setFactory(s.owner.address, true);
    await expect(bare.register(s.stock.target, s.weth.target, s.creator.address, ethers.ZeroAddress, 0, 1, 1, 1)).to.be.revertedWithCustomError(bare, 'NotConfigured');
    // Nobody can pre-initialise the canonical hooked pool for a live launch, and graduation still works.
    const { token, launchedAt } = await s.launch();
    const k = s.key(token.target).key;
    await expect(s.manager.connect(s.stranger).initialize(k, 2n ** 96n)).to.be.reverted;
    await jump(10);
    await s.curve.connect(s.bob).buyWithETH(token.target, 0, { value: E('10') }); // fills and auto-graduates
    await expect(s.manager.connect(s.stranger).initialize(k, 2n ** 96n)).to.be.reverted;
    await expect(s.graduator.connect(s.stranger).graduate({ coin: token.target, quote: s.weth.target, creator: s.creator.address, rewards: ethers.ZeroAddress, reflectionBps: 0, launchedAt, coinAmount: 1, quoteAmount: 1, sqrtPriceX96: 2n ** 96n })).to.be.revertedWithCustomError(s.graduator, 'Unauthorized');
  });

  it('500 mixed curve trades across 10 wallets keep every fee allocation exact and the curve solvent', async () => {
    const s = await stack();
    const signers = (await ethers.getSigners()).slice(9, 19);
    const { token, vault } = await s.launch({ reflection: 200, basket: [s.weth.target], weights: [10000], paths: ['0x'] });
    for (const a of signers) { await s.weth.connect(a).deposit({ value: E('5') }); await s.weth.connect(a).approve(s.curve.target, ethers.MaxUint256); await token.connect(a).approve(s.curve.target, ethers.MaxUint256); }
    await jump(10);
    const start = [await s.weth.balanceOf(s.treasury.address), await s.weth.balanceOf(s.creator.address), await s.weth.balanceOf(vault.target)];
    let expectedProtocol = 0n, expectedCreator = 0n, expectedHolders = 0n, trades = 0, maxGas = 0n;
    for (let i = 0; i < 500; i++) {
      const a = signers[i % 10];
      const holding = await token.balanceOf(a.address);
      const sell = holding > 0n && i % 3 === 2;
      const c = await s.curve.curves(token.target);
      if (!sell && c.realQuote >= c.graduationQuote) break;
      const rc = sell
        ? await (await s.curve.connect(a).sell(token.target, holding / 2n, 0)).wait()
        : await (await s.curve.connect(a).buy(token.target, E('0.001') * BigInt(1 + (i % 7)), 0)).wait();
      const t = ev(rc, s.curve, 'Traded')[0].args, al = ev(rc, s.curve, 'FeeAllocated')[0].args;
      const gross = sell ? t.amountOut + t.fee : t.amountIn;
      const f = fees(gross, 200n, 10, !sell, false);
      expect(t.fee).to.equal(f.total);
      expect([al.protocolFee, al.creatorFee, al.holderFee]).to.deep.equal([f.protocol, f.creator, f.holders]);
      expectedProtocol += f.protocol; expectedCreator += f.creator; expectedHolders += f.holders;
      if (rc.gasUsed > maxGas) maxGas = rc.gasUsed;
      trades++;
    }
    expect(trades).to.equal(500);
    expect(await s.weth.balanceOf(s.treasury.address) - start[0]).to.equal(expectedProtocol);
    expect(await s.weth.balanceOf(s.creator.address) - start[1]).to.equal(expectedCreator);
    expect(await s.weth.balanceOf(vault.target) - start[2]).to.equal(expectedHolders);
    const c = await s.curve.curves(token.target);
    expect(await s.weth.balanceOf(s.curve.target)).to.equal(c.realQuote); // every fee left the curve; reserves are exact
    expect(await token.balanceOf(s.curve.target)).to.equal(c.tokenReserve);
    console.log(`      curve trades=${trades} wallets=10 maxGas=${maxGas}`);
  });
});
