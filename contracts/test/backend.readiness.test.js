// Local-only regressions; external-pool and issuer-freeze cases document remaining design risks.
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
async function setup(v2 = false, threshold = '4', holderShare = 10000) {
  const [owner, platform, creator, buyer, other, ...users] = await ethers.getSigners();
  const weth = await deploy('WETH9'); const uf = await uni(UF, owner);
  const npm = await uni(NPM, owner, uf.target, weth.target, ethers.ZeroAddress);
  const router = await uni(ROUTER, owner, ethers.ZeroAddress, uf.target, npm.target, weth.target);
  const locker = await deploy('LaunchLocker', npm.target, platform.address, 2500);
  const curve = await deploy('CensusCurve', npm.target, platform.address, locker.target, weth.target, router.target);
  await locker.initFactory(curve.target);
  const factory = v2 ? await deploy('LaunchFactoryV2', weth.target, curve.target, router.target, 3000, ethers.ZeroAddress) : await deploy('LaunchFactory', weth.target, curve.target);
  await curve.setFactory(factory.target, true);
  const p = ['Audit token', 'AUDIT', E('1000000000'), 18, 10000, E('1.5'), E(threshold)];
  const receipt = await (await (v2 ? factory.connect(creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])'](p,[weth.target],[10000],['0x'],ethers.ZeroHash,weth.target,holderShare,[]) : factory.connect(creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32)'](p,ethers.ZeroHash))).wait();
  const launch = event(receipt,factory,v2?'LaunchedV2':'Launched');
  const token = await ethers.getContractAt('LaunchToken',launch.args.token);
  const vault = v2 ? await ethers.getContractAt('DividendVault',launch.args.vault) : null;
  await network.provider.send('hardhat_mine',['0x65']);
  await curve.connect(buyer).buyWithETH(token.target,0,{value:E('5')});
  return {owner,platform,creator,buyer,other,users,weth,uf,npm,router,locker,curve,factory,token,vault};
}
async function addLP(s, fee, tokenAmount, quoteAmount) {
  const first = BigInt(s.token.target)<BigInt(s.weth.target);
  const [t0,t1,a0,a1] = first ? [s.token.target,s.weth.target,tokenAmount,quoteAmount] : [s.weth.target,s.token.target,quoteAmount,tokenAmount];
  await s.weth.connect(s.buyer).deposit({value:quoteAmount});
  await s.token.connect(s.buyer).approve(s.npm.target,tokenAmount); await s.weth.connect(s.buyer).approve(s.npm.target,quoteAmount);
  await s.npm.createAndInitializePoolIfNecessary(t0,t1,fee,sqrt((a1<<192n)/a0));
  const spacing = fee===500?10:200; const lower=Math.ceil(-887272/spacing)*spacing,upper=Math.floor(887272/spacing)*spacing;
  const rc=await (await s.npm.connect(s.buyer).mint([t0,t1,fee,lower,upper,a0,a1,0,0,s.buyer.address,Math.floor(Date.now()/1000)+1000000000])).wait();
  return {pool:await s.uf.getPool(t0,t1,fee),id:event(rc,s.npm,'IncreaseLiquidity').args.tokenId};
}
async function externalBuy(s, fee) { await s.weth.connect(s.other).deposit({value:E('.1')}); await s.weth.connect(s.other).approve(s.router.target,E('.1')); return (await s.router.connect(s.other).exactInputSingle([s.weth.target,s.token.target,fee,s.other.address,E('.1'),0,0])).wait(); }

