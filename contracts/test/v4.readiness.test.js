// Component readiness tests. These do NOT exercise an integrated V4 launch factory/reward vault.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { deploy, deployHook, sqrt } = require('./helpers/v4');
const E = ethers.parseEther;
const MIN = 4295128740n;
const MAX = 1461446703485210103287273052203988822378723970341n;

async function fixture({ decimals = 18, reflection = 400, liveManager = false, taxedQuote = false, graduateLater = false } = {}) {
  const [owner, creator, rewards, ...actors] = await ethers.getSigners();
  const manager = liveManager
    ? await ethers.getContractAt('PoolManager','0x8366a39cc670b4001a1121b8f6a443a643e40951')
    : await deploy('PoolManager', owner.address);
  const graduator = await deploy('CensusV4Graduator',manager.target,owner.address,owner.address);
  const hook = await deployHook(manager.target,graduator.target,owner.address);
  await graduator.setHook(hook.target);
  // Fixed-supply production token, including a six-decimal quote variant.
  const coin = await deploy('LaunchToken','Readiness','READY',E('1000000000'),18,owner.address);
  const unit = 10n ** BigInt(decimals);
  const quote = taxedQuote ? await deploy('AuditQuote') : await deploy('LaunchToken','Quote','Q',1000000n*unit,decimals,owner.address);
  if (taxedQuote) await quote.mint(owner.address,1000000n*unit);
  const coin0 = BigInt(coin.target) < BigInt(quote.target);
  const coinAmount=E('214285714'), quoteAmount=4n*unit;
  const amount0=coin0?coinAmount:quoteAmount, amount1=coin0?quoteAmount:coinAmount;
  const key = {currency0:coin0?coin.target:quote.target,currency1:coin0?quote.target:coin.target,fee:0,tickSpacing:60,hooks:hook.target};
  await coin.approve(graduator.target,coinAmount);
  await quote.approve(graduator.target,quoteAmount);
  const now = (await ethers.provider.getBlock('latest')).timestamp;
  const graduation = {coin:coin.target,quote:quote.target,creator:creator.address,rewards:rewards.address,
    reflectionBps:reflection,launchedAt:now-10,coinAmount,quoteAmount,sqrtPriceX96:sqrt((amount1<<192n)/amount0)};
  if (!graduateLater) await graduator.graduate(graduation);
  const router=await deploy('CensusV4Router',manager.target,hook.target);
  const buy = (actor,amount=unit/10n) => ({key,zeroForOne:!coin0,amountIn:amount,minOut:1n,
    sqrtPriceLimitX96:coin0?MAX:MIN,recipient:actor.address,deadline:ethers.MaxUint256});
  for (const actor of actors.slice(0,10)) {
    await quote.transfer(actor.address,10n*unit);
    await coin.connect(actor).approve(router.target,ethers.MaxUint256);
    await quote.connect(actor).approve(router.target,ethers.MaxUint256);
  }
  return {owner,creator,rewards,actors,manager,graduator,hook,coin,quote,unit,key,coin0,router,buy,graduation};
}

