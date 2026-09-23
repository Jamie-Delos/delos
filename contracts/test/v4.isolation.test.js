// Many launches on one shared V4 stack: every coin has its own reward vault, basket and holder ledger.
// Interleaved trades across four coins must never move fees, rewards or holder credit between them.
// Rewards are always quoted assets (pairing asset / listed stocks), never any coin.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { deploy, deployHook } = require('./helpers/v4');
const E = ethers.parseEther;
const MIN = 4295128740n;
const MAX = 1461446703485210103287273052203988822378723970341n;
const SIG = 'createLaunch((string,string,uint256,uint8,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])';
const ev = (rc, c, name) => rc.logs.map((l) => { try { return c.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === name);

describe('V4 isolation: four coins on one stack keep fees, baskets and holder rewards separate', function () {
  this.timeout(600000);
  it('interleaved trades, distributions, graduations and claims never cross between launches', async () => {
    const [owner, treasury, creatorA, creatorB, creatorC, creatorD, alice, bob, carol, keeper] = await ethers.getSigners();
    const weth = await deploy('MockWETH'), v3Router = await deploy('MockSwapRouter');
    const nvda = await deploy('MockERC20', 'NVIDIA', 'NVDA'), aapl = await deploy('MockERC20', 'Apple', 'AAPL'), tsla = await deploy('MockERC20', 'Tesla', 'TSLA');
    for (const s of [nvda, aapl, tsla]) await s.mint(v3Router.target, E('1000000'));
    const manager = await deploy('PoolManager', owner.address);
    const curve = await deploy('CensusCurveV4', treasury.address, weth.target, v3Router.target);
    const graduator = await deploy('CensusV4Graduator', manager.target, curve.target, treasury.address);
    const hook = await deployHook(manager.target, graduator.target, treasury.address);
    await graduator.setHook(hook.target); await curve.setGraduator(graduator.target);
    const router = await deploy('CensusV4Router', manager.target, hook.target);
    const vaultDeployer = await deploy('CensusRewardVaultDeployer');
    const factory = await deploy('LaunchFactoryV4', weth.target, curve.target, v3Router.target, 3000, ethers.ZeroAddress, router.target, vaultDeployer.target);
    await vaultDeployer.setLaunchFactory(factory.target); await curve.setFactory(factory.target, true); await curve.setKeeper(keeper.address);
    for (const s of [nvda, aapl, tsla]) await curve.setRewardAssetAllowed(s.target, true);
    const traders = [alice, bob, carol];
    for (const t of traders) { await weth.connect(t).deposit({ value: E('60') }); await weth.connect(t).approve(curve.target, ethers.MaxUint256); await weth.connect(t).approve(router.target, ethers.MaxUint256); }

    // Four launches with different economics on the same curve/factory/hook.
    const specs = [
      { creator: creatorA, reflection: 0, basket: [], weights: [] },
      { creator: creatorB, reflection: 100, basket: [tsla.target], weights: [10000] },
      { creator: creatorC, reflection: 300, basket: [weth.target, nvda.target], weights: [5000, 5000] },
      { creator: creatorD, reflection: 400, basket: [weth.target, aapl.target, tsla.target], weights: [3000, 5000, 2000] },
    ];
    const coins = [];
    for (const [i, s] of specs.entries()) {
      const rc = await (await factory.connect(s.creator)[SIG]([`Coin ${i}`, `C${i}`, E('1000000000'), 18, E('1.5'), E('4')], s.basket, s.weights, s.basket.map(() => '0x'), ethers.ZeroHash, weth.target, s.reflection, [])).wait();
      const e = ev(rc, factory, 'LaunchedV4')[0].args;
      const token = await ethers.getContractAt('LaunchToken', e.token);
      const vault = e.vault === ethers.ZeroAddress ? null : await ethers.getContractAt('CensusRewardVault', e.vault);
      for (const t of traders) { await token.connect(t).approve(curve.target, ethers.MaxUint256); await token.connect(t).approve(router.target, ethers.MaxUint256); }
      coins.push({ ...s, token, vault });
    }
    // Every vault is distinct, bound to its own coin, with its own frozen basket.
    const vaults = coins.filter((c) => c.vault).map((c) => c.vault.target);
    expect(new Set(vaults).size).to.equal(3);
    for (const c of coins.filter((c) => c.vault)) {
      expect(await c.vault.token()).to.equal(c.token.target);
      for (let i = 0; i < c.basket.length; i++) expect(await c.vault.basket(i)).to.equal(c.basket[i]);
      const cv = await curve.curves(c.token.target);
      expect(cv.vault).to.equal(c.vault.target); expect(cv.reflectionBps).to.equal(c.reflection); expect(cv.creator).to.equal(c.creator.address);
    }
    // No coin can be a reward for another coin (or itself).
    for (const c of coins) await expect(factory.connect(creatorA)[SIG](['X', 'X', E('1000000000'), 18, E('1.5'), E('4')], [c.token.target], [10000], ['0x'], ethers.ZeroHash, weth.target, 100, [])).to.be.revertedWithCustomError(factory, 'AssetNotAllowed');
    await network.provider.send('evm_increaseTime', [10]); await network.provider.send('evm_mine');

    // Interleaved trades: each coin's fee goes only to its own creator and its own vault.
    const creatorBefore = await Promise.all(coins.map((c) => weth.balanceOf(c.creator.address)));
    const vaultBefore = await Promise.all(coins.map((c) => c.vault ? weth.balanceOf(c.vault.target) : 0n));
    const expectedCreator = coins.map(() => 0n), expectedVault = coins.map(() => 0n);
    for (let round = 0; round < 6; round++) {
      for (const [i, c] of coins.entries()) {
        const t = traders[(round + i) % 3];
        const amount = E('0.1') * BigInt(1 + ((round * 3 + i) % 5));
        const rc = await (await curve.connect(t).buy(c.token.target, amount, 0)).wait();
        const a = ev(rc, curve, 'FeeAllocated')[0].args;
        expect(a.holderFee).to.equal(amount * BigInt(c.reflection) / 10000n);
        expect(a.protocolFee).to.equal((amount * 200n / 10000n) * 9000n / 10000n);
        expectedCreator[i] += a.creatorFee; expectedVault[i] += a.holderFee;
      }
    }
    for (const [i, c] of coins.entries()) {
      expect(await weth.balanceOf(c.creator.address) - creatorBefore[i]).to.equal(expectedCreator[i]);
      if (c.vault) expect(await weth.balanceOf(c.vault.target) - vaultBefore[i]).to.equal(expectedVault[i]);
    }
    // Each vault's eligible supply is its own coin's circulating supply.
    for (const c of coins.filter((c) => c.vault)) {
      for (const other of coins.filter((o) => o !== c && o.vault)) expect(await c.vault.eligibleSupply()).to.not.equal(await other.vault.eligibleSupply());
      const held = await Promise.all(traders.map((t) => c.token.balanceOf(t.address)));
      expect(await c.vault.eligibleSupply()).to.equal(held.reduce((x, y) => x + y, 0n));
    }

    // Distribute each vault: credits are proportional to holdings of THAT coin, paid in THAT basket only.
    for (const c of coins.filter((c) => c.vault)) {
      const before = await c.vault.availableQuote();
      await c.vault.connect(keeper).distribute(c.basket.map((b) => (b === weth.target ? 0 : 1)));
      expect(await c.vault.availableQuote()).to.equal(0n);
      expect(before).to.equal(expectedVault[coins.indexOf(c)]);
      for (const other of coins) expect(await other.token.balanceOf(c.vault.target)).to.equal(0n); // no coin ever sits in a vault
    }
    // Claims: alice's rewards from coin 3 (AAPL/TSLA) are unaffected by coin 2's NVDA basket, and vice versa.
    const aliceNvdaBefore = await nvda.balanceOf(alice.address), aliceAaplBefore = await aapl.balanceOf(alice.address);
    const owedNvda = await coins[2].vault.withdrawableOf(alice.address, nvda.target);
    const owedAapl = await coins[3].vault.withdrawableOf(alice.address, aapl.target);
    expect(await coins[2].vault.withdrawableOf(alice.address, aapl.target)).to.equal(0n);
    expect(await coins[3].vault.withdrawableOf(alice.address, nvda.target)).to.equal(0n);
    await coins[2].vault.connect(alice).claim();
    expect(await nvda.balanceOf(alice.address) - aliceNvdaBefore).to.equal(owedNvda);
    expect(await aapl.balanceOf(alice.address)).to.equal(aliceAaplBefore); // coin 2's claim never touches coin 3's basket
    await coins[3].vault.connect(alice).claim();
    expect(await aapl.balanceOf(alice.address) - aliceAaplBefore).to.equal(owedAapl);
    // TSLA is in two baskets: each vault holds and pays only its own TSLA reserve.
    const tsla1 = await coins[1].vault.reserved(tsla.target), tsla3 = await coins[3].vault.reserved(tsla.target);
    expect(await tsla.balanceOf(coins[1].vault.target)).to.equal(tsla1);
    expect(await tsla.balanceOf(coins[3].vault.target)).to.be.gte(tsla3);
    const owedTsla1 = await coins[1].vault.withdrawableOf(alice.address, tsla.target);
    expect(owedTsla1).to.be.gt(0n);
    const tslaBefore = await tsla.balanceOf(alice.address);
    await coins[1].vault.connect(alice).claim();
    expect(await tsla.balanceOf(alice.address) - tslaBefore).to.equal(owedTsla1);
    expect(await coins[3].vault.reserved(tsla.target)).to.equal(tsla3); // coin 3's TSLA reserve untouched

    // Graduate two coins; the others keep trading on the curve; hook claimables are per vault.
    for (const c of [coins[1], coins[3]]) {
      await curve.connect(bob).buyWithETH(c.token.target, 0, { value: E('10') }); // fills and auto-graduates
    }
    expect((await curve.curves(coins[0].token.target)).graduated).to.equal(false);
    expect((await curve.curves(coins[2].token.target)).graduated).to.equal(false);
    for (const c of [coins[1], coins[3]]) {
      const coin0 = BigInt(c.token.target) < BigInt(weth.target);
      const key = { currency0: coin0 ? c.token.target : weth.target, currency1: coin0 ? weth.target : c.token.target, fee: 0, tickSpacing: 60, hooks: hook.target };
      await router.connect(carol).swapExactInput({ key, zeroForOne: !coin0, amountIn: E('1'), minOut: 1n, sqrtPriceLimitX96: coin0 ? MAX : MIN, recipient: carol.address, deadline: ethers.MaxUint256 });
      expect(await hook.claimable(weth.target, c.vault.target)).to.equal(E('1') * BigInt(c.reflection) / 10000n);
      expect(await hook.claimable(weth.target, c.creator.address)).to.equal(E('0.014'));
    }
    expect(await hook.claimable(weth.target, coins[2].vault.target)).to.equal(0n); // still on the curve: nothing in the hook
    expect(await hook.claimable(weth.target, creatorA.address)).to.equal(0n);
    // Curve trading of the non-graduated coins is unaffected by the graduations.
    await curve.connect(alice).buy(coins[2].token.target, E('0.1'), 0);
    await curve.connect(alice).buy(coins[0].token.target, E('0.1'), 0);
    // Hook custody equals the sum of every recipient's claimable, and each vault only pulls its own share.
    let total = 0n;
    for (const r of [treasury.address, creatorB.address, creatorD.address, coins[1].vault.target, coins[3].vault.target]) total += await hook.claimable(weth.target, r);
    expect(await hook.totalReserved(weth.target)).to.equal(total);
    expect(await weth.balanceOf(hook.target)).to.equal(total);
    const v3Before = await weth.balanceOf(coins[3].vault.target);
    await hook.claimFor(weth.target, coins[1].vault.target);
    expect(await weth.balanceOf(coins[3].vault.target)).to.equal(v3Before);
  });
});
