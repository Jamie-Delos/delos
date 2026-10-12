const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deploy, deployHook } = require('./helpers/v4');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild'); // own devDependency; the test must not reach into the sibling frontend install
const filename = path.join(__dirname, '..', '..', 'frontend', 'src', 'lib', 'devBuy.ts');
const compiled = buildSync({ entryPoints:[filename], bundle:true, platform:'node', format:'cjs', write:false }).outputFiles[0].text;
const loaded = new Module(filename, module); loaded.filename=filename; loaded.paths=module.paths; loaded._compile(compiled,filename);
const { estimateDevBuy } = loaded.exports;
const E = ethers.parseEther;
const SIG = 'createLaunch((string,string,uint256,uint8,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])';
const BUY = 'createLaunchWithDevBuy((string,string,uint256,uint8,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[],uint256,uint256)';
const events = (rc, contract, name) => rc.logs.flatMap(l => { try { const e = contract.interface.parseLog(l); return e?.name === name ? [e] : []; } catch { return []; } });
async function stack() {
  const [owner, treasury, creator, other] = await ethers.getSigners();
  const weth = await deploy('MockWETH');
  const stock = await deploy('MockERC20', 'Quote', 'Q');
  const v3 = await deploy('MockSwapRouter');
  const manager = await deploy('PoolManager', owner.address);
  const curve = await deploy('CensusCurveV4', treasury.address, weth.target, v3.target);
  const graduator = await deploy('CensusV4Graduator', manager.target, curve.target, treasury.address);
  const hook = await deployHook(manager.target, graduator.target, treasury.address);
  await graduator.setHook(hook.target); await curve.setGraduator(graduator.target);
  const v4Router = await deploy('CensusV4Router', manager.target, hook.target);
  const vaultDeployer = await deploy('CensusRewardVaultDeployer');
  const factory = await deploy('LaunchFactoryV4', weth.target, curve.target, v3.target, 3000, ethers.ZeroAddress, v4Router.target, vaultDeployer.target);
  await vaultDeployer.setLaunchFactory(factory.target); await curve.setFactory(factory.target, true);
  await curve.setQuoteAllowed(stock.target, true);
  await stock.mint(creator.address, E('100'));
  const p = ['Creator buy test','CBT',E('1000000000'),18,E('1.5'),E('4')];
  return {owner,treasury,creator,other,weth,stock,curve,factory,p};
}
describe('Optional creator buy in the launch transaction', function () {
  this.timeout(180000);
  it('empty option keeps the existing no-buy launch', async () => {
    const s=await stack();
    const rc=await (await s.factory.connect(s.creator)[SIG](s.p,[],[],[],ethers.ZeroHash,s.weth.target,0,[])).wait();
    const token=await ethers.getContractAt('LaunchToken',events(rc,s.factory,'LaunchedV4')[0].args.token);
    expect(await token.balanceOf(s.creator.address)).to.equal(0n);
    expect(await token.balanceOf(s.curve.target)).to.equal(s.p[2]);
    expect(events(rc,s.factory,'DevBought')).to.have.length(0);
  });
  it('ETH buy occurs atomically, transfers tokens to creator, and pays 2% without the launch penalty', async () => {
    const s=await stack(); const input=E('0.1');
    const preview=estimateDevBuy({totalSupply:s.p[2],virtualQuote:s.p[4],graduationQuote:s.p[5],grossQuoteIn:input,reflectionBps:0});
    const rc=await (await s.factory.connect(s.creator)[BUY](s.p,[],[],[],ethers.ZeroHash,s.weth.target,0,[],input,1n,{value:input})).wait();
    const token=await ethers.getContractAt('LaunchToken',events(rc,s.factory,'LaunchedV4')[0].args.token);
    const bought=events(rc,s.factory,'DevBought')[0].args;
    expect(await token.balanceOf(s.creator.address)).to.equal(bought.tokensReceived);
    expect(await s.weth.balanceOf(s.creator.address)).to.equal(E('0.0002'));
    expect(await s.weth.balanceOf(s.treasury.address)).to.equal(E('0.0018'));
    expect(events(rc,s.curve,'SnipeTaxCharged')).to.have.length(0);
    expect(await s.curve.snipeTaxExempt(token.target,s.factory.target)).to.equal(true);
    expect(await s.curve.snipeTaxExempt(token.target,s.other.address)).to.equal(false);
    expect(bought.quoteSpent).to.equal(input); expect(bought.quoteRefunded).to.equal(0n);
    expect(bought.tokensReceived).to.equal(preview.tokens);
    expect(preview.sharePercent).to.be.greaterThan(0);
    const cv=await s.curve.curves(token.target); expect(cv.creator).to.equal(s.creator.address);
    expect(await token.totalSupply()).to.equal(E('1000000000'));
  });
  it('refunds a capped ETH buy in the same launch transaction and does not trap tokens', async () => {
    const s=await stack(); const input=E('5');
    const preview=estimateDevBuy({totalSupply:s.p[2],virtualQuote:s.p[4],graduationQuote:s.p[5],grossQuoteIn:input,reflectionBps:0});
    const rc=await (await s.factory.connect(s.creator)[BUY](s.p,[],[],[],ethers.ZeroHash,s.weth.target,0,[],input,1n,{value:input,gasLimit:10_000_000})).wait();
    const bought=events(rc,s.factory,'DevBought')[0].args;
    expect(bought.quoteRefunded).to.be.gt(0n);
    expect(bought.quoteSpent+bought.quoteRefunded).to.equal(input);
    expect(bought.tokensReceived).to.equal(preview.tokens);
    expect(bought.quoteRefunded).to.equal(preview.refund);
    const token=await ethers.getContractAt('LaunchToken',bought.token);
    expect(await token.balanceOf(s.creator.address)).to.equal(bought.tokensReceived);
    expect(await token.balanceOf(s.factory.target)).to.equal(0n);
    expect(await ethers.provider.getBalance(s.factory.target)).to.equal(0n);
    expect(await s.curve.isGraduated(token.target)).to.equal(true);
  });
  it('quote-token buy uses approval, refunds a cap, and enforces its minimum atomically', async () => {
    const s=await stack(); const input=E('5');
    await s.stock.connect(s.creator).approve(s.factory.target,input);
    await expect(s.factory.connect(s.creator)[BUY](s.p,[],[],[],ethers.ZeroHash,s.stock.target,0,[],input,E('999999999'))).to.be.reverted;
    const rc=await (await s.factory.connect(s.creator)[BUY](s.p,[],[],[],ethers.ZeroHash,s.stock.target,0,[],input,1n,{gasLimit:10_000_000})).wait();
    const bought=events(rc,s.factory,'DevBought')[0].args;
    expect(bought.quoteRefunded).to.be.gt(0n);
    expect(await s.stock.balanceOf(s.factory.target)).to.equal(0n);
    expect(await s.stock.allowance(s.factory.target,s.curve.target)).to.equal(0n);
    const allocation=events(rc,s.curve,'FeeAllocated')[0].args;
    expect(await s.stock.balanceOf(s.creator.address)).to.equal(E('100')-bought.quoteSpent+allocation.creatorFee);
  });
  it('requires a nonzero buy and exact native value', async () => {
    const s=await stack();
    await expect(s.factory.connect(s.creator)[BUY](s.p,[],[],[],ethers.ZeroHash,s.weth.target,0,[],0,1n)).to.be.revertedWithCustomError(s.factory,'InvalidDevBuy');
    await expect(s.factory.connect(s.creator)[BUY](s.p,[],[],[],ethers.ZeroHash,s.weth.target,0,[],E('0.1'),1n,{value:E('0.2')})).to.be.revertedWithCustomError(s.factory,'InvalidDevBuy');
  });
  it('applies optional reflection and records the purchased supply in the reward vault', async () => {
    const s=await stack(); const input=E('0.1');
    const preview=estimateDevBuy({totalSupply:s.p[2],virtualQuote:s.p[4],graduationQuote:s.p[5],grossQuoteIn:input,reflectionBps:200});
    const rc=await(await s.factory.connect(s.creator)[BUY](s.p,[s.weth.target],[10000],['0x'],ethers.ZeroHash,s.weth.target,200,[],input,preview.tokens,{value:input})).wait();
    const launch=events(rc,s.factory,'LaunchedV4')[0].args;
    const token=await ethers.getContractAt('LaunchToken',launch.token);
    const purchased=events(rc,s.factory,'DevBought')[0].args;
    expect(purchased.tokensReceived).to.equal(preview.tokens);
    expect(await token.balanceOf(s.creator.address)).to.equal(preview.tokens);
    expect(await s.weth.balanceOf(launch.vault)).to.equal(E('0.002'));
    expect(await s.weth.balanceOf(s.treasury.address)).to.equal(E('0.0018'));
    expect(events(rc,s.curve,'SnipeTaxCharged')).to.have.length(0);
  });
});
