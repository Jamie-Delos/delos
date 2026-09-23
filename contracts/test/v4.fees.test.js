const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const E = ethers.parseEther;
const MIN = 4295128740n;
const MAX = 1461446703485210103287273052203988822378723970341n;
const { deploy, deployHook } = require('./helpers/v4');
describe('V4 fee migration', function () {
  this.timeout(180000);
  it('creates a permanently custodied pool, rejects unauthorized graduation and swaps after graduation', async () => {
    const [owner, curve, creator, trader] = await ethers.getSigners();
    const manager = await deploy('PoolManager',owner.address);
    const graduator = await deploy('CensusV4Graduator',manager.target,curve.address,owner.address);
    const hook = await deployHook(manager.target,graduator.target,owner.address);
    await graduator.setHook(hook.target);
    await expect(graduator.setHook(hook.target)).revertedWithCustomError(graduator,'Unauthorized');
    const coin = await deploy('MockERC20','Coin','COIN'), quote = await deploy('MockERC20','Quote','Q');
    for (const t of [coin,quote]) {
      await t.mint(curve.address,E('1000'));
      await t.connect(curve).approve(graduator.target,ethers.MaxUint256);
    }
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    const g = {coin:coin.target,quote:quote.target,creator:creator.address,rewards:ethers.ZeroAddress,
      reflectionBps:0,launchedAt:now-10,coinAmount:E('1000'),quoteAmount:E('1000'),sqrtPriceX96:2n**96n};
    await expect(graduator.connect(trader).graduate(g)).revertedWithCustomError(graduator,'Unauthorized');
    const coin0 = BigInt(coin.target) < BigInt(quote.target);
    const key = {currency0:coin0?coin.target:quote.target,currency1:coin0?quote.target:coin.target,fee:0,tickSpacing:60,hooks:hook.target};
    await expect(manager.connect(trader).initialize(key,2n**96n)).reverted;
    // A price/reserve mismatch must roll back registration, custody and initialization together.
    await expect(graduator.connect(curve).graduate({...g,quoteAmount:E('500')})).revertedWithCustomError(graduator,'InvalidReserves');
    expect(await graduator.graduated(coin.target)).eq(false);
    expect(await coin.balanceOf(curve.address)).eq(E('1000'));
    await graduator.connect(curve).graduate(g);
    expect(await graduator.graduated(coin.target)).eq(true);
    expect(await graduator.lockedLiquidity(coin.target)).gt(0);
    for (const t of [coin,quote]) {
      expect(await t.balanceOf(graduator.target)).eq(0);
      expect(await t.balanceOf(manager.target)+await t.balanceOf(curve.address)).eq(E('1000'));
      expect(await t.balanceOf(manager.target)).gte(E('999.9'));
    }
    await expect(graduator.connect(curve).graduate(g)).revertedWithCustomError(graduator,'InvalidConfiguration');
    await expect(graduator.unlockCallback('0x')).revertedWithCustomError(graduator,'Unauthorized');
    const router = await deploy('CensusV4Router',manager.target,hook.target);
    await quote.mint(trader.address,E('1'));
    await quote.connect(trader).approve(router.target,ethers.MaxUint256);
    const buy = {key,zeroForOne:!coin0,amountIn:E('0.1'),minOut:1,sqrtPriceLimitX96:coin0?MAX:MIN,recipient:trader.address,deadline:ethers.MaxUint256};
    await router.connect(trader).swapExactInput(buy);
    expect(await hook.claimable(quote.target,owner.address)).eq(E('0.0006'));
    expect(await hook.claimable(quote.target,creator.address)).eq(E('0.0014'));
    await coin.connect(trader).approve(router.target,ethers.MaxUint256);
    await router.connect(trader).swapExactInput({...buy,zeroForOne:coin0,amountIn:await coin.balanceOf(trader.address),sqrtPriceLimitX96:coin0?MIN:MAX});
    expect(await coin.balanceOf(trader.address)).eq(0);
    expect(await quote.balanceOf(hook.target)).eq(await hook.totalReserved(quote.target));
  });

  it('preserves fee conservation at every tax rate, phase and launch second', async () => {
    const math = await deploy('CensusFeeMathHarness');
    for (const reflection of [0,100,200,300,400]) for (const elapsed of [0,1,2,3,100]) {
      for (const graduated of [false,true]) for (const buy of [false,true]) {
        const f = await math.calculate(E('100'),reflection,elapsed,buy,graduated);
        expect(f.protocol + f.creator + f.holders).eq(f.total);
        expect(f.holders).eq(E('100') * BigInt(reflection) / 10000n);
        expect(f.total).lte(E('99'));
        expect(f.protocol).eq((f.total-f.holders)*BigInt(graduated?3000:9000)/10000n);
        if (!buy || elapsed >= 3) expect(f.total).eq(E('2')+f.holders);
      }
    }
    for (const amount of [1n,17n,99n,100n,501n,123456789n]) {
      const f = await math.calculate(amount,333,3,true,false);
      expect(f.protocol+f.creator+f.holders).eq(f.total);
      expect(f.total).lte(amount);
    }
    await expect(math.calculate(10000,99,3,true,false)).revertedWithCustomError(math,'InvalidReflection');
    await expect(math.calculate(10000,401,3,true,false)).revertedWithCustomError(math,'InvalidReflection');
  });

  for (const quoteFirst of [true,false]) it(`enforces 2% + 4% with real V4, both directions and two routers; quoteFirst=${quoteFirst}`, async () => {
    const [owner, creator, holders, trader, stranger] = await ethers.getSigners();
    const manager = await deploy('PoolManager',owner.address);
    const hook = await deployHook(manager.target,owner.address,owner.address);
    const a = await deploy('MockERC20','A','A'), b = await deploy('MockERC20','B','B');
    const sorted = [a,b].sort((x,y)=>BigInt(x.target)<BigInt(y.target)?-1:1);
    const quote = sorted[quoteFirst?0:1], coin = sorted[quoteFirst?1:0];
    const key = {currency0:sorted[0].target,currency1:sorted[1].target,fee:0,tickSpacing:60,hooks:hook.target};
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    await expect(hook.connect(stranger).register(key,quote.target,creator.address,holders.address,400,now-10)).revertedWithCustomError(hook,'Unauthorized');
    await hook.register(key,quote.target,creator.address,holders.address,400,now-10);
    await expect(manager.connect(stranger).initialize(key,2n**96n)).reverted;
    await manager.initialize(key,2n**96n);
    const lp = await deploy('PoolModifyLiquidityTest',manager.target);
    const routers = [await deploy('PoolSwapTest',manager.target),await deploy('PoolSwapTest',manager.target)];
    for (const t of sorted) {
      await t.mint(owner.address,E('100000')); await t.approve(lp.target,ethers.MaxUint256);
      await t.mint(trader.address,E('1000'));
      for (const r of routers) await t.connect(trader).approve(r.target,ethers.MaxUint256);
    }
    await lp['modifyLiquidity((address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes)'](key,{tickLower:-887220,tickUpper:887220,liquidityDelta:E('10000'),salt:ethers.ZeroHash},'0x');
    for (const r of routers) {
      const before = await hook.claimable(quote.target,owner.address);
      await r.connect(trader).swap(key,{zeroForOne:quoteFirst,amountSpecified:-E('100'),sqrtPriceLimitX96:quoteFirst?MIN:MAX},{takeClaims:false,settleUsingBurn:false},'0x');
      expect(await hook.claimable(quote.target,owner.address)-before).eq(E('0.6'));
      const receipt = await (await r.connect(trader).swap(key,{zeroForOne:!quoteFirst,amountSpecified:-E('20'),sqrtPriceLimitX96:!quoteFirst?MIN:MAX},{takeClaims:false,settleUsingBurn:false},'0x')).wait();
      const e = receipt.logs.map(l=>{try{return hook.interface.parseLog(l)}catch{return null}}).find(e=>e?.name==='FeeAccrued');
      expect(e.args.buy).eq(false);
      expect(e.args.holderFee).eq(e.args.quoteVolume*400n/10000n);
      expect(e.args.protocolFee+e.args.creatorFee+e.args.holderFee).eq(e.args.quoteVolume*600n/10000n);
    }
    const liabilities = await hook.totalReserved(quote.target);
    expect(await quote.balanceOf(hook.target)).eq(liabilities);
    const owed = await hook.claimable(quote.target,holders.address);
    await hook.connect(stranger).claimFor(quote.target,holders.address);
    expect(await quote.balanceOf(holders.address)).eq(owed);
    expect(await quote.balanceOf(hook.target)).eq(await hook.totalReserved(quote.target));
    await expect(routers[0].connect(trader).swap(key,{zeroForOne:quoteFirst,amountSpecified:E('1'),sqrtPriceLimitX96:quoteFirst?MIN:MAX},{takeClaims:false,settleUsingBurn:false},'0x')).reverted;
    await expect(hook.beforeSwap(owner.address,key,{zeroForOne:quoteFirst,amountSpecified:-E('1'),sqrtPriceLimitX96:quoteFirst?MIN:MAX},'0x')).revertedWithCustomError(hook,'Unauthorized');

    const router = await deploy('CensusV4Router',manager.target,hook.target);
    for (const t of sorted) await t.connect(trader).approve(router.target,ethers.MaxUint256);
    const request = {key,zeroForOne:quoteFirst,amountIn:E('0.1'),minOut:1n,
      sqrtPriceLimitX96:quoteFirst?MIN:MAX,recipient:trader.address,deadline:ethers.MaxUint256};
    const balances = [await quote.balanceOf(trader.address), await coin.balanceOf(trader.address)];
    const out = await router.connect(trader).swapExactInput.staticCall(request);
    await router.connect(trader).swapExactInput({...request,minOut:out});
    expect(balances[0]-await quote.balanceOf(trader.address)).eq(E('0.1'));
    expect(await coin.balanceOf(trader.address)-balances[1]).eq(out);
    const sell = {...request,zeroForOne:!quoteFirst,amountIn:out,sqrtPriceLimitX96:quoteFirst?MAX:MIN};
    const sellOut = await router.connect(trader).swapExactInput.staticCall(sell);
    const beforeSell = await quote.balanceOf(trader.address);
    await router.connect(trader).swapExactInput({...sell,minOut:sellOut});
    expect(await quote.balanceOf(trader.address)-beforeSell).eq(sellOut);
    const beforeFailed = await quote.balanceOf(trader.address);
    const reservedBefore = await hook.totalReserved(quote.target);
    await expect(router.connect(trader).swapExactInput({...request,minOut:E('100000')})).revertedWithCustomError(router,'Slippage');
    expect(await quote.balanceOf(trader.address)).eq(beforeFailed);
    expect(await hook.totalReserved(quote.target)).eq(reservedBefore);
    await expect(router.connect(trader).swapExactInput({...request,deadline:1})).revertedWithCustomError(router,'InvalidRequest');
    await expect(router.connect(trader).swapExactInput({...request,minOut:0})).revertedWithCustomError(router,'InvalidRequest');
    await expect(router.connect(stranger).unlockCallback('0x')).revertedWithCustomError(router,'UnauthorizedCallback');
    expect(await quote.balanceOf(router.target)).eq(0);
    expect(await coin.balanceOf(router.target)).eq(0);

    // Liveness: a Uniswap governance protocol fee (max 0.1%) never halts trading; the Census fee is
    // still charged in full on the specified input and the ledger stays exact.
    await manager.setProtocolFeeController(owner.address);
    await manager.setProtocolFee(key,1000 | (1000 << 12));
    const withProtocolFee = await (await router.connect(trader).swapExactInput(request)).wait();
    const accrued = withProtocolFee.logs.map(l=>{try{return hook.interface.parseLog(l)}catch{return null}}).find(e=>e?.name==='FeeAccrued').args;
    expect(accrued.quoteVolume).eq(request.amountIn);
    expect(accrued.protocolFee+accrued.creatorFee+accrued.holderFee).eq(request.amountIn*600n/10000n);
    expect(await quote.balanceOf(hook.target)).eq(await hook.totalReserved(quote.target));
    await manager.setProtocolFee(key,0);
    await router.connect(trader).swapExactInput(request);
  });
});