describe('V4 readiness: realistic reserves and adversarial flows', function () {
  this.timeout(180000);
  it('executes the mandatory launch-second 99% fee and the three-second decay with reflections on top',async()=>{
    const f=await fixture({graduateLater:true}); const actor=f.actors[0];
    const start=(await ethers.provider.getBlock('latest')).timestamp+10;
    let graduationTx,buyTx;
    await network.provider.send('evm_setAutomine',[false]);
    try {
      await network.provider.send('evm_setNextBlockTimestamp',[start]);
      graduationTx=await f.graduator.graduate({...f.graduation,launchedAt:start},{gasLimit:6000000});
      buyTx=await f.router.connect(actor).swapExactInput(f.buy(actor),{gasLimit:1000000});
      await network.provider.send('evm_mine');
    } finally { await network.provider.send('evm_setAutomine',[true]); }
    const gradReceipt=await graduationTx.wait(), buyReceipt=await buyTx.wait();
    expect(gradReceipt.blockNumber).eq(buyReceipt.blockNumber);
    const readFee=r=>r.logs.map(l=>{try{return f.hook.interface.parseLog(l)}catch{return null}}).find(e=>e?.name==='FeeAccrued').args;
    const fees=[readFee(buyReceipt)];
    for(let second=1;second<=3;second++) {
      await network.provider.send('evm_setNextBlockTimestamp',[start+second]);
      fees.push(readFee(await(await f.router.connect(actor).swapExactInput(f.buy(actor))).wait()));
    }
    const totalRates=[9900n,1218n,619n,600n];
    for(let i=0;i<4;i++) {
      const fee=fees[i], gross=f.unit/10n;
      expect(fee.quoteVolume).eq(gross);
      expect(fee.protocolFee+fee.creatorFee+fee.holderFee).eq(gross*totalRates[i]/10000n);
      expect(fee.holderFee).eq(gross*400n/10000n);
    }
    expect(await f.quote.balanceOf(f.hook.target)).eq(await f.hook.totalReserved(f.quote.target));
  });

  for (const decimals of [6,18]) it(`graduates and trades a 1B fixed supply with ${decimals}-decimal quote`, async()=>{
    const f=await fixture({decimals});
    const a=f.actors[0];
    const coinBefore=await f.coin.balanceOf(a.address);
    const request=f.buy(a);
    const out=await f.router.connect(a).swapExactInput.staticCall(request);
    await f.router.connect(a).swapExactInput({...request,minOut:out});
    expect(await f.coin.balanceOf(a.address)-coinBefore).eq(out);
    expect(await f.hook.claimable(f.quote.target,f.owner.address)).eq(f.unit*6n/10000n);
    expect(await f.hook.claimable(f.quote.target,f.creator.address)).eq(f.unit*14n/10000n);
    expect(await f.hook.claimable(f.quote.target,f.rewards.address)).eq(f.unit*40n/10000n);
    await f.router.connect(a).swapExactInput({...request,zeroForOne:f.coin0,amountIn:out,sqrtPriceLimitX96:f.coin0?MIN:MAX});
    expect(await f.coin.balanceOf(a.address)).eq(coinBefore);
    expect(await f.coin.totalSupply()).eq(E('1000000000'));
    expect(await f.quote.balanceOf(f.hook.target)).eq(await f.hook.totalReserved(f.quote.target));
    expect(await f.coin.balanceOf(f.graduator.target)).eq(0);
    expect(await f.quote.balanceOf(f.graduator.target)).eq(0);
  });

  it('500 mixed swaps across 10 wallets preserve independently calculated fee liabilities and pool custody',async()=>{
    const f=await fixture();
    const expected=new Map([[f.owner.address,0n],[f.creator.address,0n],[f.rewards.address,0n]]);
    let maxGas=0n;
    const start=Date.now();
    for(let i=0;i<500;i++) {
      const actor=f.actors[i%10];
      const holding=await f.coin.balanceOf(actor.address);
      const sell=holding>0n && (Math.floor(i/10)%3!==0);
      const r=f.buy(actor,f.unit*BigInt(1+i%10)/100n);
      if(sell) Object.assign(r,{zeroForOne:f.coin0,amountIn:holding/2n,sqrtPriceLimitX96:f.coin0?MIN:MAX});
      const before=await f.quote.balanceOf(actor.address);
      const receipt=await(await f.router.connect(actor).swapExactInput(r)).wait();
      maxGas=receipt.gasUsed>maxGas?receipt.gasUsed:maxGas;
      const fee=receipt.logs.map(l=>{try{return f.hook.interface.parseLog(l)}catch{return null}}).find(e=>e?.name==='FeeAccrued').args;
      const gross=fee.quoteVolume;
      const total=gross*600n/10000n, holders=gross*400n/10000n;
      const protocol=(total-holders)*3000n/10000n, creator=total-holders-protocol;
      expect(fee.buy).eq(!sell);
      expect(fee.protocolFee).eq(protocol); expect(fee.creatorFee).eq(creator); expect(fee.holderFee).eq(holders);
      const after=await f.quote.balanceOf(actor.address);
      expect(sell?after-before:before-after).eq(sell?gross-total:gross);
      expected.set(f.owner.address,expected.get(f.owner.address)+protocol);
      expected.set(f.creator.address,expected.get(f.creator.address)+creator);
      expected.set(f.rewards.address,expected.get(f.rewards.address)+holders);
      if(i%25===24) {
        let liability=0n;
        for(const [recipient,owed] of expected) {
          expect(await f.hook.claimable(f.quote.target,recipient)).eq(owed); liability+=owed;
        }
        expect(await f.quote.balanceOf(f.hook.target)).eq(liability);
        expect(await f.hook.totalReserved(f.quote.target)).eq(liability);
        const beforeClaim=await f.quote.balanceOf(f.rewards.address);
        await f.hook.connect(actor).claimFor(f.quote.target,f.rewards.address);
        expect(await f.quote.balanceOf(f.rewards.address)-beforeClaim).eq(expected.get(f.rewards.address));
        expected.set(f.rewards.address,0n);
      }
    }
    for(const [recipient,owed] of expected) {
      const before=await f.quote.balanceOf(recipient);
      await f.hook.claimFor(f.quote.target,recipient);
      expect(await f.quote.balanceOf(recipient)-before).eq(owed);
    }
    expect(await f.hook.totalReserved(f.quote.target)).eq(0);
    expect(await f.quote.balanceOf(f.hook.target)).eq(0);
    for(const t of [f.coin,f.quote]) {
      let balance=0n;
      for(const address of [f.owner.address,f.creator.address,f.rewards.address,...f.actors.slice(0,10).map(a=>a.address),f.manager.target,f.hook.target,f.router.target,f.graduator.target]) balance+=await t.balanceOf(address);
      expect(balance).eq(await t.totalSupply());
    }
    console.log(`      V4 swaps=500 wallets=10 elapsedMs=${Date.now()-start} maxGas=${maxGas} (local sequential workload)`);
  });

  it('rolls back taxed deposits and isolates an unclaimable fee recipient',async()=>{
    const f=await fixture({taxedQuote:true}); const actor=f.actors[0];
    await f.router.connect(actor).swapExactInput(f.buy(actor));
    await f.quote.setBlocked(f.creator.address);
    await f.router.connect(actor).swapExactInput(f.buy(actor));
    const owed=await f.hook.claimable(f.quote.target,f.creator.address);
    await expect(f.hook.claimFor(f.quote.target,f.creator.address)).reverted;
    expect(await f.hook.claimable(f.quote.target,f.creator.address)).eq(owed);
    await f.hook.claimFor(f.quote.target,f.rewards.address);
    await f.quote.setTax(100);
    const actorBefore=await f.quote.balanceOf(actor.address), reserveBefore=await f.hook.totalReserved(f.quote.target);
    await expect(f.router.connect(actor).swapExactInput(f.buy(actor))).reverted;
    expect(await f.quote.balanceOf(actor.address)).eq(actorBefore);
    expect(await f.hook.totalReserved(f.quote.target)).eq(reserveBefore);
    await f.quote.setTax(0);
    await f.quote.setBlocked(ethers.ZeroAddress);
    await f.hook.claimFor(f.quote.target,f.creator.address);
    expect(await f.hook.claimable(f.quote.target,f.creator.address)).eq(0);
  });
});