describe('Backend regressions and remaining external risks', function () {
  this.timeout(180000);
  for(const share of [0,4000,10000]) it(`splits both LP fee assets with holder allocation ${share} bps`,async()=>{
    const s=await setup(true,'4',share);const rc=await(await s.curve.graduate(s.token.target)).wait();const id=event(rc,s.curve,'Graduated').args.tokenId;
    await externalBuy(s,10000);
    const sell=(await s.token.balanceOf(s.other.address))/2n;await s.token.connect(s.other).approve(s.router.target,sell);
    await s.router.connect(s.other).exactInputSingle([s.token.target,s.weth.target,10000,s.other.address,sell,0,0]);
    const amounts=await s.locker.collectFees.staticCall(id);
    const assets=BigInt(s.token.target)<BigInt(s.weth.target)?[s.token,s.weth]:[s.weth,s.token];
    const recipients=[s.platform.address,s.creator.address,s.vault.target];
    const before=await Promise.all(assets.map(t=>Promise.all(recipients.map(w=>t.balanceOf(w)))));
    await s.locker.collectFees(id);
    for(let i=0;i<2;i++){
      expect(amounts[i]).to.be.gt(0);const platform=amounts[i]*2500n/10000n,side=amounts[i]-platform,holders=side*BigInt(share)/10000n;
      const expected=[platform,side-holders,holders];
      for(let j=0;j<3;j++)expect((await assets[i].balanceOf(recipients[j]))-before[i][j]).to.equal(expected[j]);
    }
  });
  it('external pool trades bypass Census fees BEFORE graduation', async () => {
    const s=await setup(true); await addLP(s,500,E('1000000'),E('1'));
    const recipients=[s.platform.address,s.creator.address,s.vault.target]; const before=await Promise.all(recipients.map(a=>s.weth.balanceOf(a)));
    const state=await s.curve.curves(s.token.target); const rc=await externalBuy(s,500);
    expect(await s.token.balanceOf(s.other.address)).to.be.gt(0);
    expect(event(rc,s.curve,'Traded')).to.equal(undefined);
    expect((await s.curve.curves(s.token.target)).realQuote).to.equal(state.realQuote);
    expect(await Promise.all(recipients.map(a=>s.weth.balanceOf(a)))).to.deep.equal(before);
    expect(state.graduated).to.equal(false);
  });
  it('external pool trades bypass locked-position revenue AFTER graduation', async () => {
    const s=await setup(); const rc=await(await s.curve.graduate(s.token.target)).wait(); const id=event(rc,s.curve,'Graduated').args.tokenId;
    await addLP(s,500,E('1000000'),E('1')); await externalBuy(s,500);
    const amounts=await s.locker.collectFees.staticCall(id); expect(amounts[0]+amounts[1]).to.equal(0);
  });
  it('third-party LP in the SAME official pool captures fees outside Census locker', async () => {
    const s=await setup(); const c=await s.curve.curves(s.token.target); await s.curve.graduate(s.token.target);
    const lp=await addLP(s,10000,c.tokenReserve,c.realQuote); await externalBuy(s,10000);
    const amounts=await s.npm.connect(s.buyer).collect.staticCall([lp.id,s.buyer.address,2n**128n-1n,2n**128n-1n]);
    expect(amounts[0]+amounts[1]).to.be.gt(0);
    console.log('      externally owned same-pool NFT collects nonzero LP fees');
  });
  it('unrecognized external pools accrue dividends they cannot claim', async () => {
    const s=await setup(true); const lp=await addLP(s,500,E('1000000'),E('1'));
    expect(await s.vault.excluded(lp.pool)).to.equal(false);
    await s.vault.connect(s.creator).distribute([0]);
    expect(await s.vault.withdrawableOf(lp.pool,s.weth.target)).to.be.gt(0);
  });
  it('selling before first collection cannot suppress the migrated protocol split', async () => {
    const s=await setup(); const rc=await(await s.curve.graduate(s.token.target)).wait(); const id=event(rc,s.curve,'Graduated').args.tokenId;
    await s.token.connect(s.buyer).approve(s.router.target,E('1000000'));
    await s.router.connect(s.buyer).exactInputSingle([s.token.target,s.weth.target,10000,s.buyer.address,E('1000000'),0,0]);
    expect(await s.locker.isGraduated(id)).to.equal(true);
    const before=await s.token.balanceOf(s.platform.address); await s.locker.collectFees(id);
    expect(await s.token.balanceOf(s.platform.address)).to.be.gt(before);
  });
  it('rejects a taxed quote deposit atomically without damaging shared reserves', async () => {
    const [owner,platform,buyer]=await ethers.getSigners(); const q=await deploy('AuditQuote'); const router=await deploy('MockSwapRouter');
    const curve=await deploy('CensusCurve',owner.address,platform.address,owner.address,q.target,router.target); await curve.setFactory(owner.address,true);
    const a=await deploy('MockERC20','A','A'),b=await deploy('MockERC20','B','B');
    for(const t of [a,b]) { await t.mint(curve.target,E('1000000')); await curve.register(t.target,q.target,owner.address,ethers.ZeroAddress,0,10000,E('1.5'),E('1000000'),E('1000')); }
    await q.mint(buyer.address,E('200')); await q.connect(buyer).approve(curve.target,E('200')); await curve.connect(buyer).buy(a.target,E('100'),0);
    await q.setTax(1000); await expect(curve.connect(buyer).buy(b.target,E('100'),0)).to.be.reverted;
    const liabilities=(await curve.curves(a.target)).realQuote+(await curve.curves(b.target)).realQuote;
    expect(liabilities-await q.balanceOf(curve.target)).to.equal(0);
  });
  it('rejects launches with unsupported quote collateral until the deployer enables it', async () => {
    const [owner,platform]=await ethers.getSigners(); const q=await deploy('AuditQuote'); const weth=await deploy('WETH9'); const r=await deploy('MockSwapRouter'); const t=await deploy('MockERC20','A','A');
    const c=await deploy('CensusCurve',owner.address,platform.address,owner.address,weth.target,r.target); await c.setFactory(owner.address,true); await t.mint(c.target,E('1000000'));
    const register=()=>c.register(t.target,q.target,owner.address,ethers.ZeroAddress,0,10000,E('1.5'),E('1000000'),E('4'));
    await expect(register()).to.be.reverted; // arbitrary collateral is refused
    await expect(c.connect(platform).setQuoteAllowed(q.target,true)).to.be.reverted; // deployer-only
    await c.setQuoteAllowed(q.target,true);
    await register(); // approved collateral registers
    expect(await c.allowedQuote(weth.target)).to.equal(true); // WETH enabled at deployment
  });
  it('blocked fee recipient no longer halts trading: the share is deferred and pushable later', async () => {
    const [owner,platform,buyer]=await ethers.getSigners(); const q=await deploy('AuditQuote'); const r=await deploy('MockSwapRouter'); const t=await deploy('MockERC20','A','A');
    const c=await deploy('CensusCurve',owner.address,platform.address,owner.address,q.target,r.target); await c.setFactory(owner.address,true); await t.mint(c.target,E('1000000'));
    await c.register(t.target,q.target,owner.address,ethers.ZeroAddress,0,10000,E('1.5'),E('1000000'),E('4')); await q.mint(buyer.address,E('1')); await q.connect(buyer).approve(c.target,E('1')); await q.setBlocked(platform.address);
    await c.connect(buyer).buy(t.target,E('1'),0);
    const protocol=E('1')*200n/10000n*2500n/10000n; expect(await c.deferredFee(q.target,platform.address)).to.equal(protocol);
    expect(await q.balanceOf(c.target)).to.equal((await c.curves(t.target)).realQuote+protocol);
  });
  it('rejects zero-output 0x execution without spending payout funds', async () => {
    const [operator,holder]=await ethers.getSigners(); const q=await deploy('MockERC20','Q','Q'),stock=await deploy('MockERC20','S','S'),zx=await deploy('MockZeroEx'),router=await deploy('MockSwapRouter');
    const token=await deploy('LaunchToken','T','T',E('100'),18,operator.address); const v=await deploy('DividendVault',q.target,router.target,3000,[stock.target],[10000],['0x'],zx.target); await v.init(token.target,[],operator.address); await token.setDividendVault(v.target); await token.transfer(holder.address,E('100')); await q.mint(v.target,E('10'));
    const data=zx.interface.encodeFunctionData('swap',[q.target,E('10'),stock.target,0,operator.address]); await expect(v.distributeVia0x([E('10')],[data],[0])).to.be.reverted;
    expect(await q.balanceOf(v.target)).to.equal(E('10')); expect(await v.withdrawableOf(holder.address,stock.target)).to.equal(0);
  });
  it('rejects duplicate basket assets at creation', async () => {
    const [operator,holder,recipient]=await ethers.getSigners();
    const q=await deploy('MockERC20','Q','Q'),stock=await deploy('MockERC20','S','S'),router=await deploy('MockSwapRouter');
    const token=await deploy('LaunchToken','T','T',E('100'),18,operator.address);
    await expect(deploy('DividendVault',q.target,router.target,3000,[stock.target,stock.target],[5000,5000],['0x','0x'],ethers.ZeroAddress)).to.be.reverted;
  });
  it('rejects a route whose output differs from the configured payout asset', async () => {
    const [operator,holder]=await ethers.getSigners(); const q=await deploy('MockERC20','Q','Q'),stock=await deploy('MockERC20','S','S'),wrong=await deploy('MockERC20','X','X'),router=await deploy('MockSwapRouter');
    const token=await deploy('LaunchToken','T','T',E('100'),18,operator.address); const route=ethers.solidityPacked(['address','uint24','address'],[q.target,3000,wrong.target]);
    await expect(deploy('DividendVault',q.target,router.target,3000,[stock.target],[10000],[route],ethers.ZeroAddress)).to.be.reverted;
  });
});

