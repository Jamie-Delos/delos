// Graduation recovery: an adversarially pre-initialized pool must not block migration (bounded,
// price-limited recovery swap), and launch-token LP fees must be convertible into holder rewards.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const E = ethers.parseEther;
const UF = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
const NPM = require('@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json');
const ROUTER = require('@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json');
async function deploy(name, ...args) { const c = await (await ethers.getContractFactory(name)).deploy(...args); await c.waitForDeployment(); return c; }
async function uni(artifact, signer, ...args) { const c = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args); await c.waitForDeployment(); return c; }
function event(receipt, contract, name) { return receipt.logs.map(l => { try { return contract.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === name); }
function sqrt(n) { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n/x)/2n; } return x; }

async function setup(threshold = '4', holderShare = 10000) {
  const [owner, platform, creator, buyer, attacker, ...users] = await ethers.getSigners();
  const weth = await deploy('WETH9'); const uf = await uni(UF, owner);
  const npm = await uni(NPM, owner, uf.target, weth.target, ethers.ZeroAddress);
  const router = await uni(ROUTER, owner, ethers.ZeroAddress, uf.target, npm.target, weth.target);
  const locker = await deploy('LaunchLocker', npm.target, platform.address, 2500);
  const curve = await deploy('CensusCurve', npm.target, platform.address, locker.target, weth.target, router.target);
  await locker.initFactory(curve.target);
  const factory = await deploy('LaunchFactoryV2', weth.target, curve.target, router.target, 3000, ethers.ZeroAddress);
  await curve.setFactory(factory.target, true);
  const p = ['Recovery token', 'REC', E('1000000000'), 18, 10000, E('1.5'), E(threshold)];
  const receipt = await (await factory.connect(creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])'](p,[weth.target],[10000],['0x'],ethers.ZeroHash,weth.target,holderShare,[])).wait();
  const launch = event(receipt, factory, 'LaunchedV2');
  const token = await ethers.getContractAt('LaunchToken', launch.args.token);
  const vault = await ethers.getContractAt('DividendVault', launch.args.vault);
  await network.provider.send('hardhat_mine', ['0x65']);
  await curve.connect(buyer).buyWithETH(token.target, 0, { value: E('5') });
  return { owner, platform, creator, buyer, attacker, users, weth, uf, npm, router, locker, curve, factory, token, vault };
}

// Target migration sqrt price exactly as CensusCurve.graduate computes it from the live curve state.
async function migrationTarget(s) {
  const c = await s.curve.curves(s.token.target);
  const first = BigInt(s.token.target) < BigInt(s.weth.target);
  const [a0, a1] = first ? [c.tokenReserve + await s.curve.virtualTokenOffset(s.token.target), c.virtualQuote] : [c.virtualQuote, c.tokenReserve + await s.curve.virtualTokenOffset(s.token.target)];
  return { target: sqrt((a1 << 192n) / a0), tokenIsToken0: first, tokenAmt: c.tokenReserve, quoteAmt: c.realQuote };
}

// Attacker seeds full-range liquidity at whatever price the pool currently has.
async function attackerLP(s, tokenAmount, quoteAmount) {
  const first = BigInt(s.token.target) < BigInt(s.weth.target);
  const [t0, t1, a0, a1] = first ? [s.token.target, s.weth.target, tokenAmount, quoteAmount] : [s.weth.target, s.token.target, quoteAmount, tokenAmount];
  await s.weth.connect(s.attacker).deposit({ value: quoteAmount });
  await s.token.connect(s.attacker).approve(s.npm.target, tokenAmount);
  await s.weth.connect(s.attacker).approve(s.npm.target, quoteAmount);
  const lower = Math.ceil(-887272 / 200) * 200, upper = Math.floor(887272 / 200) * 200;
  const rc = await (await s.npm.connect(s.attacker).mint([t0, t1, 10000, lower, upper, a0, a1, 0, 0, s.attacker.address, Math.floor(Date.now() / 1000) + 1e9])).wait();
  return event(rc, s.npm, 'IncreaseLiquidity').args.tokenId;
}

async function initPoolAt(s, sqrtPriceX96) {
  const first = BigInt(s.token.target) < BigInt(s.weth.target);
  const [t0, t1] = first ? [s.token.target, s.weth.target] : [s.weth.target, s.token.target];
  await s.npm.connect(s.attacker).createAndInitializePoolIfNecessary(t0, t1, 10000, sqrtPriceX96);
  return await s.uf.getPool(t0, t1, 10000);
}

