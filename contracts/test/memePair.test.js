// Meme pairing: a launch quoted in a GRADUATED Census company coin ($MEME/$XYZ). Only company
// coins (whose own quote is deployer-approved collateral) qualify; meme-on-meme chains do not.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const E = ethers.parseEther;
const UF = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
const NPM = require('@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json');
const ROUTER = require('@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json');
async function deploy(name, ...args) { const c = await (await ethers.getContractFactory(name)).deploy(...args); await c.waitForDeployment(); return c; }
async function uni(artifact, signer, ...args) { const c = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer).deploy(...args); await c.waitForDeployment(); return c; }
function event(receipt, contract, name) { return receipt.logs.map(l => { try { return contract.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === name); }

const P = (grad = '4') => ['Company', 'XYZ', E('1000000000'), 18, 10000, E('1.5'), E(grad)];

async function stack() {
  const [owner, platform, creator, memer, buyer] = await ethers.getSigners();
  const weth = await deploy('WETH9'); const uf = await uni(UF, owner);
  const npm = await uni(NPM, owner, uf.target, weth.target, ethers.ZeroAddress);
  const router = await uni(ROUTER, owner, ethers.ZeroAddress, uf.target, npm.target, weth.target);
  const locker = await deploy('LaunchLocker', npm.target, platform.address, 2500);
  const curve = await deploy('CensusCurve', npm.target, platform.address, locker.target, weth.target, router.target);
  await locker.initFactory(curve.target);
  const factory = await deploy('LaunchFactory', weth.target, curve.target);
  await curve.setFactory(factory.target, true);
  const factoryV2 = await deploy('LaunchFactoryV2', weth.target, curve.target, router.target, 3000, ethers.ZeroAddress);
  await curve.setFactory(factoryV2.target, true);
  // Company coin, WETH-quoted, bought to its graduation reserve.
  const rc = await (await factory.connect(creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32)'](P(), ethers.ZeroHash)).wait();
  const company = await ethers.getContractAt('LaunchToken', event(rc, factory, 'Launched').args.token);
  await network.provider.send('hardhat_mine', ['0x65']);
  await curve.connect(buyer).buyWithETH(company.target, 0, { value: E('5') });
  return { owner, platform, creator, memer, buyer, weth, uf, npm, router, locker, curve, factory, factoryV2, company };
}

const launchMeme = (s, quoteAddr, grad = '4') =>
  s.factory.connect(s.memer)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32,address,address[])'](
    ['Meme', 'MEME', E('1000000000'), 18, 10000, E('1.5'), E(grad)], ethers.ZeroHash, quoteAddr, []);

describe('Meme pairing against graduated company coins', function () {
  this.timeout(240000);

  it('rejects a company-coin quote BEFORE that coin graduates', async () => {
    const s = await stack();
    expect(await s.curve.isPairableCompanyCoin(s.company.target)).to.equal(false);
    await expect(launchMeme(s, s.company.target)).to.be.reverted;
  });

  it('full $MEME/$XYZ lifecycle: launch, trade with XYZ fees, graduate into a MEME/XYZ locked pool', async () => {
    const s = await stack();
    await s.curve.graduate(s.company.target);
    expect(await s.curve.isPairableCompanyCoin(s.company.target)).to.equal(true);

    const rc = await (await launchMeme(s, s.company.target, '0.5')).wait();
    const meme = await ethers.getContractAt('LaunchToken', event(rc, s.factory, 'Launched').args.token);
    expect((await s.curve.curves(meme.target)).quote).to.equal(s.company.target);
    await network.provider.send('hardhat_mine', ['0x65']);

    // The buyer pays with XYZ (bought earlier on the company curve); the 2% fee splits in XYZ.
    const spend = E('1000000');
    await s.company.connect(s.buyer).approve(s.curve.target, spend);
    const [platformBefore, creatorBefore] = await Promise.all([s.company.balanceOf(s.platform.address), s.company.balanceOf(s.memer.address)]);
    await s.curve.connect(s.buyer).buy(meme.target, spend, 0);
    expect(await meme.balanceOf(s.buyer.address)).to.be.gt(0);
    const fee = (spend * 200n) / 10000n;
    expect(await s.company.balanceOf(s.platform.address) - platformBefore).to.equal((fee * 2500n) / 10000n);
    expect(await s.company.balanceOf(s.memer.address) - creatorBefore).to.equal(fee - (fee * 2500n) / 10000n); // Prima: creator keeps the 75% side

    // Raise the meme's graduation reserve in XYZ and graduate: a permanently-locked MEME/XYZ pool.
    let c = await s.curve.curves(meme.target);
    while (c.realQuote < c.graduationQuote) {
      const need = ((c.graduationQuote - c.realQuote) * 10000n) / 9800n + 10n ** 15n;
      await s.company.connect(s.buyer).approve(s.curve.target, need);
      await s.curve.connect(s.buyer).buy(meme.target, need, 0);
      c = await s.curve.curves(meme.target);
    }
    const grc = await (await s.curve.graduate(meme.target)).wait();
    const grad = event(grc, s.curve, 'Graduated');
    expect(grad).to.not.equal(undefined);
    expect(await s.npm.ownerOf(grad.args.tokenId)).to.equal(s.locker.target);
    const pool = await s.uf.getPool(meme.target, s.company.target, 10000);
    expect(pool).to.equal(grad.args.pool);

    // Swapping MEME<->XYZ in the graduated pool accrues fees for the locker position (Census revenue on the pair).
    await s.company.connect(s.buyer).approve(s.router.target, E('10000'));
    await s.router.connect(s.buyer).exactInputSingle([s.company.target, meme.target, 10000, s.buyer.address, E('10000'), 0, 0]);
    const amounts = await s.locker.collectFees.staticCall(grad.args.tokenId);
    expect(amounts[0] + amounts[1]).to.be.gt(0);
  });

  it('M2: a Maxima meme quoted in a company coin needs basket routes rooted at that coin', async () => {
    const s = await stack();
    await s.curve.graduate(s.company.target);
    const stock = await deploy('MockERC20', 'NVDA', 'NVDA');
    const p = ['Meme', 'MEME', E('1000000000'), 18, 10000, E('1.5'), E('0.5')];
    const launch = (paths) => s.factoryV2.connect(s.memer)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])'](
      p, [stock.target], [10000], paths, ethers.ZeroHash, s.company.target, 10000, []);
    // The stored WETH-rooted stock route (what the wizard used for every non-HOOD anchor) reverts at
    // launch: the vault requires the route to start at ITS quote (the company coin).
    const wethRoute = ethers.solidityPacked(['address', 'uint24', 'address'], [s.weth.target, 3000, stock.target]);
    await expect(launch([wethRoute])).to.be.reverted;
    // Re-rooted at the company coin through its canonical pool tier: XYZ -> WETH -> stock.
    const coinRoute = ethers.solidityPacked(['address', 'uint24', 'address', 'uint24', 'address'], [s.company.target, 10000, s.weth.target, 3000, stock.target]);
    const rc = await (await launch([coinRoute])).wait();
    const ev = event(rc, s.factoryV2, 'LaunchedV2');
    const vault = await ethers.getContractAt('DividendVault', ev.args.vault);
    expect(await vault.quote()).to.equal(s.company.target);
    expect(await vault.paths(0)).to.equal(coinRoute);
    expect((await s.curve.curves(ev.args.token)).quote).to.equal(s.company.target);
  });

  it('meme-on-meme chains are not pairable', async () => {
    const s = await stack();
    await s.curve.graduate(s.company.target);
    const rc = await (await launchMeme(s, s.company.target, '0.5')).wait();
    const meme = await ethers.getContractAt('LaunchToken', event(rc, s.factory, 'Launched').args.token);
    await network.provider.send('hardhat_mine', ['0x65']);
    // Graduate the first meme, then try to pair a second meme against it.
    let c = await s.curve.curves(meme.target);
    while (c.realQuote < c.graduationQuote) {
      const need = ((c.graduationQuote - c.realQuote) * 10000n) / 9800n + 10n ** 15n;
      await s.company.connect(s.buyer).approve(s.curve.target, need);
      await s.curve.connect(s.buyer).buy(meme.target, need, 0);
      c = await s.curve.curves(meme.target);
    }
    await s.curve.graduate(meme.target);
    expect(await s.curve.isPairableCompanyCoin(meme.target)).to.equal(false); // its quote is XYZ, not approved collateral
    await expect(launchMeme(s, meme.target)).to.be.reverted;
  });
});
