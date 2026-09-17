const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const E = ethers.parseEther;
async function deploy(name, ...args) {
  const c = await (await ethers.getContractFactory(name)).deploy(...args); await c.waitForDeployment(); return c;
}
function event(receipt, contract, name) {
  return receipt.logs.map(log => { try { return contract.interface.parseLog(log); } catch { return null; } }).find(log => log?.name === name);
}
async function setup(maxima, bundle = false) {
  const [owner, platform, creator, buyer, other] = await ethers.getSigners();
  const weth = await deploy('MockWETH'), router = await deploy('MockSwapRouter');
  const curve = await deploy('CensusCurve', owner.address, platform.address, owner.address, weth.target, router.target);
  const factory = maxima ? await deploy('LaunchFactoryV2', weth.target, curve.target, router.target, 3000, ethers.ZeroAddress)
    : await deploy('LaunchFactory', weth.target, curve.target);
  await curve.setFactory(factory.target, true);
  // Pre-approve before launch so ERC20 buys can exercise the first seconds too.
  await weth.connect(buyer).deposit({value:E('20')}); await weth.connect(buyer).approve(curve.target,ethers.MaxUint256);
  const params = ['Early buy test', 'EARLY', E('1000000000'), 18, 10000, E('1.5'), E('4')];
  const signature = maxima ? 'createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])'
    : 'createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32,address,address[])';
  const args = maxima ? [params,[weth.target],[10000],['0x'],ethers.ZeroHash,weth.target,10000,bundle?[buyer.address]:[]]
    : [params,ethers.ZeroHash,weth.target,bundle?[buyer.address]:[]];
  const receipt = await (await factory.connect(creator)[signature](...args)).wait();
  const launch = event(receipt,factory,maxima?'LaunchedV2':'Launched');
  const token = await ethers.getContractAt('LaunchToken',launch.args.token);
  const launchedAt = Number(await curve.launchedAt(token.target));
  return {curve,token,buyer,creator,other,owner,platform,weth,factory,params,signature,args,launchedAt,
    vault:maxima?await ethers.getContractAt('DividendVault',launch.args.vault):null,receipt};
}
async function at(timestamp) { await network.provider.send('evm_setNextBlockTimestamp',[timestamp]); }
const feeAt = [9900n,818n,219n,200n];

