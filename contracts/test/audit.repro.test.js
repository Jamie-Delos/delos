// Audit regressions plus explicitly documented remaining design risks.
// Local Hardhat only; no external chain or keys required.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const E = ethers.parseEther;
const UF = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
const NPM = require('@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json');
const ROUTER = require('@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json');
async function deploy(name, ...args) {
  const c = await (await ethers.getContractFactory(name)).deploy(...args);
  await c.waitForDeployment(); return c;
}
async function uni(artifact, signer, ...args) {
  const c = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args);
  await c.waitForDeployment(); return c;
}
async function stack(v2 = false) {
  const [owner, platform, creator, buyer, other] = await ethers.getSigners();
  const weth = await deploy('WETH9');
  const uf = await uni(UF, owner);
  const npm = await uni(NPM, owner, uf.target, weth.target, ethers.ZeroAddress);
  const router = await uni(ROUTER, owner, ethers.ZeroAddress, uf.target, npm.target, weth.target);
  const locker = await deploy('LaunchLocker', npm.target, platform.address, 2500);
  const curve = await deploy('CensusCurve', npm.target, platform.address, locker.target, weth.target, router.target);
  await locker.initFactory(curve.target);
  const factory = v2
    ? await deploy('LaunchFactoryV2', weth.target, curve.target, router.target, 3000, ethers.ZeroAddress)
    : await deploy('LaunchFactory', weth.target, curve.target);
  await curve.setFactory(factory.target, true);
  const params = ['Audit', 'AUD', E('1000000000'), 18, 10000, E('1.5'), E('4')];
  const tx = v2
    ? await factory.connect(creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),address[],uint16[],bytes[],bytes32)'](params, [weth.target], [10000], ['0x'], ethers.ZeroHash)
    : await factory.connect(creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32)'](params, ethers.ZeroHash);
  const rc = await tx.wait();
  const event = rc.logs.map(l => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(e => e && e.name.startsWith('Launched'));
  const token = await ethers.getContractAt('LaunchToken', event.args.token);
  const vault = v2 ? await ethers.getContractAt('DividendVault', event.args.vault) : null;
  await network.provider.send('hardhat_mine', ['0x65']);
  await curve.connect(buyer).buyWithETH(token.target, 0, { value: E('5') });
  return { owner, platform, creator, buyer, other, weth, uf, npm, router, locker, curve, factory, token, vault };
}
describe('Audit regressions and remaining design risks', function () {
  it('accepts a vanity salt grinded from the generated client bytecode on a fresh deployment', async function () {
    this.timeout(120000);
    const s = await stack();
    const fs = require('node:fs');
    const path = require('node:path');
    const embedded = fs.readFileSync(path.join(__dirname, '../../frontend/src/lib/launchTokenBytecode.ts'), 'utf8').match(/0x[0-9a-fA-F]{100,}/)[0];
    const actual = (await ethers.getContractFactory('LaunchToken')).bytecode;
    expect(embedded).to.equal(actual);
    const constructor = ethers.AbiCoder.defaultAbiCoder().encode(['string', 'string', 'uint256', 'uint8', 'address'], ['Audit', 'AUD', E('1000000000'), 18, s.factory.target]);
    const oldHash = ethers.keccak256(ethers.concat([embedded, constructor]));
    const newHash = ethers.keccak256(ethers.concat([actual, constructor]));
    let salt;
    for (let i = 1; i < 5000000; i++) {
      const candidate = ethers.toBeHex(i, 32);
      if (ethers.getCreate2Address(s.factory.target, candidate, oldHash).toLowerCase().endsWith('c0de')) { salt = candidate; break; }
    }
    expect(salt).to.not.equal(undefined);
    expect(ethers.getCreate2Address(s.factory.target, salt, newHash).toLowerCase().endsWith('c0de')).to.equal(true);
    const p = ['Audit', 'AUD', E('1000000000'), 18, 10000, E('1.5'), E('4')];
    await expect(s.factory.connect(s.creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32)'](p, salt)).not.to.be.reverted;
  });
  it('never re-credits reserved quote dividends and pays both holders their shares', async function () {
    const [operator, a, b] = await ethers.getSigners();
    const quote = await deploy('MockERC20', 'Quote', 'Q');
    const token = await deploy('LaunchToken', 'Token', 'T', E('100'), 18, operator.address);
    const router = await deploy('MockSwapRouter');
    const vault = await deploy('DividendVault', quote.target, router.target, 3000, [quote.target], [10000], ['0x'], ethers.ZeroAddress);
    await vault.init(token.target, [], operator.address);
    await token.setDividendVault(vault.target);
    await token.transfer(a.address, E('50')); await token.transfer(b.address, E('50'));
    await quote.mint(vault.target, E('10'));
    await vault.distribute([0]); await vault.distribute([0]);
    expect(await vault.availableQuote()).to.equal(0);
    expect(await vault.withdrawableOf(a.address, quote.target)).to.equal(E('5'));
    expect(await vault.withdrawableOf(b.address, quote.target)).to.equal(E('5'));
    await vault.connect(a).claim(); await vault.connect(b).claim();
    expect(await quote.balanceOf(a.address)).to.equal(E('5'));
    expect(await quote.balanceOf(b.address)).to.equal(E('5'));
    expect(await vault.reserved(quote.target)).to.equal(0);
  });
  it('recovers a poisoned graduation without refunding the creator or losing curve reserves', async function () {
    const s = await stack();
    const coinFirst = BigInt(s.token.target) < BigInt(s.weth.target);
    const [t0, t1] = coinFirst ? [s.token.target, s.weth.target] : [s.weth.target, s.token.target];
    const sqrt = coinFirst ? (2n ** 96n) / 1000000n : (2n ** 96n) * 1000000n;
    // Initializing an empty Uniswap pool requires neither LP capital nor token ownership.
    await s.npm.connect(s.other).createAndInitializePoolIfNecessary(t0, t1, 10000, sqrt);
    const before = await s.weth.balanceOf(s.creator.address);
    const c = await s.curve.curves(s.token.target);
    const raised = c.realQuote;
    const [a0, a1] = coinFirst ? [c.tokenReserve + await s.curve.virtualTokenOffset(s.token.target), c.virtualQuote] : [c.virtualQuote, c.tokenReserve + await s.curve.virtualTokenOffset(s.token.target)];
    const isqrt = n => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
    const target = isqrt((a1 << 192n) / a0);
    // The bounded recovery swap restores the migration price through the empty pool, so the
    // poisoned initialization neither blocks graduation nor diverts any raised quote.
    const rc = await (await s.curve.connect(s.other).graduate(s.token.target)).wait();
    expect(await s.weth.balanceOf(s.creator.address) - before).to.equal(0);
    const event = rc.logs.map(l => { try { return s.curve.interface.parseLog(l); } catch { return null; } }).find(e => e && e.name === 'Graduated');
    const pool = new ethers.Contract(event.args.pool, ['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)'], s.owner);
    expect((await pool.slot0())[0]).to.equal(target);
    expect((await s.curve.curves(s.token.target)).graduated).to.equal(true);
    // Essentially all raised quote entered the permanently locked position; only bounded dust remains.
    expect(event.args.quoteIn).to.be.gte((raised * 9999n) / 10000n);
    expect(await s.npm.ownerOf(event.args.tokenId)).to.equal(s.locker.target);
  });
  it('preserves marginal curve price at PF graduation', async function () {
    const s = await stack();
    const c = await s.curve.curves(s.token.target);
    const rc = await (await s.curve.graduate(s.token.target)).wait();
    const event = rc.logs.map(l => { try { return s.curve.interface.parseLog(l); } catch { return null; } }).find(e => e && e.name === 'Graduated');
    const pool = new ethers.Contract(event.args.pool, ['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)'], s.owner);
    const sqrt = (await pool.slot0())[0];
    const poolPrice = BigInt(s.token.target) < BigInt(s.weth.target)
      ? Number(sqrt) ** 2 / 2 ** 192 : 2 ** 192 / Number(sqrt) ** 2;
    const curvePrice = Number(c.virtualQuote) / Number(c.tokenReserve + await s.curve.virtualTokenOffset(s.token.target));
    expect(poolPrice / curvePrice).to.be.closeTo(1, 1e-12);
    console.log('      pool/curve exit price:', poolPrice / curvePrice);
  });
  it('preserves platform and 100%-holder allocations after Maxima graduation', async function () {
    const s = await stack(true);
    const rc = await (await s.curve.graduate(s.token.target)).wait();
    const event = rc.logs.map(l => { try { return s.curve.interface.parseLog(l); } catch { return null; } }).find(e => e && e.name === 'Graduated');
    await s.weth.deposit({ value: E('1') }); await s.weth.approve(s.router.target, E('1'));
    await s.router.exactInputSingle([s.weth.target, s.token.target, 10000, s.owner.address, E('1'), 0, 0]);
    const before = await Promise.all([s.creator.address, s.platform.address, s.vault.target].map(a => s.weth.balanceOf(a)));
    await s.locker.collectFees(event.args.tokenId);
    const after = await Promise.all([s.creator.address, s.platform.address, s.vault.target].map(a => s.weth.balanceOf(a)));
    expect(after[0] - before[0]).to.equal(0);
    expect(after[1] - before[1]).to.be.gt(0);
    expect(after[2] - before[2]).to.be.closeTo((after[1] - before[1]) * 3n, 3n);
    console.log('      creator/platform/holders WETH:', after.map((x, i) => ethers.formatEther(x - before[i])).join('/'));
  });
});