const forkSuite=process.env.AUDIT_V4_FORK==='1'?describe:describe.skip;
forkSuite('V4 Robinhood fork: deployed PoolManager compatibility',function(){
  this.timeout(180000);
  it('registers a Census hook, graduates and swaps against the actual deployed manager on a LOCAL fork',async()=>{
    if(network.name!=='hardhat') throw Error('LOCAL HARDHAT ONLY');
    const rpc='https://rpc.mainnet.chain.robinhood.com';
    const response=await fetch(rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]}),signal:AbortSignal.timeout(15000)});
    const body=await response.json(); if(!body.result) throw Error('no fork block');
    const blockNumber=process.env.AUDIT_FORK_BLOCK?Number(process.env.AUDIT_FORK_BLOCK):Number(BigInt(body.result)); // pin with AUDIT_FORK_BLOCK for a reproducible run
    await network.provider.send('hardhat_reset',[{forking:{jsonRpcUrl:rpc,blockNumber}}]);
    const f=await fixture({liveManager:true}); const actor=f.actors[0];
    const out=await f.router.connect(actor).swapExactInput.staticCall(f.buy(actor));
    await f.router.connect(actor).swapExactInput({...f.buy(actor),minOut:out});
    await f.router.connect(actor).swapExactInput({...f.buy(actor),zeroForOne:f.coin0,amountIn:out,sqrtPriceLimitX96:f.coin0?MIN:MAX});
    expect(await f.coin.balanceOf(actor.address)).eq(0);
    expect(await f.quote.balanceOf(f.hook.target)).eq(await f.hook.totalReserved(f.quote.target));
    await f.hook.claimFor(f.quote.target,f.rewards.address);
    expect(await f.quote.balanceOf(f.rewards.address)).gt(0);
    console.log(`      V4 dependency block=${blockNumber}; deployments and trades LOCAL ONLY`);
  });
});