for(const maxima of [false,true]) describe(`${maxima?'Maxima':'Prima'} three-second launch tax`,function(){
  it('quotes the exact decay, exempts the creator, and has no wallet or block caps',async()=>{
    const s=await setup(maxima); const {curve,token,buyer,creator}=s;
    expect(await token.maxWallet()).to.equal(0n); expect(await token.maxBuy()).to.equal(0n);
    expect(await token.restrictionEndBlock()).to.equal(0n);
    const initial=await curve.curves(token.target), offset=await curve.virtualTokenOffset(token.target);
    for(let second=0;second<=3;second++){
      if(second){await at(s.launchedAt+second);await network.provider.send('evm_mine');}
      expect(await curve.buyFeeBps(token.target,buyer.address)).to.equal(feeAt[second]);
      expect(await curve.buyFeeBps(token.target,creator.address)).to.equal(200n);
      const net=E('.1')-E('.1')*feeAt[second]/10000n;
      const expected=(initial.tokenReserve+offset)*net/(initial.virtualQuote+net);
      expect(await curve.quoteBuyFor(token.target,E('.1'),buyer.address)).to.equal(expected);
      expect(await curve.connect(buyer).quoteBuy(token.target,E('.1'))).to.equal(expected);
    }
    await curve.connect(buyer).buyWithETH(token.target,0,{value:E('.1')});
    expect(await token.balanceOf(buyer.address)).to.be.gt(E('20000000'));
  });

  for(const native of [true,false]) it(`executes a 0.1 ETH ${native?'native':'ERC20'} buy at t+1 with exact tax split`,async()=>{
    const s=await setup(maxima);const {curve,token,buyer,creator,platform,weth,vault}=s;
    const fee=E('.1')*818n/10000n, protocol=fee/4n;
    await at(s.launchedAt+1);
    const rc=await(await(native?curve.connect(buyer).buyWithETH(token.target,0,{value:E('.1')})
      :curve.connect(buyer).buy(token.target,E('.1'),0))).wait();
    expect(event(rc,curve,'Traded').args.fee).to.equal(fee);
    expect(event(rc,curve,'SnipeTaxCharged').args.amount).to.equal(fee-E('.002'));
    expect(await weth.balanceOf(platform.address)).to.equal(protocol);
    expect(await weth.balanceOf(vault?.target??creator.address)).to.equal(fee-protocol);
    expect((await curve.curves(token.target)).realQuote).to.equal(E('.1')-fee);
    expect(await token.balanceOf(buyer.address)).to.be.gt(E('20000000'));
    expect(await token.totalSupply()).to.equal(E('1000000000'));
  });

  it('supports same-block launch and non-exempt buy at 99%, then a sell at the normal 2%',async()=>{
    const s=await setup(maxima);
    const helper=await deploy('LaunchWindowHarness');
    const data=s.factory.interface.encodeFunctionData(s.signature,s.args);
    const rc=await(await helper.launchAndBuy(s.factory.target,data,s.curve.target,{value:E('.1')})).wait();
    const launched=event(rc,s.factory,maxima?'LaunchedV2':'Launched');
    const token=await ethers.getContractAt('LaunchToken',launched.args.token);
    const trade=event(rc,s.curve,'Traded');
    expect(trade.args.fee).to.equal(E('.099'));
    expect((await s.curve.curves(token.target)).realQuote).to.equal(E('.001'));
    expect(await token.balanceOf(await helper.buyer())).to.equal(trade.args.amountOut);
    const sold=await(await helper.sell(s.curve.target,token.target)).wait();
    const sell=event(sold,s.curve,'Traded');
    expect(sell.args.isBuy).to.equal(false);
    expect(sell.args.fee).to.equal((sell.args.amountOut+sell.args.fee)*200n/10000n);
    expect((await s.curve.curves(token.target)).realQuote).to.be.lte(1n);
  });

  it('refunds the oversized final fill during the taxed window and preserves minOut',async()=>{
    const s=await setup(maxima),input=E('10');
    await at(s.launchedAt+1);
    const rc=await(await s.curve.connect(s.buyer).buy(s.token.target,input,0)).wait();
    const traded=event(rc,s.curve,'Traded'),refund=event(rc,s.curve,'BuyRefunded');
    expect(traded.args.fee).to.equal(traded.args.amountIn*818n/10000n);
    expect(traded.args.amountIn+refund.args.amount).to.equal(input);
    expect((await s.curve.curves(s.token.target)).realQuote).to.equal(E('4'));
    expect(await s.weth.balanceOf(s.curve.target)).to.equal(E('4'));
    const state=await s.curve.curves(s.token.target);
    const recorded=[event(s.receipt,s.curve,'Registered'),traded];
    const fixture={coin:s.token.target,quote:s.weth.target,totalSupply:E('1000000000'),offset:await s.curve.virtualTokenOffset(s.token.target),
      state:{virtualQuote:state.virtualQuote,tokenReserve:state.tokenReserve,realQuote:state.realQuote},
      events:recorded.map(log=>({eventName:log.name,args:log.args.toObject(),encoded:s.curve.interface.encodeEventLog(log.fragment,log.args)}))};
    const fs=require('node:fs'),path=require('node:path'),dir=path.join(__dirname,'../.test-build');
    fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,`launch-tax-events-${maxima?'maxima':'prima'}.json`),
      JSON.stringify(fixture,(_,v)=>typeof v==='bigint'?v.toString():v));
    const t=await setup(maxima);await at(t.launchedAt+1);
    await expect(t.curve.connect(t.buyer).buyWithETH(t.token.target,E('1000000000'),{value:E('.1')}))
      .to.be.revertedWithCustomError(t.curve,'Slippage');
    expect((await t.curve.curves(t.token.target)).realQuote).to.equal(0n);
    expect(await t.weth.balanceOf(t.platform.address)).to.equal(0n);
  });

  it('freezes bundle exemptions at registration and prevents unauthorized registration',async()=>{
    const s=await setup(maxima,true);
    expect(await s.curve.buyFeeBps(s.token.target,s.buyer.address)).to.equal(200n);
    expect(await s.curve.buyFeeBps(s.token.target,s.other.address)).to.equal(9900n);
    await at(s.launchedAt+1);
    const rc=await(await s.curve.connect(s.buyer).buyWithETH(s.token.target,0,{value:E('.1')})).wait();
    expect(event(rc,s.curve,'Traded').args.fee).to.equal(E('.002'));
    await expect(s.curve.connect(s.buyer).registerWithExemptions(s.token.target,s.weth.target,s.creator.address,
      ethers.ZeroAddress,0,10000,E('1.5'),E('1000000000'),E('4'),[s.other.address]))
      .to.be.revertedWithCustomError(s.curve,'NotFactory');
    await s.curve.setFactory(s.owner.address,true);
    await expect(s.curve.registerWithExemptions(s.token.target,s.weth.target,s.creator.address,
      ethers.ZeroAddress,0,10000,E('1.5'),E('1000000000'),E('4'),[s.other.address]))
      .to.be.revertedWithCustomError(s.curve,'AlreadyRegistered');
  });

  it('executes at t+2 and t+3 using the decayed rate without a purchase allowance',async()=>{
    const s=await setup(maxima);
    for(const second of [2,3]){
      await at(s.launchedAt+second);
      const rc=await(await s.curve.connect(s.buyer).buyWithETH(s.token.target,0,{value:E('.1')})).wait();
      expect(event(rc,s.curve,'Traded').args.fee).to.equal(E('.1')*feeAt[second]/10000n);
    }
    expect(await s.token.balanceOf(s.buyer.address)).to.be.gt(E('100000000'));
  });

  it('caps and refunds even a launch-second buy at the 99% rate',async()=>{
    const s=await setup(maxima),helper=await deploy('LaunchWindowHarness');
    const rc=await(await helper.launchAndBuy(s.factory.target,s.factory.interface.encodeFunctionData(s.signature,s.args),s.curve.target,{value:E('500')})).wait();
    const launch=event(rc,s.factory,maxima?'LaunchedV2':'Launched'),trade=event(rc,s.curve,'Traded'),refund=event(rc,s.curve,'BuyRefunded');
    expect(trade.args.amountIn).to.equal(E('400'));
    expect(trade.args.fee).to.equal(E('396'));
    expect(refund.args.amount).to.equal(E('100'));
    expect((await s.curve.curves(launch.args.token)).realQuote).to.equal(E('4'));
    expect(await ethers.provider.getBalance(await helper.buyer())).to.equal(E('100'));
  });
});