describe('Bounded local workload (not mainnet throughput certification)', function() {
  this.timeout(240000);
  it('500 deterministic mixed buy/sell operations preserve normal-asset curve reserves', async () => {
    const s=await setup(false,'1000000'); const actors=[s.buyer,s.other,...s.users.slice(0,8)]; let maxGas=0n,seed=1729;
    const start=Date.now();
    for(let i=0;i<500;i++) {
      seed=(Math.imul(seed,1664525)+1013904223)>>>0; const who=actors[seed%actors.length]; const balance=await s.token.balanceOf(who.address); let tx;
      if(balance>1000n && seed%3===0) { const amount=balance/BigInt(2+seed%7); await s.token.connect(who).approve(s.curve.target,amount); const out=await s.curve.quoteSell(s.token.target,amount); tx=await s.curve.connect(who).sell(s.token.target,amount,out); }
      else { const amount=BigInt(1+seed%100)*10n**14n; const out=await s.curve.quoteBuy(s.token.target,amount); tx=await s.curve.connect(who).buyWithETH(s.token.target,out,{value:amount}); }
      const rc=await tx.wait(); if(rc.gasUsed>maxGas)maxGas=rc.gasUsed;
      const c=await s.curve.curves(s.token.target); expect(await s.weth.balanceOf(s.curve.target)).to.equal(c.realQuote); expect(await s.token.balanceOf(s.curve.target)).to.equal(c.tokenReserve); expect(c.virtualQuote-c.realQuote).to.equal(E('1.5'));
    }
    console.log(`      operations=500 actors=${actors.length} elapsedMs=${Date.now()-start} maxTradeGas=${maxGas}`);
  });
});
