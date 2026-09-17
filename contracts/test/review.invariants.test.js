// Fund-safety invariants for the review fixes, on REAL Uniswap V3 contracts:
//   1. deferred fees stay backed by the curve's balance, survive graduation untouched, cannot be swept
//      (sweepMigrationDust moves ONLY recorded dust, to the immutable platform) and can only ever be
//      pushed to the recipient they belong to;
//   2. a blocked fee recipient or a blocked claimant never halts the other recipients' payouts;
//   3. the recovery-bound lever cannot divert reserves: after a widened recovery the curve holds
//      exactly its recorded dust, the pool is at the migration price, the swap never lost value at
//      that price, and no admin address received anything from the graduation.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const E = ethers.parseEther;
const UF = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
const NPM = require('@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json');
const ROUTER = require('@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json');
async function deploy(name, ...args) { const c = await (await ethers.getContractFactory(name)).deploy(...args); await c.waitForDeployment(); return c; }
async function uni(artifact, signer, ...args) { const c = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args); await c.waitForDeployment(); return c; }
function event(receipt, contract, name) { return receipt.logs.map(l => { try { return contract.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === name); }
function sqrt(n) { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; }
const POOL_ABI = ['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)'];

// Real Uniswap stack whose quote collateral is the adversarial AuditQuote (blocklist-capable).
async function stack() {
  const [owner, platform, creator, buyer, attacker, holderA, holderB] = await ethers.getSigners();
  const weth = await deploy('WETH9'); const aq = await deploy('AuditQuote'); const uf = await uni(UF, owner);
  const npm = await uni(NPM, owner, uf.target, weth.target, ethers.ZeroAddress);
  const router = await uni(ROUTER, owner, ethers.ZeroAddress, uf.target, npm.target, weth.target);
  const locker = await deploy('LaunchLocker', npm.target, platform.address, 2500);
  const curve = await deploy('CensusCurve', npm.target, platform.address, locker.target, weth.target, router.target);
  await locker.initFactory(curve.target);
  const factory = await deploy('LaunchFactory', weth.target, curve.target);
  const factoryV2 = await deploy('LaunchFactoryV2', weth.target, curve.target, router.target, 3000, ethers.ZeroAddress);
  await curve.setFactory(factory.target, true); await curve.setFactory(factoryV2.target, true);
  await curve.setQuoteAllowed(aq.target, true);
  for (const s of [buyer, attacker, holderA, holderB]) { await aq.mint(s.address, E('1000')); await aq.connect(s).approve(curve.target, E('1000')); }
  return { owner, platform, creator, buyer, attacker, holderA, holderB, weth, aq, uf, npm, router, locker, curve, factory, factoryV2 };
}
const P = (grad) => ['Coin', 'C', E('1000000000'), 18, 10000, E('1.5'), E(grad)];
async function launchPrima(s, grad = '4') {
  const rc = await (await s.factory.connect(s.creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32,address,address[])'](P(grad), ethers.ZeroHash, s.aq.target, [])).wait();
  await network.provider.send('hardhat_mine', ['0x65']);
  return ethers.getContractAt('LaunchToken', event(rc, s.factory, 'Launched').args.token);
}
async function launchMaxima(s, holdersBps = 5000) {
  const rc = await (await s.factoryV2.connect(s.creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])'](P('4'), [s.aq.target], [10000], ['0x'], ethers.ZeroHash, s.aq.target, holdersBps, [])).wait();
  await network.provider.send('hardhat_mine', ['0x65']);
  const ev = event(rc, s.factoryV2, 'LaunchedV2');
  return { token: await ethers.getContractAt('LaunchToken', ev.args.token), vault: await ethers.getContractAt('DividendVault', ev.args.vault) };
}
// Curve balance of a quote must equal every live curve's realQuote + every deferred fee + recorded dust.
async function backing(s, coins, recipients) {
  let sum = 0n;
  for (const c of coins) { const cv = await s.curve.curves(c.target); sum += cv.realQuote + (await s.curve.migrationQuoteDust(c.target)); }
  for (const r of recipients) sum += await s.curve.deferredFee(s.aq.target, r);
  return sum;
}
async function fillToGraduation(s, coin) {
  let c = await s.curve.curves(coin.target);
  while (c.realQuote < c.graduationQuote) {
    const need = ((c.graduationQuote - c.realQuote) * 10000n) / 9800n + 10n ** 15n;
    await s.curve.connect(s.buyer).buy(coin.target, need, 0);
    c = await s.curve.curves(coin.target);
  }
}

describe('Review invariants — deferred fees, payout isolation, recovery permissions', function () {
  this.timeout(240000);

  it('deferred fees stay backed through trading and graduation, cannot be swept, and only reach their recipient', async () => {
    const s = await stack();
    const A = await launchPrima(s, '4'), B = await launchPrima(s, '100');
    const recipients = [s.platform.address, s.creator.address];
    await s.aq.setBlocked(s.platform.address);
    // Trading continues on both coins while the platform is blocked; its share accrues as deferred fees.
    await s.curve.connect(s.buyer).buy(A.target, E('2'), 0);
    await s.curve.connect(s.buyer).buy(B.target, E('3'), 0);
    const half = (await A.balanceOf(s.buyer.address)) / 2n;
    await A.connect(s.buyer).approve(s.curve.target, half);
    await s.curve.connect(s.buyer).sell(A.target, half, 0);
    const deferred = await s.curve.deferredFee(s.aq.target, s.platform.address);
    expect(deferred).to.be.gt(0);
    expect(await s.aq.balanceOf(s.curve.target)).to.equal(await backing(s, [A, B], recipients));
    // Deferred fees are not curve reserves: the accounting identity above holds with them counted
    // separately, and sells are capped at realQuote in _sell (CurveLimit), never at the balance.
    // Graduation migrates ONLY A's realQuote; B's reserves and the deferred fees are untouched.
    await fillToGraduation(s, A);
    const deferredBefore = await s.curve.deferredFee(s.aq.target, s.platform.address);
    const platformBefore = await s.aq.balanceOf(s.platform.address);
    await s.curve.graduate(A.target);
    expect(await s.curve.deferredFee(s.aq.target, s.platform.address)).to.equal(deferredBefore);
    expect((await s.curve.curves(A.target)).realQuote).to.equal(0);
    expect(await s.aq.balanceOf(s.curve.target)).to.equal(await backing(s, [A, B], recipients));
    // Sweeping moves ONLY the recorded dust, ONLY to the immutable platform, and never the deferred fees.
    await expect(s.curve.connect(s.attacker).sweepMigrationDust(A.target)).to.be.reverted;
    await s.aq.setBlocked(ethers.ZeroAddress);
    const dustQ = await s.curve.migrationQuoteDust(A.target), dustT = await s.curve.migrationTokenDust(A.target);
    const ownerBefore = await s.aq.balanceOf(s.owner.address);
    await s.curve.sweepMigrationDust(A.target);
    expect(await s.aq.balanceOf(s.platform.address) - platformBefore).to.equal(dustQ);
    expect(await A.balanceOf(s.platform.address)).to.equal(dustT);
    expect(await s.aq.balanceOf(s.owner.address)).to.equal(ownerBefore); // the deployer gets nothing
    expect(await s.curve.deferredFee(s.aq.target, s.platform.address)).to.equal(deferredBefore);
    expect(await s.aq.balanceOf(s.curve.target)).to.equal(await backing(s, [A, B], recipients));
    // The push is permissionless but pays the RECIPIENT, whoever calls it.
    const attackerBefore = await s.aq.balanceOf(s.attacker.address);
    await s.curve.connect(s.attacker).withdrawDeferredFee(s.aq.target, s.platform.address);
    expect(await s.aq.balanceOf(s.attacker.address)).to.equal(attackerBefore);
    expect(await s.aq.balanceOf(s.platform.address) - platformBefore).to.equal(dustQ + deferredBefore);
    expect(await s.curve.deferredFee(s.aq.target, s.platform.address)).to.equal(0);
    expect(await s.aq.balanceOf(s.curve.target)).to.equal(await backing(s, [A, B], recipients));
    expect(await s.aq.balanceOf(s.curve.target)).to.equal((await s.curve.curves(B.target)).realQuote); // exactly B's live reserve
  });

  it('a blocked vault, creator or claimant never halts the other payouts', async () => {
    const s = await stack();
    const { token, vault } = await launchMaxima(s, 5000);
    // Blocked VAULT: platform + creator are still paid on every trade, the holders' share is deferred.
    await s.aq.setBlocked(vault.target);
    const [p0, c0] = [await s.aq.balanceOf(s.platform.address), await s.aq.balanceOf(s.creator.address)];
    await s.curve.connect(s.holderA).buy(token.target, E('1'), 0);
    const fee = E('1') * 200n / 10000n, protocol = fee * 2500n / 10000n, holders = (fee - protocol) * 5000n / 10000n;
    expect(await s.aq.balanceOf(s.platform.address) - p0).to.equal(protocol);
    expect(await s.aq.balanceOf(s.creator.address) - c0).to.equal(fee - protocol - holders);
    expect(await s.curve.deferredFee(s.aq.target, vault.target)).to.equal(holders);
    // Blocked CREATOR next: platform and vault still paid, creator deferred; trading never stops.
    await s.aq.setBlocked(s.creator.address);
    const v0 = await s.aq.balanceOf(vault.target);
    await s.curve.connect(s.holderB).buy(token.target, E('1'), 0);
    expect(await s.aq.balanceOf(vault.target) - v0).to.equal(holders);
    expect(await s.curve.deferredFee(s.aq.target, s.creator.address)).to.equal(fee - protocol - holders);
    // Deferred holder share reaches the vault once it can receive again and funds a distribution.
    await s.aq.setBlocked(ethers.ZeroAddress);
    await s.curve.withdrawDeferredFee(s.aq.target, vault.target);
    expect(await vault.availableQuote()).to.equal(2n * holders);
    await vault.connect(s.creator).distribute([0]);
    const owedA = await vault.withdrawableOf(s.holderA.address, s.aq.target), owedB = await vault.withdrawableOf(s.holderB.address, s.aq.target);
    expect(owedA).to.be.gt(0); expect(owedB).to.be.gt(0);
    // Blocked CLAIMANT A: A's payout is deferred (still owed, still reserved); B is paid in full.
    await s.aq.setBlocked(s.holderA.address);
    const rcA = await (await vault.claimFor(s.holderA.address)).wait();
    expect(event(rcA, vault, 'ClaimDeferred').args.amount).to.equal(owedA);
    expect(await vault.withdrawableOf(s.holderA.address, s.aq.target)).to.equal(owedA);
    const b0 = await s.aq.balanceOf(s.holderB.address);
    await vault.claimFor(s.holderB.address);
    expect(await s.aq.balanceOf(s.holderB.address) - b0).to.equal(owedB);
    expect(await vault.reserved(s.aq.target)).to.equal(owedA + (2n * holders - owedA - owedB)); // A's entitlement + rounding dust stay reserved
    // Nothing paid to anyone else; the vault remains solvent for A.
    expect(await s.aq.balanceOf(vault.target)).to.be.gte(await vault.reserved(s.aq.target));
  });

  it('the recovery-bound lever cannot divert reserves: dust-only residue, exact price, no value loss, nothing to admins', async () => {
    const s = await stack();
    const { token } = await launchMaxima(s, 10000);
    await s.curve.connect(s.buyer).buy(token.target, E('5'), 0);
    await token.connect(s.buyer).transfer(s.attacker.address, (await token.balanceOf(s.buyer.address)) / 4n);
    // Migration target exactly as graduate() computes it.
    const c = await s.curve.curves(token.target);
    const tokenIsToken0 = BigInt(token.target) < BigInt(s.aq.target);
    const [a0, a1] = tokenIsToken0 ? [c.tokenReserve + await s.curve.virtualTokenOffset(token.target), c.virtualQuote] : [c.virtualQuote, c.tokenReserve + await s.curve.virtualTokenOffset(token.target)];
    const target = sqrt((a1 << 192n) / a0);
    const [t0, t1] = tokenIsToken0 ? [token.target, s.aq.target] : [s.aq.target, token.target];
    // Attacker parks deep full-range liquidity at 5/7 of the target sqrt price.
    await s.npm.connect(s.attacker).createAndInitializePoolIfNecessary(t0, t1, 10000, (target * 5n) / 7n);
    const parkedTokens = await token.balanceOf(s.attacker.address), parkedQuote = E('40');
    await token.connect(s.attacker).approve(s.npm.target, parkedTokens); await s.aq.connect(s.attacker).approve(s.npm.target, parkedQuote);
    const [m0, m1] = tokenIsToken0 ? [parkedTokens, parkedQuote] : [parkedQuote, parkedTokens];
    const lower = Math.ceil(-887272 / 200) * 200, upper = Math.floor(887272 / 200) * 200;
    await s.npm.connect(s.attacker).mint([t0, t1, 10000, lower, upper, m0, m1, 0, 0, s.attacker.address, Math.floor(Date.now() / 1000) + 1e9]);
    await expect(s.curve.graduate(token.target)).to.be.reverted; // default bound: fail closed
    // Only the deployer can widen the bound, only up to the cap, and the lever changes NO balances by itself.
    await expect(s.curve.connect(s.attacker).setRecoveryMaxSpendBps(token.target, 5000)).to.be.reverted;
    await expect(s.curve.setRecoveryMaxSpendBps(token.target, 5001)).to.be.reverted;
    const snapshot = [await token.balanceOf(s.curve.target), await s.aq.balanceOf(s.curve.target)];
    await s.curve.setRecoveryMaxSpendBps(token.target, 5000);
    expect([await token.balanceOf(s.curve.target), await s.aq.balanceOf(s.curve.target)]).to.deep.equal(snapshot);
    const admins = [s.owner.address, s.platform.address, s.creator.address];
    const before = await Promise.all(admins.flatMap((a) => [token.balanceOf(a), s.aq.balanceOf(a)]));
    const rc = await (await s.curve.connect(s.attacker).graduate(token.target)).wait(); // permissionless caller
    const restored = event(rc, s.curve, 'MigrationPriceRestored');
    expect(restored).to.not.equal(undefined);
    // (a) the pool sits exactly at the migration price
    const pool = await ethers.getContractAt(POOL_ABI, restored.args.pool);
    expect((await pool.slot0())[0]).to.equal(target);
    // (b) the recovery swap never lost value at the migration price: value(-d0, -d1) >= 0 in token1 units
    const d0 = restored.args.amount0Delta, d1 = restored.args.amount1Delta;
    const curveValueDelta = -((d0 * target * target) >> 192n) - d1;
    expect(curveValueDelta).to.be.gte(0n);
    // (c) the curve keeps exactly its recorded dust; everything else is in the locked position
    expect(await token.balanceOf(s.curve.target)).to.equal(await s.curve.migrationTokenDust(token.target));
    expect(await s.aq.balanceOf(s.curve.target)).to.equal(await s.curve.migrationQuoteDust(token.target));
    expect(await s.npm.ownerOf(event(rc, s.curve, 'Graduated').args.tokenId)).to.equal(s.locker.target);
    // (d) neither the deployer, the platform nor the creator received anything from the graduation
    const after = await Promise.all(admins.flatMap((a) => [token.balanceOf(a), s.aq.balanceOf(a)]));
    expect(after).to.deep.equal(before);
    // (e) the lever is per-coin and resettable; it never touches other coins
    await s.curve.setRecoveryMaxSpendBps(token.target, 0);
    expect(await s.curve.recoveryMaxSpendBps(token.target)).to.equal(0);
  });
});
