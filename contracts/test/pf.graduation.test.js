const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const fs = require('node:fs');
const path = require('node:path');
const E = ethers.parseEther, S = E('1000000000');
const UF = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
const NPM = require('@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json');
const ROUTER = require('@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json');
const event = (rc, c, name) => rc.logs.map(l => { try { return c.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === name);
async function deploy(name, ...args) { const c = await (await ethers.getContractFactory(name)).deploy(...args); await c.waitForDeployment(); return c; }
async function uni(a, signer, ...args) { const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args); await c.waitForDeployment(); return c; }
async function setup(v2 = false, V = E('1.5'), G = E('4')) {
  const [owner, platform, creator, buyer, other] = await ethers.getSigners();
  const weth = await deploy('WETH9'), uf = await uni(UF, owner);
  const npm = await uni(NPM, owner, uf.target, weth.target, ethers.ZeroAddress);
  const router = await uni(ROUTER, owner, ethers.ZeroAddress, uf.target, npm.target, weth.target);
  const locker = await deploy('LaunchLocker', npm.target, platform.address, 2500);
  const curve = await deploy('CensusCurve', npm.target, platform.address, locker.target, weth.target, router.target);
  await locker.initFactory(curve.target);
  const factory = v2 ? await deploy('LaunchFactoryV2', weth.target, curve.target, router.target, 3000, ethers.ZeroAddress) : await deploy('LaunchFactory', weth.target, curve.target);
  await curve.setFactory(factory.target, true);
  const p = ['PF test', 'PFT', S, 18, 10000, V, G];
  const rc = await (await (v2
    ? factory.connect(creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),address[],uint16[],bytes[],bytes32)'](p, [weth.target], [10000], ['0x'], ethers.ZeroHash)
    : factory.connect(creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32)'](p, ethers.ZeroHash))).wait();
  const token = await ethers.getContractAt('LaunchToken', event(rc, factory, v2 ? 'LaunchedV2' : 'Launched').args.token);
  await network.provider.send('hardhat_mine', ['0x65']);
  return { owner, platform, creator, buyer, other, weth, uf, npm, router, locker, curve, factory, token, V, G, registration: event(rc, curve, 'Registered') };
}
async function continuity(s) {
  const c = await s.curve.curves(s.token.target), x = await s.curve.virtualTokenOffset(s.token.target);
  expect(c.realQuote).to.equal(s.G);
  const rc = await (await s.curve.graduate(s.token.target)).wait(), ge = event(rc, s.curve, 'Graduated');
  const pool = await ethers.getContractAt(['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)'], ge.args.pool);
  const r = (await pool.slot0())[0], Q192 = 1n << 192n;
  const first = BigInt(s.token.target) < BigInt(s.weth.target);
  // Independent cross multiplication of curve marginal price and actual V3 sqrt price.
  const a = (first ? r*r : Q192) * (c.tokenReserve + x);
  const b = (first ? Q192 : r*r) * c.virtualQuote;
  expect((a > b ? a-b : b-a) * 10n**15n).to.be.lte(b);
  expect(await s.token.totalSupply()).to.equal(S);
  expect(await s.token.balanceOf(ethers.ZeroAddress)).to.equal(0);
  expect(await s.npm.ownerOf(ge.args.tokenId)).to.equal(s.locker.target);
  // V3's finite full-range bounds/rounding leave tiny tracked, sweepable dust, not an economic reserve.
  expect(await s.curve.migrationTokenDust(s.token.target)).to.be.lt(S / 10n**12n);
  expect(ge.args.tokensIn + await s.curve.migrationTokenDust(s.token.target)).to.equal(c.tokenReserve);
  expect(ge.args.quoteIn + await s.curve.migrationQuoteDust(s.token.target)).to.equal(c.realQuote);
  return { c, ge };
}
describe('PF virtual-token graduation', function () {
  this.timeout(240000);
  for (const v2 of [false, true]) it(`${v2 ? 'Maxima' : 'Prima'}: 1B real supply, formula-only offset, partial fill and continuous pool price`, async () => {
    const s = await setup(v2), x = await s.curve.virtualTokenOffset(s.token.target);
    const rationalFloor = S*s.V*s.V/(s.G*(s.G+2n*s.V));
    expect(x).to.be.closeTo(rationalFloor, 1n);
    expect(s.registration.args.virtualTokenOffset).to.equal(x);
    expect(await s.token.balanceOf(s.curve.target)).to.equal(S);
    const limit = await s.curve.maxQuoteIn(s.token.target), input = E('10');
    const quoted = await s.curve.quoteBuy(s.token.target, input);
    expect(quoted).to.equal(await s.curve.quoteBuy(s.token.target, limit));
    const before = await ethers.provider.getBalance(s.buyer.address);
    const rc = await (await s.curve.connect(s.buyer).buyWithETH(s.token.target, quoted, { value: input })).wait();
    expect(before - await ethers.provider.getBalance(s.buyer.address)).to.equal(limit + rc.fee);
    expect(event(rc,s.curve,'Traded').args.amountIn).to.equal(limit);
    expect(event(rc,s.curve,'BuyRefunded').args.amount).to.equal(input-limit);
    expect(await s.token.balanceOf(s.buyer.address)).to.equal(quoted);
    expect(await s.weth.balanceOf(s.curve.target)).to.equal(s.G);
    expect(await s.curve.maxQuoteIn(s.token.target)).to.equal(0);
    expect(await s.curve.quoteBuy(s.token.target, E('1'))).to.equal(0);
    await expect(s.curve.connect(s.other).buyWithETH(s.token.target, 0, {value: 1n})).to.be.revertedWithCustomError(s.curve, 'CurveFilled');
    const { c } = await continuity(s);
    expect(Number(c.tokenReserve)/Number(S)).to.be.closeTo(3/14, 1e-12);
  });

  it('refunds excess ERC20 input, charges only accepted input, and respects minOut atomically', async () => {
    const s=await setup(), input=E('10');
    await s.weth.connect(s.buyer).deposit({value:input});
    await s.weth.connect(s.buyer).approve(s.curve.target,input);
    const q=await s.curve.quoteBuy(s.token.target,input), limit=await s.curve.maxQuoteIn(s.token.target);
    await expect(s.curve.connect(s.buyer).buy(s.token.target,input,q+1n)).to.be.revertedWithCustomError(s.curve,'Slippage');
    expect(await s.weth.balanceOf(s.buyer.address)).to.equal(input);
    expect((await s.curve.curves(s.token.target)).realQuote).to.equal(0);
    const rc=await(await s.curve.connect(s.buyer).buy(s.token.target,input,q)).wait();
    expect(await s.weth.balanceOf(s.buyer.address)).to.equal(input-limit);
    expect(event(rc,s.curve,'Traded').args.fee).to.equal(limit*200n/10000n);
    expect(event(rc,s.curve,'BuyRefunded').args.nativeRefund).to.equal(false);
    await continuity(s);
  });

  it('fills the final quote wei exactly, and a sell reopens the filled curve safely', async () => {
    const s=await setup();
    const gross=((s.G-1n)*10000n)/9800n;
    await s.curve.connect(s.buyer).buyWithETH(s.token.target,0,{value:gross});
    expect((await s.curve.curves(s.token.target)).realQuote).to.equal(s.G-1n);
    expect(await s.curve.maxQuoteIn(s.token.target)).to.equal(1);
    await s.curve.connect(s.other).buyWithETH(s.token.target,0,{value:E('1')});
    expect((await s.curve.curves(s.token.target)).realQuote).to.equal(s.G);
    const sell=(await s.token.balanceOf(s.buyer.address))/20n;
    await s.token.connect(s.buyer).approve(s.curve.target,sell);
    const out=await s.curve.quoteSell(s.token.target,sell);
    const rc=await(await s.curve.connect(s.buyer).sell(s.token.target,sell,out)).wait();
    expect(event(rc,s.curve,'Traded').args.amountOut).to.equal(out);
    expect(await s.curve.maxQuoteIn(s.token.target)).to.be.gt(0);
    await s.curve.connect(s.other).buyWithETH(s.token.target,0,{value:E('10')});
    await continuity(s);
  });

  for (const [v,g] of [['0.5','4'],['1.5','10'],['3','4']]) it(`derives allocations for V=${v}, G=${g} rather than hardcoding 786M/214M`, async()=>{
    const s=await setup(false,E(v),E(g));
    await s.curve.connect(s.buyer).buyWithETH(s.token.target,0,{value:E('20')});
    const c=await s.curve.curves(s.token.target);
    // Analytic pool token fraction V0/(G+2*V0).
    expect(c.tokenReserve).to.be.closeTo(S*s.V/(s.G+2n*s.V),3n);
    await continuity(s);
  });

  it('mixed buys/sells match an independent integer model and export actual events for indexer parity', async()=>{
    const s=await setup();
    let q=s.V, t=S, real=0n, balance=0n;
    const x=await s.curve.virtualTokenOffset(s.token.target), logs=[s.registration];
    await s.token.connect(s.buyer).approve(s.curve.target,ethers.MaxUint256);
    let seed=123456789n;
    for(let i=0;i<120;i++){
      seed=(seed*1664525n+1013904223n)&0xffffffffn;
      const oldK=q*(t+x);
      let rc;
      if(i%3===2 && balance>0n){
        const input=balance/BigInt(4+Number(seed%12n));
        const gross=q*input/(t+x+input), net=gross-gross*200n/10000n;
        expect(await s.curve.quoteSell(s.token.target,input)).to.equal(net);
        rc=await(await s.curve.connect(s.buyer).sell(s.token.target,input,net)).wait();
        q-=gross;real-=gross;t+=input;balance-=input;
      }else{
        const input=E('0.001')*(1n+seed%25n), net=input-input*200n/10000n;
        const output=(t+x)*net/(q+net);
        expect(await s.curve.quoteBuy(s.token.target,input)).to.equal(output);
        rc=await(await s.curve.connect(s.buyer).buyWithETH(s.token.target,output,{value:input})).wait();
        q+=net;real+=net;t-=output;balance+=output;
      }
      logs.push(event(rc,s.curve,'Traded'));
      const c=await s.curve.curves(s.token.target);
      expect([c.virtualQuote,c.tokenReserve,c.realQuote]).to.deep.equal([q,t,real]);
      expect(q*(t+x)).to.be.gte(oldK);
      expect(await s.weth.balanceOf(s.curve.target)).to.equal(real);
      expect(await s.token.balanceOf(s.buyer.address)).to.equal(balance);
    }
    const rc=await(await s.curve.connect(s.other).buyWithETH(s.token.target,0,{value:E('20')})).wait();
    logs.push(event(rc,s.curve,'Traded'));
    const c=await s.curve.curves(s.token.target);
    // Consumed by indexer/pf.parity.cjs: decoded REAL contract events, including clipped input.
    const fixture={coin:s.token.target,quote:s.weth.target,totalSupply:S,offset:x,state:{virtualQuote:c.virtualQuote,tokenReserve:c.tokenReserve,realQuote:c.realQuote},events:logs.map(l=>({eventName:l.name,args:l.args.toObject(),encoded:s.curve.interface.encodeEventLog(l.fragment,l.args)}))};
    const dir=path.join(__dirname,'../.test-build');fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'pf-events.json'),JSON.stringify(fixture,(_,v)=>typeof v==='bigint'?v.toString():v));
    await continuity(s);
  });

  it('supports a six-decimal quote without treating virtual tokens as real supply', async()=>{
    const s=await setup();
    const q=await deploy('LaunchToken','Six-decimal quote','Q6',1000000000n,6,s.owner.address);
    const token=await deploy('LaunchToken','Six-decimal pair','PAIR',S,18,s.curve.target);
    await s.curve.setFactory(s.owner.address,true);
    await s.curve.setQuoteAllowed(q.target,true);
    const V=1500000n,G=4000000n;
    await s.curve.register(token.target,q.target,s.creator.address,ethers.ZeroAddress,0,10000,V,S,G);
    await q.transfer(s.buyer.address,10000000n);
    await q.connect(s.buyer).approve(s.curve.target,10000000n);
    await s.curve.connect(s.buyer).buy(token.target,10000000n,0);
    expect(await q.balanceOf(s.buyer.address)).to.equal(10000000n-4000000n*10000n/9800n);
    await continuity({...s,weth:q,token,V,G});
  });
});
