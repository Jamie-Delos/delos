// Regressions for the independent-review findings (audit/INDEPENDENT-REVIEW.md): keeper authority
// (H1), fee deferral instead of a trading halt (M5), per-asset claim resilience (M4), pool-fee
// validation at registration, and the factory/vault-deployer split (EIP-170 headroom).
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const E = ethers.parseEther;
async function deploy(name, ...args) { const c = await (await ethers.getContractFactory(name)).deploy(...args); await c.waitForDeployment(); return c; }
function event(receipt, contract, name) { return receipt.logs.map(l => { try { return contract.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === name); }

// Compact Maxima stack on mocks: real curve + factory + vault, mock router (1:1 inventory swaps).
async function stack() {
  const [owner, platform, creator, keeper, buyer, stranger] = await ethers.getSigners();
  const weth = await deploy('WETH9'); const router = await deploy('MockSwapRouter');
  const curve = await deploy('CensusCurve', owner.address, platform.address, owner.address, weth.target, router.target);
  const factory = await deploy('LaunchFactoryV2', weth.target, curve.target, router.target, 3000, ethers.ZeroAddress);
  await curve.setFactory(factory.target, true);
  const p = ['Keeper token', 'KPR', E('1000000000'), 18, 10000, E('1.5'), E('4')];
  const rc = await (await factory.connect(creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])'](p, [weth.target], [10000], ['0x'], ethers.ZeroHash, weth.target, 10000, [])).wait();
  const launch = event(rc, factory, 'LaunchedV2');
  const token = await ethers.getContractAt('LaunchToken', launch.args.token);
  const vault = await ethers.getContractAt('DividendVault', launch.args.vault);
  await network.provider.send('hardhat_mine', ['0x65']);
  await curve.connect(buyer).buyWithETH(token.target, 0, { value: E('1') }); // 2% fee: 75% -> vault (holdersBps=10000)
  return { owner, platform, creator, keeper, buyer, stranger, weth, router, curve, factory, token, vault };
}

describe('Review fixes — keeper authority, deferred fees, resilient claims', function () {
  this.timeout(240000);

  it('factory creates vaults through the deployer and stays far below EIP-170', async () => {
    const s = await stack();
    const deployerAddr = await s.factory.vaultDeployer();
    expect(await s.vault.factory()).to.equal(deployerAddr);
    expect(await s.vault.census()).to.equal(s.curve.target);
    expect(await s.vault.operator()).to.equal(s.creator.address);
    expect(await s.vault.excluded(s.vault.target)).to.equal(true);
    expect(await s.vault.excluded(s.curve.target)).to.equal(true);
    const size = (await ethers.provider.getCode(s.factory.target)).length / 2 - 1;
    expect(size).to.be.lt(20000);
    // The deployer is single-purpose: only its factory may use it.
    const d = await ethers.getContractAt('DividendVaultDeployer', deployerAddr);
    await expect(d.create(s.weth.target, s.router.target, 3000, [s.weth.target], [10000], ['0x'], ethers.ZeroAddress, s.token.target, [], s.owner.address, s.curve.target)).to.be.reverted;
  });

  it('H1: the platform keeper registered on the curve can distribute without per-coin delegation', async () => {
    const s = await stack();
    const fees = await s.vault.availableQuote();
    expect(fees).to.be.gt(0);
    // Nobody is registered yet: a stranger (and the future keeper) cannot distribute.
    await expect(s.vault.connect(s.keeper).distribute([0])).to.be.reverted;
    await expect(s.curve.connect(s.stranger).setKeeper(s.keeper.address)).to.be.reverted; // deployer-only
    await s.curve.setKeeper(s.keeper.address);
    expect(await s.curve.keeper()).to.equal(s.keeper.address);
    await s.vault.connect(s.keeper).distribute([0]);
    expect(await s.vault.reserved(s.weth.target)).to.equal(fees);
    expect(await s.vault.withdrawableOf(s.buyer.address, s.weth.target)).to.be.gt(0);
    // The creator remains the operator (can still distribute and delegate); the keeper cannot take it.
    await expect(s.vault.connect(s.keeper).setOperator(s.keeper.address)).to.be.reverted;
    await s.curve.connect(s.buyer).buyWithETH(s.token.target, 0, { value: E('0.1') });
    await s.vault.connect(s.creator).distribute([0]);
    await expect(s.vault.connect(s.stranger).distribute([0])).to.be.reverted;
    // Rotating the keeper on the curve applies to every existing vault at once.
    await s.curve.setKeeper(s.stranger.address);
    await s.curve.connect(s.buyer).buyWithETH(s.token.target, 0, { value: E('0.1') });
    await expect(s.vault.connect(s.keeper).distribute([0])).to.be.reverted;
    await s.vault.connect(s.stranger).distribute([0]);
  });

  it('M5: a blocked fee recipient defers its share instead of halting trading; it is pushable later', async () => {
    const [owner, platform, buyer, creator] = await ethers.getSigners();
    const q = await deploy('AuditQuote'); const r = await deploy('MockSwapRouter'); const t = await deploy('MockERC20', 'A', 'A');
    const c = await deploy('CensusCurve', owner.address, platform.address, owner.address, q.target, r.target);
    await c.setFactory(owner.address, true); await t.mint(c.target, E('1000000'));
    await c.register(t.target, q.target, creator.address, ethers.ZeroAddress, 0, 10000, E('1.5'), E('1000000'), E('4'));
    await q.mint(buyer.address, E('2')); await q.connect(buyer).approve(c.target, E('2'));
    await q.setBlocked(platform.address);
    const creatorBefore = await q.balanceOf(creator.address);
    const rc = await (await c.connect(buyer).buy(t.target, E('1'), 0)).wait(); // trading continues
    const fee = E('1') * 200n / 10000n, protocol = fee * 2500n / 10000n;
    const deferred = event(rc, c, 'FeeDeferred');
    expect(deferred.args.recipient).to.equal(platform.address);
    expect(deferred.args.amount).to.equal(protocol);
    expect(await c.deferredFee(q.target, platform.address)).to.equal(protocol);
    expect(await q.balanceOf(creator.address) - creatorBefore).to.equal(fee - protocol); // unblocked recipient paid normally
    // Reserves stay whole: curve balance = realQuote + deferred fees.
    const cv = await c.curves(t.target);
    expect(await q.balanceOf(c.target)).to.equal(cv.realQuote + protocol);
    // Still blocked: the push reverts and the amount stays deferred.
    await expect(c.withdrawDeferredFee(q.target, platform.address)).to.be.reverted;
    expect(await c.deferredFee(q.target, platform.address)).to.equal(protocol);
    // Unblocked: anyone can push it; nothing left to push afterwards.
    await q.setBlocked(ethers.ZeroAddress);
    await c.connect(buyer).withdrawDeferredFee(q.target, platform.address);
    expect(await q.balanceOf(platform.address)).to.equal(protocol);
    expect(await c.deferredFee(q.target, platform.address)).to.equal(0);
    await expect(c.withdrawDeferredFee(q.target, platform.address)).to.be.reverted;
    expect(await q.balanceOf(c.target)).to.equal((await c.curves(t.target)).realQuote);
  });

  it('M4: one frozen basket asset defers only its own payout; the rest of the basket still pays', async () => {
    const [operator, holder] = await ethers.getSigners();
    const q = await deploy('MockERC20', 'Q', 'Q'), frozen = await deploy('AuditQuote'), ok = await deploy('MockERC20', 'S', 'S'), router = await deploy('MockSwapRouter');
    const token = await deploy('LaunchToken', 'T', 'T', E('100'), 18, operator.address);
    const v = await deploy('DividendVault', q.target, router.target, 3000, [frozen.target, ok.target], [5000, 5000], ['0x', '0x'], ethers.ZeroAddress);
    await v.init(token.target, [], operator.address); await token.setDividendVault(v.target);
    await token.transfer(holder.address, E('100'));
    await frozen.mint(router.target, E('10')); await ok.mint(router.target, E('10')); await q.mint(v.target, E('10'));
    await v.distribute([E('5'), E('5')]);
    expect(await v.withdrawableOf(holder.address, frozen.target)).to.equal(E('5'));
    expect(await v.withdrawableOf(holder.address, ok.target)).to.equal(E('5'));
    await frozen.setBlocked(holder.address); // issuer blacklists the holder for ONE asset
    const rc = await (await v.claimFor(holder.address)).wait();
    const deferred = event(rc, v, 'ClaimDeferred');
    expect(deferred.args.stock).to.equal(frozen.target);
    expect(deferred.args.amount).to.equal(E('5'));
    expect(await ok.balanceOf(holder.address)).to.equal(E('5'));       // paid
    expect(await frozen.balanceOf(holder.address)).to.equal(0);        // deferred, still owed
    expect(await v.withdrawableOf(holder.address, frozen.target)).to.equal(E('5'));
    expect(await v.reserved(frozen.target)).to.equal(E('5'));         // reserve untouched
    expect(await v.withdrawableOf(holder.address, ok.target)).to.equal(0);
    // Unfrozen: the deferred asset pays out on the next claim.
    await frozen.setBlocked(ethers.ZeroAddress);
    await v.connect(holder).claim();
    expect(await frozen.balanceOf(holder.address)).to.equal(E('5'));
    expect(await v.reserved(frozen.target)).to.equal(0);
  });

  it('rejects registration with a pool fee tier Uniswap V3 does not have', async () => {
    const [owner, platform] = await ethers.getSigners();
    const weth = await deploy('WETH9'); const r = await deploy('MockSwapRouter');
    const c = await deploy('CensusCurve', owner.address, platform.address, owner.address, weth.target, r.target);
    await c.setFactory(owner.address, true);
    for (const [fee, ok] of [[1234, false], [0, false], [500, true], [10000, true]]) {
      const t = await deploy('MockERC20', 'A', 'A'); await t.mint(c.target, E('1000000'));
      const tx = c.register(t.target, weth.target, owner.address, ethers.ZeroAddress, 0, fee, E('1.5'), E('1000000'), E('4'));
      if (ok) await tx; else await expect(tx).to.be.reverted;
    }
  });

  it('decodable custom errors replace stripped revert strings on the user-facing paths', async () => {
    const s = await stack();
    await expect(s.curve.connect(s.buyer).buy(s.token.target, 0, 0)).to.be.revertedWithCustomError(s.curve, 'ZeroAmount');
    await expect(s.vault.connect(s.stranger).distribute([0])).to.be.revertedWithCustomError(s.vault, 'NotOperator');
    await expect(s.vault.claimFor(s.vault.target)).to.be.revertedWithCustomError(s.vault, 'Excluded');
    await expect(s.vault.connect(s.creator).distribute([0, 0])).to.be.revertedWithCustomError(s.vault, 'BadParams');
  });
});