describe('Graduation recovery from adversarial pool initialization', function () {
  this.timeout(240000);

  it('graduates through a pool pre-initialized ABOVE the migration price (no liquidity)', async () => {
    const s = await setup();
    const { target } = await migrationTarget(s);
    const pool = await initPoolAt(s, target * 2n); // 4x the migration price
    const rc = await (await s.curve.graduate(s.token.target)).wait();
    const restored = event(rc, s.curve, 'MigrationPriceRestored');
    expect(restored).to.not.equal(undefined);
    expect(restored.args.targetSqrtPriceX96).to.equal(target);
    const slot0 = await (await ethers.getContractAt([
      'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)'], pool)).slot0();
    expect(slot0[0]).to.equal(target);
    const grad = event(rc, s.curve, 'Graduated');
    const { tokenAmt, quoteAmt } = { tokenAmt: grad.args.tokensIn, quoteAmt: grad.args.quoteIn };
    expect(tokenAmt).to.be.gt(0); expect(quoteAmt).to.be.gt(0);
    // The locked position belongs to the locker; the curve refuses further trades.
    expect(await s.npm.ownerOf(grad.args.tokenId)).to.equal(s.locker.target);
    await expect(s.curve.connect(s.buyer).buyWithETH(s.token.target, 0, { value: E('0.1') })).to.be.reverted;
  });

  it('graduates through a pool pre-initialized BELOW the migration price (no liquidity)', async () => {
    const s = await setup();
    const { target } = await migrationTarget(s);
    const pool = await initPoolAt(s, target / 2n); // 1/4 of the migration price
    const rc = await (await s.curve.graduate(s.token.target)).wait();
    const slot0 = await (await ethers.getContractAt([
      'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)'], pool)).slot0();
    expect(slot0[0]).to.equal(target);
    expect(event(rc, s.curve, 'Graduated')).to.not.equal(undefined);
  });

  it('recovers at the attacker\'s expense when the mispriced pool holds real liquidity', async () => {
    const s = await setup();
    // Attacker acquires tokens on the curve, then seeds a mispriced pool with real liquidity.
    await s.token.connect(s.buyer).transfer(s.attacker.address, (await s.token.balanceOf(s.buyer.address)) / 10n);
    const { target, tokenIsToken0 } = await migrationTarget(s);
    await initPoolAt(s, target / 2n);
    const attackerTokens = await s.token.balanceOf(s.attacker.address);
    await attackerLP(s, attackerTokens, E('1'));

    const dustBeforeT = await s.curve.migrationTokenDust(s.token.target);
    const rc = await (await s.curve.graduate(s.token.target)).wait();
    const restored = event(rc, s.curve, 'MigrationPriceRestored');
    expect(restored).to.not.equal(undefined);
    // The recovery swap bought the cheap side at better than the migration price: the swap's deltas
    // show the curve RECEIVED the underpriced asset and spent the other, both nonzero.
    const d0 = restored.args.amount0Delta, d1 = restored.args.amount1Delta;
    expect(d0 === 0n && d1 === 0n).to.equal(false);
    // Price restored exactly, and the surplus is recorded as migration dust — not sent to anyone.
    const poolAddr = restored.args.pool;
    const slot0 = await (await ethers.getContractAt([
      'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)'], poolAddr)).slot0();
    expect(slot0[0]).to.equal(target);
    // Pool price was below target => token was cheap => curve bought tokens: token-side surplus.
    const dustT = await s.curve.migrationTokenDust(s.token.target);
    expect(dustT).to.be.gte(dustBeforeT);
    // The recovery must never fabricate a creator refund (B01): creator got no quote from graduation.
    expect(event(rc, s.curve, 'Graduated')).to.not.equal(undefined);
  });

  it('fails closed when liquidity is too deep for the bounded recovery, and the curve keeps trading', async () => {
    const s = await setup();
    // Attacker takes a very large token position and seeds deep liquidity far below the target price.
    await s.token.connect(s.buyer).transfer(s.attacker.address, (await s.token.balanceOf(s.buyer.address)) * 9n / 10n);
    const { target } = await migrationTarget(s);
    await initPoolAt(s, target / 16n); // price at 1/256 of migration price
    const attackerTokens = await s.token.balanceOf(s.attacker.address);
    await attackerLP(s, attackerTokens, E('500'));

    await expect(s.curve.graduate(s.token.target)).to.be.reverted;
    // Funds-safe: nothing left the curve, trading still works, graduation can be retried later.
    const c = await s.curve.curves(s.token.target);
    expect(c.graduated).to.equal(false);
    expect(await s.weth.balanceOf(s.curve.target)).to.equal(c.realQuote);
    expect(await s.token.balanceOf(s.curve.target)).to.equal(c.tokenReserve);
    const sell = (await s.token.balanceOf(s.buyer.address)) / 10n;
    await s.token.connect(s.buyer).approve(s.curve.target, sell);
    await s.curve.connect(s.buyer).sell(s.token.target, sell, 0);
    expect((await s.curve.curves(s.token.target)).realQuote).to.be.lt(c.realQuote);
  });

  it('M3: the deployer can sweep a graduated coin recorded migration dust to the platform (once)', async () => {
    const s = await setup();
    await s.token.connect(s.buyer).transfer(s.attacker.address, (await s.token.balanceOf(s.buyer.address)) / 10n);
    const { target } = await migrationTarget(s);
    await initPoolAt(s, target / 2n);
    await attackerLP(s, await s.token.balanceOf(s.attacker.address), E('1'));
    await expect(s.curve.sweepMigrationDust(s.token.target)).to.be.reverted; // not graduated yet
    await s.curve.graduate(s.token.target);
    const dustT = await s.curve.migrationTokenDust(s.token.target), dustQ = await s.curve.migrationQuoteDust(s.token.target);
    expect(dustT + dustQ).to.be.gt(0);
    await expect(s.curve.connect(s.attacker).sweepMigrationDust(s.token.target)).to.be.reverted; // deployer-only
    const [pt, pq] = [await s.token.balanceOf(s.platform.address), await s.weth.balanceOf(s.platform.address)];
    await s.curve.sweepMigrationDust(s.token.target);
    expect(await s.token.balanceOf(s.platform.address) - pt).to.equal(dustT);
    expect(await s.weth.balanceOf(s.platform.address) - pq).to.equal(dustQ);
    expect(await s.curve.migrationTokenDust(s.token.target)).to.equal(0);
    expect(await s.curve.migrationQuoteDust(s.token.target)).to.equal(0);
    // Sweeping only ever moves recorded dust: the curve's active reserves for OTHER coins are untouched.
    await s.curve.sweepMigrationDust(s.token.target);
    expect(await s.token.balanceOf(s.platform.address) - pt).to.equal(dustT);
  });

  it('H5: a griefed graduation can be unblocked by the deployer widening that coin recovery bound', async () => {
    const s = await setup();
    // Parked liquidity deeper than the default 10% bound can absorb (needs roughly 19-37% of a leg to restore),
    // parked below the target price. Sized so the outcome holds for either token0/token1 orientation.
    await s.token.connect(s.buyer).transfer(s.attacker.address, (await s.token.balanceOf(s.buyer.address)) / 4n);
    const { target } = await migrationTarget(s);
    await initPoolAt(s, (target * 5n) / 7n);
    await attackerLP(s, await s.token.balanceOf(s.attacker.address), E('40'));
    await expect(s.curve.graduate(s.token.target)).to.be.reverted; // fails closed at the default bound
    await expect(s.curve.connect(s.attacker).setRecoveryMaxSpendBps(s.token.target, 5000)).to.be.reverted; // deployer-only
    await expect(s.curve.setRecoveryMaxSpendBps(s.token.target, 5001)).to.be.reverted; // hard cap
    await s.curve.setRecoveryMaxSpendBps(s.token.target, 5000);
    expect(await s.curve.recoveryMaxSpendBps(s.token.target)).to.equal(5000);
    const rc = await (await s.curve.graduate(s.token.target)).wait();
    const restored = event(rc, s.curve, 'MigrationPriceRestored');
    expect(restored).to.not.equal(undefined);
    const slot0 = await (await ethers.getContractAt(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)'], restored.args.pool)).slot0();
    expect(slot0[0]).to.equal(target); // still migrates at exactly the curve exit price
    expect(event(rc, s.curve, 'Graduated')).to.not.equal(undefined);
  });

  it('a pool pre-initialized exactly AT the migration price needs no recovery swap', async () => {
    const s = await setup();
    const { target } = await migrationTarget(s);
    await initPoolAt(s, target);
    const rc = await (await s.curve.graduate(s.token.target)).wait();
    expect(event(rc, s.curve, 'MigrationPriceRestored')).to.equal(undefined);
    expect(event(rc, s.curve, 'Graduated')).to.not.equal(undefined);
  });
});

describe('Launch-token LP fee conversion into holder rewards', function () {
  this.timeout(240000);

  async function graduatedWithFees() {
    const s = await setup('4', 10000); // 100% of the creator side to holders
    const rc = await (await s.curve.graduate(s.token.target)).wait();
    const id = event(rc, s.curve, 'Graduated').args.tokenId;
    // Trade both directions in the canonical pool so fees accrue in BOTH assets.
    await s.weth.connect(s.attacker).deposit({ value: E('1') });
    await s.weth.connect(s.attacker).approve(s.router.target, E('1'));
    await s.router.connect(s.attacker).exactInputSingle([s.weth.target, s.token.target, 10000, s.attacker.address, E('1'), 0, 0]);
    const half = (await s.token.balanceOf(s.attacker.address)) / 2n;
    await s.token.connect(s.attacker).approve(s.router.target, half);
    await s.router.connect(s.attacker).exactInputSingle([s.token.target, s.weth.target, 10000, s.attacker.address, half, 0, 0]);
    await s.locker.collectFees(id);
    return s;
  }

  it('converts vault-held launch-token fees to quote and pays them out to holders', async () => {
    const s = await graduatedWithFees();
    const tokenFees = await s.token.balanceOf(s.vault.target);
    expect(tokenFees).to.be.gt(0); // the locker forwarded the holders' launch-token fee share
    const availableBefore = await s.vault.availableQuote();

    // Operator-gated and slippage-guarded.
    await expect(s.vault.connect(s.attacker).convertLaunchFees(tokenFees, 10000, 1)).to.be.reverted;
    await expect(s.vault.connect(s.creator).convertLaunchFees(tokenFees, 10000, E('1000000'))).to.be.reverted;
    await expect(s.vault.connect(s.creator).convertLaunchFees(0, 10000, 1)).to.be.reverted;
    await expect(s.vault.connect(s.creator).convertLaunchFees(tokenFees, 10000, 0)).to.be.reverted;

    const rc = await (await s.vault.connect(s.creator).convertLaunchFees(tokenFees, 10000, 1)).wait();
    const converted = event(rc, s.vault, 'LaunchFeesConverted');
    expect(converted.args.tokenIn).to.equal(tokenFees);
    expect(converted.args.quoteOut).to.be.gt(0);
    expect(await s.token.balanceOf(s.vault.target)).to.equal(0);
    expect(await s.vault.availableQuote()).to.equal(availableBefore + converted.args.quoteOut);

    // The converted quote reaches holders through the normal distribution path (WETH basket passthrough).
    const withdrawableBefore = await s.vault.withdrawableOf(s.buyer.address, s.weth.target);
    await s.vault.connect(s.creator).distribute([0]);
    const withdrawableAfter = await s.vault.withdrawableOf(s.buyer.address, s.weth.target);
    expect(withdrawableAfter).to.be.gt(withdrawableBefore);
    const balBefore = await s.weth.balanceOf(s.buyer.address);
    await s.vault.connect(s.buyer).claim();
    expect(await s.weth.balanceOf(s.buyer.address)).to.be.gt(balBefore);
  });

  it('conversion cannot exceed the vault\'s launch-token balance', async () => {
    const s = await graduatedWithFees();
    const tokenFees = await s.token.balanceOf(s.vault.target);
    await expect(s.vault.connect(s.creator).convertLaunchFees(tokenFees + 1n, 10000, 1)).to.be.reverted;
  });

  it('a keeper pushes rewards to holders with claimFor (automatic distribution)', async () => {
    const s = await graduatedWithFees();
    await s.vault.connect(s.creator).distribute([0]);
    const owed = await s.vault.withdrawableOf(s.buyer.address, s.weth.target);
    expect(owed).to.be.gt(0);
    const before = await s.weth.balanceOf(s.buyer.address);
    // Any caller (the keeper) can deliver — funds only ever go to the holder themself.
    await s.vault.connect(s.attacker).claimFor(s.buyer.address);
    expect(await s.weth.balanceOf(s.buyer.address)).to.equal(before + owed);
    expect(await s.vault.withdrawableOf(s.buyer.address, s.weth.target)).to.equal(0);
    // Idempotent: a second push moves nothing.
    await s.vault.connect(s.attacker).claimFor(s.buyer.address);
    expect(await s.weth.balanceOf(s.buyer.address)).to.equal(before + owed);
    // Excluded addresses (the pool, the vault) cannot be pushed to.
    await expect(s.vault.claimFor(s.vault.target)).to.be.reverted;
  });
});
