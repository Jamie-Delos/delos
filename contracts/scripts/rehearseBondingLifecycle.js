// Repeatable local transactions against Census + actual Uniswap V3 bytecode. Never a public network.
// npx hardhat run scripts/rehearseBondingLifecycle.js --network hardhat
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ethers, network } = require('hardhat');
const UF = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
const NPM = require('@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json');
const ROUTER = require('@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json');
const E = ethers.parseEther, S = E('1000000000');
const number = x => Number(ethers.formatEther(x));
const findEvent = (rc,c,name) => rc.logs.map(l=>{try{return c.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name===name);
async function deploy(name,...args){const c=await(await ethers.getContractFactory(name)).deploy(...args);await c.waitForDeployment();return c;}
async function uni(artifact,signer,...args){const c=await new ethers.ContractFactory(artifact.abi,artifact.bytecode,signer).deploy(...args);await c.waitForDeployment();return c;}

async function runScenario(label,holdersBps){
  const [owner,platform,creator,alice,bob,carol,dave,keeper]=await ethers.getSigners();
  const people=[alice,bob,carol,dave], v2=holdersBps!==null;
  const weth=await deploy('WETH9'),uf=await uni(UF,owner);
  const npm=await uni(NPM,owner,uf.target,weth.target,ethers.ZeroAddress);
  const router=await uni(ROUTER,owner,ethers.ZeroAddress,uf.target,npm.target,weth.target);
  const locker=await deploy('LaunchLocker',npm.target,platform.address,2500);
  const curve=await deploy('CensusCurve',npm.target,platform.address,locker.target,weth.target,router.target);
  await locker.initFactory(curve.target); await curve.setKeeper(keeper.address);
  const factory=v2?await deploy('LaunchFactoryV2',weth.target,curve.target,router.target,3000,ethers.ZeroAddress):await deploy('LaunchFactory',weth.target,curve.target);
  await curve.setFactory(factory.target,true);
  const params=['Lifecycle demo','DEMO',S,18,10000,E('1.5'),E('4')];
  const launch=await(await(v2
    ?factory.connect(creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])'](params,[weth.target],[10000],['0x'],ethers.ZeroHash,weth.target,holdersBps,[])
    :factory.connect(creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32)'](params,ethers.ZeroHash))).wait();
  const le=findEvent(launch,factory,v2?'LaunchedV2':'Launched');
  const token=await ethers.getContractAt('LaunchToken',le.args.token);
  const vault=v2?await ethers.getContractAt('DividendVault',le.args.vault):null;
  const result={label,holdersBps,addresses:{token:token.target,curve:curve.target,vault:vault?.target??null},steps:[],claims:[],checks:[]};
  let pool=null,tokenId=null;
  async function capture(action,receipt,extra={}){
    const c=await curve.curves(token.target),x=await curve.virtualTokenOffset(token.target);
    let price;
    if(pool){const sqrt=(await pool.slot0())[0];const p=(Number(sqrt)/2**96)**2;price=BigInt(token.target)<BigInt(weth.target)?p:1/p;}
    else price=Number(c.virtualQuote)/Number(c.tokenReserve+x);
    const tracked=new Set([owner,platform,creator,...people,keeper].map(w=>w.address));
    for(const a of [curve.target,factory.target,locker.target,vault?.target,pool?.target])if(a)tracked.add(a);
    let accounted=0n;for(const a of tracked)accounted+=await token.balanceOf(a);
    assert.equal(accounted,S,'every real token remains accounted for');assert.equal(await token.totalSupply(),S);
    if(!pool){assert.equal(await token.balanceOf(curve.target),c.tokenReserve);assert.equal(await weth.balanceOf(curve.target),c.realQuote);}
    else{assert.equal(await npm.ownerOf(tokenId),locker.target);assert.equal(await token.balanceOf(curve.target),await curve.migrationTokenDust(token.target));}
    const row={action,phase:pool?'pool':'curve',txHash:receipt?.hash??null,block:receipt?.blockNumber??null,gasUsed:receipt?.gasUsed?.toString()??null,priceEthPerToken:price,fdvEth:price*1e9,
      curveQuoteEth:number(c.realQuote),poolQuoteEth:pool?number(await weth.balanceOf(pool.target)):null,
      tokensHeldByVenue:number(await token.balanceOf(pool?.target??curve.target)),...extra};
    result.steps.push(row);console.log(`${label}: ${action}; FDV ${row.fdvEth.toFixed(6)} ETH; ${row.phase} quote ${(row.poolQuoteEth??row.curveQuoteEth).toFixed(6)}`);
    return row;
  }
  await capture('Launch',launch);
  assert.equal(await token.maxWallet(), 0n);
  assert.equal(await token.maxBuy(), 0n);
  assert.equal(await curve.buyFeeBps(token.target, alice.address), 9900n);
  await network.provider.send('evm_increaseTime',[3]);
  await network.provider.send('evm_mine');
  assert.equal(await curve.buyFeeBps(token.target, alice.address), 200n);
  result.checks.push('No wallet/buy caps; launch fee starts at 99% and expires after three seconds');
  for(const who of people){await token.connect(who).approve(curve.target,ethers.MaxUint256);await token.connect(who).approve(router.target,ethers.MaxUint256);}

  async function curveBuy(who,value,title){
    const input=E(value),quoted=await curve.quoteBuy(token.target,input),before=await token.balanceOf(who.address);
    const recipients=[platform.address,creator.address,...(vault?[vault.target]:[])];
    const feeBefore=await Promise.all(recipients.map(a=>weth.balanceOf(a)));
    const nativeBefore=await ethers.provider.getBalance(who.address);
    const rc=await(await curve.connect(who).buyWithETH(token.target,quoted,{value:input})).wait();
    const ev=findEvent(rc,curve,'Traded'),refund=findEvent(rc,curve,'BuyRefunded')?.args.amount??0n;
    assert.equal(await token.balanceOf(who.address)-before,quoted);
    assert.equal(nativeBefore-await ethers.provider.getBalance(who.address),ev.args.amountIn+rc.fee);
    assert.equal(ev.args.amountIn+refund,input);
    const pf=ev.args.fee*2500n/10000n,side=ev.args.fee-pf,h=side*BigInt(holdersBps??0)/10000n;
    const expected=[pf,side-h,...(vault?[h]:[])];
    for(let i=0;i<recipients.length;i++)assert.equal(await weth.balanceOf(recipients[i])-feeBefore[i],expected[i]);
    return capture(title,rc,{submittedEth:number(input),acceptedEth:number(ev.args.amountIn),refundEth:number(refund),feeEth:number(ev.args.fee),tokenAmount:number(quoted)});
  }
  await curveBuy(alice,'1','Alice buys with 1 ETH');
  await curveBuy(bob,'0.75','Bob buys with 0.75 ETH');
  const selling=(await token.balanceOf(alice.address))/4n;
  const sellQuote=await curve.quoteSell(token.target,selling),wBefore=await weth.balanceOf(alice.address);
  const sellRc=await(await curve.connect(alice).sell(token.target,selling,sellQuote)).wait();
  assert.equal(await weth.balanceOf(alice.address)-wBefore,sellQuote);
  await capture('Alice sells 25% of her tokens',sellRc,{tokenAmount:number(selling),quoteReceivedEth:number(sellQuote),feeEth:number(findEvent(sellRc,curve,'Traded').args.fee)});
  await curveBuy(bob,'1.25','Bob buys with another 1.25 ETH');
  await assert.rejects(curve.graduate(token.target));result.checks.push('Premature graduation rejected');

  async function payRewards(stage){
    if(!vault)return;
    const available=await vault.availableQuote();assert.ok(available>0n);
    await(await vault.connect(keeper).distribute([0])).wait();
    let total=0n;
    for(const [i,who] of people.entries()){
      const owed=await vault.withdrawableOf(who.address,weth.target),before=await weth.balanceOf(who.address);
      const rc=await(await vault.connect(keeper).claimFor(who.address)).wait();
      assert.equal(await weth.balanceOf(who.address)-before,owed);
      assert.equal(await vault.withdrawableOf(who.address,weth.target),0n);
      result.claims.push({stage,holder:['Alice','Bob','Carol','Dave'][i],amountEth:number(owed),txHash:rc.hash});total+=owed;
    }
    assert.ok(await weth.balanceOf(vault.target)>=await vault.reserved(weth.target));
    result[stage+'RewardsPaidEth']=number(total);
  }
  await payRewards('curve');
  if(vault)assert.equal(await vault.withdrawableOf(carol.address,weth.target),0n);
  await curveBuy(carol,'10','Carol submits 10 ETH; final fill plus refund');
  assert.equal((await curve.curves(token.target)).realQuote,E('4'));
  assert.equal(await curve.maxQuoteIn(token.target),0n);
  await assert.rejects(curve.connect(dave).buyWithETH(token.target,0,{value:E('0.01')}));
  result.checks.push('Final buy stops at 4 ETH net and refunds excess; further curve buys rejected');
  if(vault)assert.equal(await vault.withdrawableOf(carol.address,weth.target),0n,'new buyer cannot claim earlier distributions');
  const beforeGrad=result.steps.at(-1).priceEthPerToken;
  const graduation=await(await curve.connect(dave).graduate(token.target)).wait(),ge=findEvent(graduation,curve,'Graduated');
  tokenId=ge.args.tokenId;
  pool=await ethers.getContractAt(['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)'],ge.args.pool);
  result.addresses.pool=pool.target;
  const grad=await capture('Graduation: liquidity deposited and NFT locked',graduation,{liquidityTokens:number(ge.args.tokensIn),liquidityQuoteEth:number(ge.args.quoteIn)});
  result.graduationPriceChangePct=(grad.priceEthPerToken/beforeGrad-1)*100;
  assert.ok(Math.abs(result.graduationPriceChangePct)<1e-10);
  await assert.rejects(curve.connect(alice).sell(token.target,1n,0));
  await assert.rejects(curve.connect(alice).buyWithETH(token.target,0,{value:1n}));
  await assert.rejects(curve.graduate(token.target));
  result.checks.push('Graduation preserves marginal price, locks LP NFT, disables curve trades and cannot repeat');

  async function poolTrade(who,buy,input,title){
    if(buy){await weth.connect(who).deposit({value:input});await weth.connect(who).approve(router.target,input);}
    const outputToken=buy?token:weth,before=await outputToken.balanceOf(who.address),oldPrice=result.steps.at(-1).priceEthPerToken;
    const args=[buy?weth.target:token.target,buy?token.target:weth.target,10000,who.address,input,1n,0];
    const expected=await router.connect(who).exactInputSingle.staticCall(args);args[5]=expected*99n/100n;
    const rc=await(await router.connect(who).exactInputSingle(args)).wait(),received=await outputToken.balanceOf(who.address)-before;
    assert.equal(received,expected);
    const row=await capture(title,rc,{inputAmount:number(input),outputAmount:number(received),poolFeePercent:1});
    assert.ok(buy?row.priceEthPerToken>oldPrice:row.priceEthPerToken<oldPrice);
  }
  await poolTrade(dave,true,E('0.25'),'Dave buys in pool with 0.25 ETH');
  await poolTrade(alice,false,(await token.balanceOf(alice.address))*30n/100n,'Alice sells 30% of remaining tokens in pool');
  await poolTrade(bob,true,E('0.6'),'Bob buys in pool with 0.6 ETH');
  await poolTrade(dave,false,(await token.balanceOf(dave.address))/2n,'Dave sells half his pool purchase');
  result.checks.push('Four real V3 swaps execute both ways; buys raise and sells lower the marginal price');

  const feeAssets=BigInt(token.target)<BigInt(weth.target)?[token,weth]:[weth,token];
  const amounts=await locker.collectFees.staticCall(tokenId),recipients=[platform.address,creator.address,...(vault?[vault.target]:[])];
  const before=await Promise.all(feeAssets.map(t=>Promise.all(recipients.map(a=>t.balanceOf(a)))));
  const collected=await(await locker.connect(keeper).collectFees(tokenId)).wait();
  for(let i=0;i<2;i++){
    assert.ok(amounts[i]>0n);
    const p=amounts[i]*2500n/10000n,side=amounts[i]-p,h=side*BigInt(holdersBps??0)/10000n,expected=[p,side-h,...(vault?[h]:[])];
    for(let j=0;j<recipients.length;j++)assert.equal(await feeAssets[i].balanceOf(recipients[j])-before[i][j],expected[j]);
  }
  result.collectedFees={quoteEth:number(amounts[feeAssets[0]===weth?0:1]),tokens:number(amounts[feeAssets[0]===token?0:1])};
  await capture('LP fees collected and split',collected);
  result.checks.push('Both LP fee assets split exactly: Census 25%, remaining 75% by holder allocation');
  if(vault){
    const tokenFees=await token.balanceOf(vault.target),quote=await vault.connect(keeper).convertLaunchFees.staticCall(tokenFees,10000,1);
    const rc=await(await vault.connect(keeper).convertLaunchFees(tokenFees,10000,quote*99n/100n)).wait();
    await capture('Holder token-fees converted to WETH',rc,{tokenAmount:number(tokenFees),quoteReceivedEth:number(quote)});
    await payRewards('afterGraduation');
    const owed=await vault.withdrawableOf(alice.address,weth.target);assert.equal(owed,0n);
    const before=await weth.balanceOf(alice.address);await vault.connect(keeper).claimFor(alice.address);assert.equal(await weth.balanceOf(alice.address),before);
    result.checks.push('Keeper converts token fees, distributes backed WETH, pushes rewards; repeated claim pays zero');
  }
  await capture('Final balances reconciled',null);
  result.checks.push('Supply remains exactly 1B and all tokens/reserves reconcile after every recorded stage');
  return result;
}

async function main(){
  if(network.name!=='hardhat')throw Error('Local Hardhat only; no public-network transactions permitted');
  await network.provider.send('hardhat_reset',[]); // local blank chain, even if shell configured a fork
  const implementation=execFileSync('git',['rev-parse','HEAD'],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8'}).trim();
  const report={date:new Date().toISOString(),network:'isolated local Hardhat (31337)',implementation,scenarios:[]};
  for(const [label,share] of [['Prima',null],['Maxima: all creator-side fees to holders',10000],['Maxima: creator/holders split equally',5000]])report.scenarios.push(await runScenario(label,share));
  const out=path.resolve(__dirname,'../../audit');
  fs.writeFileSync(path.join(out,'BONDING-LIFECYCLE-RESULTS.json'),JSON.stringify(report,null,2)+'\n');
  const fmt=n=>n==null?'—':n.toLocaleString('en-US',{maximumFractionDigits:6});
  const md=['# Bonding lifecycle rehearsal', '',`Executed ${report.date} against implementation ${report.implementation}.`,
    'All transactions used fake funds on an isolated local chain with actual Census and Uniswap V3 bytecode. No public-chain transactions.',
    'This tests contract behavior, not browser UX, live issuer assets, external routing, or production infrastructure.', '',
    'Each scenario uses 1B supply, 1.5 ETH virtual quote, 4 ETH net graduation target, a 2% curve fee, and a 1% pool fee. Rewards use WETH.',
    'Venue quote balances include uncollected LP fees after graduation. FDV is marginal spot price times 1B supply, not cash raised. Amounts below are rounded; JSON contains transaction hashes and more precision.',''];
  for(const s of report.scenarios){
    md.push(`## ${s.label}`,'','| Transaction / stage | Venue quote balance (ETH/WETH) | FDV (ETH) |','| --- | ---: | ---: |');
    for(const r of s.steps)md.push(`| ${r.action} | ${fmt(r.poolQuoteEth??r.curveQuoteEth)} | ${fmt(r.fdvEth)} |`);
    const final=s.steps.find(r=>r.refundEth>0);
    md.push('',`Final curve buy: ${fmt(final.acceptedEth)} ETH accepted, ${fmt(final.refundEth)} ETH returned. Graduation price change: ${s.graduationPriceChangePct.toExponential(3)}%.`,
      `LP fee collection: ${fmt(s.collectedFees.quoteEth)} WETH and ${fmt(s.collectedFees.tokens)} launch tokens.`,
      ...(s.holdersBps!==null?[`Rewards pushed: ${fmt(s.curveRewardsPaidEth)} WETH before graduation; ${fmt(s.afterGraduationRewardsPaidEth)} WETH in the later batch (includes the final curve buy plus collected LP revenue).`]:[]),'',...s.checks.map(c=>`- PASS: ${c}`),'');
  }
  md.push('## Interpretation','',
    'Graduation itself causes no material price jump. Subsequent buys and sells move the real pool price normally. A large holder sale has substantial price impact because the pool starts with only 4 ETH.',
    'After graduation the curve rejects trades; users must trade the pool. LP fees accrue in the position and are collected before the creator/platform/holder split is paid.',
    'Reward conversion is itself a pool sale and can move the price. A later reward batch includes fees accumulated since the preceding distribution, not just post-graduation trades.',
    'External-pool fee bypass and outstanding deployment/review gates are unchanged.','');
  fs.writeFileSync(path.join(out,'BONDING-LIFECYCLE-RESULTS.md'),md.join('\n'));
  console.log('ALL THREE BONDING LIFECYCLES PASSED');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
