const path=require('node:path');
// Actual API and ingestion source; isolated adapters test failure boundaries, not Postgres itself.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const {EventEmitter}=require('node:events');
function code(file,tail='') {return ts.transpileModule(fs.readFileSync(__dirname+'/src/'+file,'utf8').replace(/^import .*;\r?$/gm,'')+tail,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;}
// GeckoTerminal routes (src/geckoterminal.ts) loaded like the API, with the RPC and metadata fetches stubbed.
function gtModule(overrides={}){const viem=require('viem');const g={exports:{},console:{log(){}},getAddress:viem.getAddress,formatUnits:viem.formatUnits,isAddress:viem.isAddress,createPublicClient:()=>{throw Error('no rpc in tests');},http:()=>({}),defineChain:x=>x,fetch:async()=>({ok:false}),AbortSignal};vm.runInNewContext(code('geckoterminal.ts'),g);return{registerGeckoTerminalRoutes:g.exports.registerGeckoTerminalRoutes,defaultGtDeps:(b)=>({...g.exports.defaultGtDeps(b),getBlockTimestamp:async(n)=>1700000000+Number(n),readErc20:async(a)=>a.toLowerCase()==='0x'+'ee'.repeat(20)?{name:'Wrapped Ether',symbol:'WETH',decimals:18,totalSupply:10n**21n}:null,fetchMetadata:async(a)=>({image:'https://img.test/'+a+'.png',description:'A test coin'}),...overrides})};}
const GT_CFG={gtDexKey:'delos',gtMetadataUrl:'https://site.test',gtMaxSpan:1000,gtPrefix:'/geckoterminal',rpcUrl:'http://unused'};
async function apiChecks(){
  const app=require('fastify')({logger:false});app.listen=async()=>{};
  const ingestion={lastSuccessAt:0,lastBlock:null,error:'starting'};
  let failDb=false,chartQuery;
  const context={exports:{},console:{log(){}},...gtModule(),Fastify:()=>app,cors:require('@fastify/cors'),websocket:require('@fastify/websocket'),rateLimit:require('@fastify/rate-limit'),registerSocialRoutes:()=>{},cfg:{chainId:1,curve:'0xcurve',corsOrigin:'*',port:0,pollMs:4000,...GT_CFG},bus:new EventEmitter(),serializeCoin:x=>x,ingestion,
    prisma:{$queryRaw:async()=>{if(failDb)throw Error('offline');},coin:{findMany:async()=>[]},pricePoint:{findMany:async(q)=>{chartQuery=q;return[{ts:3,priceQuote:3},{ts:2,priceQuote:2}];}}}};
  vm.runInNewContext(code('api.ts'),context);await context.exports.runApi();
  try{
    for(const limit of ['abc','0','-1','1.5','201','Infinity'])assert.equal((await app.inject('/coins?limit='+limit)).statusCode,400);
    assert.equal((await app.inject('/coins?graduated=invalid')).statusCode,400);
    assert.equal((await app.inject('/health')).statusCode,503);
    ingestion.lastSuccessAt=Date.now();ingestion.error=null;
    assert.equal((await app.inject('/health')).statusCode,200);
    failDb=true;assert.equal((await app.inject('/health')).statusCode,503);failDb=false;
    const chart=(await app.inject('/coins/0xcoin/chart?limit=2')).json();
    assert.deepEqual(chart.points.map(p=>p.t),[2,3]);assert.equal(chartQuery.orderBy[0].ts,'desc');
    let failures=0;const start=Date.now();
    for(let i=0;i<20;i++)await Promise.all(Array.from({length:50},async(_,j)=>{const r=await app.inject({url:'/coins',remoteAddress:`10.0.0.${j+1}`});if(r.statusCode!==200)failures++;}));
    assert.equal(failures,0);
    let limited=false;for(let i=0;i<310;i++){if((await app.inject({url:'/coins',remoteAddress:'10.1.0.1'})).statusCode===429)limited=true;}
    assert.equal(limited,true);
    console.log(`PASS API: validation, DB/worker health, recent chart, rate limit; 1000 stub-DB requests at concurrency 50 (${Date.now()-start}ms including rate-limit checks).`);
  }finally{await app.close();}
}
async function ingestChecks(){
  const initial={address:'0xcoin',virtualQuote:'1000000000',tokenReserve:'1000000000',realQuote:'0',graduationQuote:'1000000000',decimals:18,quote:'0xquote',totalSupply:'1000000000',volumeQuote:0,volumeUsd:0,tradeCount:0};
  let state={coin:{...initial},cursor:null,trades:new Map(),receipts:new Set(),points:[]};
  let failure='',page=[],rpcFailure=false,reorg=false;const published=[];
  const makeDb=s=>({
    $executeRaw:async()=>{},
    cursor:{findUnique:async()=>s.cursor,upsert:async({create})=>{if(failure==='cursor')throw Error('cursor failure');s.cursor=create;}},
    indexedEvent:{createMany:async({data})=>{const k=data[0].txHash+':'+data[0].logIndex;if(s.receipts.has(k))return{count:0};s.receipts.add(k);return{count:1};}},
    coin:{findUnique:async()=>s.coin?{...s.coin}:null,findMany:async()=>s.coin?[{...s.coin}]:[],update:async({data})=>{if(failure==='coin')throw Error('coin failure');return s.coin={...s.coin,...data};}},
    trade:{findUnique:async({where})=>s.trades.get(JSON.stringify(where))||null,upsert:async({where,create})=>{s.trades.set(JSON.stringify(where),create);}},
    pricePoint:{create:async({data})=>{if(failure==='point')throw Error('point failure');s.points.push(data);}},
  });
  // No RPC call may run while the serializable transaction is open (review H4): the mock flags it.
  let inTx=false,maxRange=0n,logCalls=0;const noRpcInTx=()=>{if(inTx)throw Error('RPC call inside the database transaction');};
  const prisma={$transaction:async(fn)=>{const tentative=structuredClone(state);inTx=true;let result;try{result=await fn(makeDb(tentative));}finally{inTx=false;}state=tentative;return result;},
    cursor:{findUnique:async()=>state.cursor},coin:{findMany:async()=>state.coin?[{...state.coin}]:[]}};
  const client={getBlock:async({blockNumber})=>{noRpcInTx();return{number:blockNumber,hash:reorg?'changed':'hash'+blockNumber,timestamp:1000n};},
    getLogs:async({fromBlock,toBlock})=>{noRpcInTx();logCalls++;if(rpcFailure)throw Error('RPC outage');if(maxRange&&toBlock-fromBlock+1n>maxRange)throw Error('query returned more than 10000 results');return page.filter(l=>l.blockNumber>=fromBlock&&l.blockNumber<=toBlock);},
    readContract:async()=>{noRpcInTx();throw Error('no registrations in this harness');}};
  const context={exports:{},console:{log(){},error(){}},cfg:{chainId:1,curve:'0xcurve',weth:'0xquote',ethUsd:3000,logPage:5000n,startBlock:1n},defineChain:x=>x,http:()=>({}),createPublicClient:()=>client,parseAbiItem:x=>x,getAddress:x=>x,erc20Abi:[],prisma,publish:u=>published.push(u),ingestion:{}};
  vm.runInNewContext(code('ingest.ts','\nexport { scan, onTraded };'),context);
  const log=(i,block=1n)=>({eventName:'Traded',args:{coin:'0xcoin',trader:'0xholder',isBuy:true,amountIn:100n,amountOut:90n,fee:2n},blockNumber:block,blockHash:'hash'+block,transactionHash:'0xtx'+i,logIndex:0});
  rpcFailure=true;await assert.rejects(context.exports.scan(1n,1n),/RPC/);assert.equal(state.cursor,null);rpcFailure=false;
  page=[log(1)];
  for(const stage of ['coin','point','cursor']){
    failure=stage;await assert.rejects(context.exports.scan(1n,1n));assert.equal(state.trades.size,0);assert.equal(state.receipts.size,0);assert.equal(state.points.length,0);assert.equal(state.cursor,null);assert.equal(published.length,0);
  }
  failure='';await context.exports.scan(1n,1n);await context.exports.scan(1n,1n);
  assert.equal(state.coin.tradeCount,1);assert.equal(state.coin.realQuote,'98');assert.equal(state.points.length,1);assert.equal(published.length,2);
  page=[log(1,2n),log(2,2n)];await context.exports.scan(2n,2n);
  assert.equal(state.coin.tradeCount,2);assert.equal(state.points.length,2);
  reorg=true;page=[log(3,3n)];await assert.rejects(context.exports.scan(3n,3n),/Reorg/);assert.equal(state.cursor.lastBlock,2n);reorg=false;
  const saved=state.coin;state.coin=null;await assert.rejects(context.exports.scan(3n,3n),/Missing registration/);state.coin=saved;
  page=[{...log(3,3n),blockHash:'wrong'}];await assert.rejects(context.exports.scan(3n,3n),/not canonical/);
  const start=Date.now();page=Array.from({length:10000},(_,i)=>log(i+3,3n));page.push(...page.slice(0,1000));await context.exports.scan(3n,3n);
  assert.equal(state.coin.tradeCount,10002);assert.equal(state.points.length,10002);assert.equal(state.receipts.size,10002);
  // Adaptive paging: an RPC that caps the log range makes the ingester shrink the page and still converge.
  maxRange=2n;page=[log(20000,7n),log(20001,11n)];logCalls=0;await context.exports.scan(4n,11n);
  assert.equal(state.cursor.lastBlock,11n);assert.equal(state.coin.tradeCount,10004);assert.ok(logCalls>4,'range shrank into several pages');maxRange=0n;
  console.log(`PASS ingest: RPC/write rollback, post-commit notifications, replay, missing registration, reorg/hash rejection, no RPC inside transactions, adaptive log paging; 10000 unique + 1000 duplicate events applied once (${Date.now()-start}ms, in-memory adapters).`);
}
module.exports={apiChecks,ingestChecks};
async function pricingChecks(){
  // USD pricing fails closed: without a configured price for the quote asset every USD field is null,
  // never 0 or a placeholder; with one, the numbers are exact and volumeUsd accumulates.
  const run=async(cfg,quote,initialVolumeUsd)=>{
    const s={coin:{address:'0xcoin',virtualQuote:'1000000000',tokenReserve:'1000000000',realQuote:'0',graduationQuote:'1000000000',decimals:18,quote,totalSupply:'1000000000',volumeQuote:0,volumeUsd:initialVolumeUsd,tradeCount:0},trades:new Map(),points:[]};
    const db={coin:{findUnique:async()=>({...s.coin}),update:async({data})=>s.coin={...s.coin,...data}},trade:{findUnique:async()=>null,upsert:async({where,create})=>s.trades.set(JSON.stringify(where),create)},pricePoint:{create:async({data})=>s.points.push(data)}};
    const context={exports:{},console:{log(){},warn(){}},cfg:{chainId:1,curve:'0xcurve',weth:'0xweth',...cfg},defineChain:x=>x,http:()=>({}),createPublicClient:()=>({getBlock:async()=>({timestamp:1000n})}),parseAbiItem:x=>x,getAddress:x=>x,erc20Abi:[],prisma:{},publish(){},ingestion:{}};
    vm.runInNewContext(code('ingest.ts','\nexport { derive, onTraded };'),context);
    const d=context.exports.derive(s.coin);
    await context.exports.onTraded({args:{coin:'0xcoin',trader:'0xholder',isBuy:true,amountIn:100n,amountOut:90n,fee:2n},blockNumber:1n,transactionHash:'0xtx',logIndex:0},db,()=>{});
    return{d,coin:s.coin,point:s.points[0]};
  };
  let r=await run({},'0xweth',null);
  assert.equal(r.d.priceUsd,null);assert.equal(r.d.marketCapUsd,null);assert.equal(r.coin.priceUsd,null);assert.equal(r.coin.marketCapUsd,null);assert.equal(r.coin.volumeUsd,null);assert.equal(r.point.priceUsd,null);
  assert.ok(r.coin.priceQuote>0&&r.coin.volumeQuote>0,'quote-denominated data still indexed');
  r=await run({ethUsd:2500},'0xweth',0);
  assert.ok(r.coin.priceUsd>0&&r.coin.marketCapUsd>0&&r.point.priceUsd>0);assert.equal(r.coin.volumeUsd,100/1e18*2500);
  r=await run({ethUsd:2500},'0xhood',0);                       // non-ETH quote without QUOTE_USD: null, not 0
  assert.equal(r.coin.priceUsd,null);assert.equal(r.coin.marketCapUsd,null);assert.equal(r.coin.volumeUsd,null);
  r=await run({ethUsd:2500,quoteUsd:{'0xhood':40}},'0xhood',0); // configured non-ETH quote is priced
  assert.ok(r.coin.priceUsd>0);assert.equal(r.coin.volumeUsd,100/1e18*40);
  r=await run({ethUsd:2500},'0xweth',null);                     // once unknown, volumeUsd stays null (no partial sums)
  assert.equal(r.coin.volumeUsd,null);assert.ok(r.coin.priceUsd>0);
  const cfgSrc=fs.readFileSync(path.join(__dirname,'src','config.ts'),'utf8');
  assert.ok(!/ETH_USD \?\? 3000/.test(cfgSrc),'no hardcoded ETH/USD default');
  console.log('PASS pricing: USD fields are null (never 0/placeholder) without a configured ETH_USD/QUOTE_USD; exact when configured; unknown volume never becomes a partial sum.');
}
module.exports.pricingChecks=pricingChecks;
async function v4Checks(){
  // V4 product lifecycle through the real ingest source on in-memory adapters: Registered (reflection) ->
  // curve trades with FeeAllocated (incl. an anti-snipe penalty) -> Graduated(poolId) -> PoolManager Swap +
  // hook FeeAccrued for BOTH currency orderings -> vault Distributed/Claimed + hook FeesClaimed. A legacy
  // V3 coin is indexed alongside to prove both curves coexist in one deployment.
  const A=(h)=>'0x'+h.repeat(20),lcs=(a)=>a.toLowerCase();
  const QUOTE=A('ee'),COIN_A=A('11'),COIN_B=A('ff'),COIN_V3=A('33'),VAULT_A=A('aa'),TREASURY=A('77'),ROUTER=A('99'),ZERO=A('00');
  const CFG={chainId:1,curve:'0xcurve',curveV4:'0xcurvev4',poolManager:'0xpm',hook:'0xhook',weth:QUOTE,ethUsd:3000,logPage:5000n,startBlock:1n};
  const POOL_A='0x'+'01'.repeat(32),POOL_B='0x'+'02'.repeat(32),POOL_X='0x'+'0f'.repeat(32);
  const E=(n)=>BigInt(n);
  const mk=(address,eventName,block,tx,logIndex,args)=>({address,eventName,args,blockNumber:BigInt(block),blockHash:'hash'+block,transactionHash:tx,logIndex});
  // Fee split exactly as CensusFeeMath.calculate: total = gross*(200+reflection+penalty)/1e4, holders = gross*reflection/1e4,
  // shared = total-holders, protocol = shared*(9000|3000)/1e4, creator = shared-protocol.
  const split=(gross,reflection,penaltyBps,graduated)=>{const total=gross*E(200+reflection+penaltyBps)/10000n,holders=gross*E(reflection)/10000n,penalty=gross*E(penaltyBps)/10000n,shared=total-holders,protocol=shared*(graduated?3000n:9000n)/10000n;return{total,holders,penalty,protocol,creator:shared-protocol};};
  const SUPPLY=10n**27n,VQ=10n**18n;
  const curveTrade=(tx,block,base,coin,isBuy,amountIn,amountOut,gross,reflection,penaltyBps)=>{const f=split(gross,reflection,penaltyBps,false);return[
    mk(CFG.curveV4,'FeeAllocated',block,tx,base,{coin,isBuy,protocolFee:f.protocol,creatorFee:f.creator,holderFee:f.holders,penalty:f.penalty}),
    mk(CFG.curveV4,'Traded',block,tx,base+1,{coin,trader:A('f1'),isBuy,amountIn,amountOut,fee:f.total})];};
  const accrued=(tx,block,logIndex,poolId,buy,gross,reflection)=>{const f=split(gross,reflection,0,true);return mk(CFG.hook,'FeeAccrued',block,tx,logIndex,{poolId,buy,quoteVolume:gross,protocolFee:f.protocol,creatorFee:f.creator,holderFee:f.holders});};
  const swap=(tx,block,logIndex,id,amount0,amount1,sqrtPriceX96)=>mk(CFG.poolManager,'Swap',block,tx,logIndex,{id,sender:ROUTER,amount0,amount1,sqrtPriceX96,liquidity:10n**18n,tick:0,fee:0});
  const Q96=2n**96n;
  const page=[
    mk(CFG.curveV4,'Registered',1,'0xregA',0,{coin:COIN_A,quote:QUOTE,creator:A('c0'),vault:VAULT_A,reflectionBps:200,virtualQuote:VQ,graduationQuote:4n*10n**18n,virtualTokenOffset:10n**24n}),
    mk(CFG.curveV4,'Registered',1,'0xregB',1,{coin:COIN_B,quote:QUOTE,creator:A('c0'),vault:ZERO,reflectionBps:0,virtualQuote:VQ,graduationQuote:4n*10n**18n,virtualTokenOffset:0n}),
    mk(CFG.curve,'Registered',1,'0xregV3',2,{coin:COIN_V3,quote:QUOTE,creator:A('c0'),vault:ZERO,holdersBps:0,virtualQuote:VQ,graduationQuote:4n*10n**18n,virtualTokenOffset:10n**24n}),
    mk(CFG.curve,'Traded',2,'0xv3t1',0,{coin:COIN_V3,trader:A('f1'),isBuy:true,amountIn:10n**18n,amountOut:5n*10n**20n,fee:10n**16n}),
    ...curveTrade('0xt1',2,1,COIN_A,true,10n**18n,5n*10n**20n,10n**18n,200,0),      // buy, 2% + 2% reflection
    ...curveTrade('0xt3',2,3,COIN_A,true,10n**18n,4n*10n**20n,10n**18n,200,618),    // buy at +1s: 6.18% anti-snipe penalty
    ...curveTrade('0xt2',3,0,COIN_A,false,2n*10n**20n,45n*10n**16n-split(45n*10n**16n,200,0,false).total,45n*10n**16n,200,0), // sell: fee on gross proceeds, amountOut net
    ...curveTrade('0xt4',3,2,COIN_B,true,10n**18n,5n*10n**20n,10n**18n,0,0),        // reflection off
    mk(CFG.curveV4,'Graduated',4,'0xgradA',0,{coin:COIN_A,poolId:POOL_A,tokensIn:1n,quoteIn:1n,liquidity:1n}),
    mk(CFG.curveV4,'Graduated',4,'0xgradB',1,{coin:COIN_B,poolId:POOL_B,tokensIn:1n,quoteIn:1n,liquidity:1n}),
    // COIN_A (0x11..) < QUOTE (0xee..): coin is currency0, quote flow = amount1. Buy: FeeAccrued precedes Swap (beforeSwap),
    // the swap deltas are NET of the hook fee; the swapper's deltas are negative for what it pays.
    accrued('0xs1',5,0,POOL_A,true,10n**18n,200),
    swap('0xs1',5,1,POOL_A,5n*10n**20n,-(10n**18n-4n*10n**16n),Q96/1000n),
    // Sell: Swap then FeeAccrued (afterSwap); the pool pays the gross quote, the hook takes its fee from it.
    swap('0xs2',5,2,POOL_A,-(6n*10n**20n),9n*10n**17n,Q96/1100n),
    accrued('0xs2',5,3,POOL_A,false,9n*10n**17n,200),
    // COIN_B (0xff..) > QUOTE: coin is currency1, quote flow = amount0.
    accrued('0xs3',5,4,POOL_B,true,2n*10n**18n,0),
    swap('0xs3',5,5,POOL_B,-(2n*10n**18n-4n*10n**16n),10n**21n,Q96*1000n),
    swap('0xs4',5,6,POOL_B,5n*10n**17n,-(2n*10n**20n),Q96*900n),
    accrued('0xs4',5,7,POOL_B,false,5n*10n**17n,0),
    swap('0xsx',5,8,POOL_X,-(10n**18n),10n**21n,Q96),                              // foreign pool on the same PoolManager: ignored
    mk(CFG.hook,'FeeAccrued',5,'0xsx',9,{poolId:POOL_X,buy:true,quoteVolume:1n,protocolFee:1n,creatorFee:0n,holderFee:0n}),
    mk(VAULT_A,'Distributed',6,'0xdist',0,{quoteSpent:10n**16n}),
    mk(VAULT_A,'Claimed',6,'0xclaim',1,{holder:A('f1'),asset:COIN_A,amount:3n*10n**15n}),
    mk(CFG.hook,'FeesClaimed',6,'0xcollect',2,{asset:QUOTE,recipient:VAULT_A,amount:2n*10n**16n}),
    mk(CFG.hook,'FeesClaimed',6,'0xcollect',3,{asset:QUOTE,recipient:TREASURY,amount:5n*10n**15n}), // not a vault: ignored
  ];
  let state={coins:new Map(),trades:new Map(),rewards:new Map(),receipts:new Set(),points:[],cursor:null};
  const makeDb=s=>({
    $executeRaw:async()=>{},
    cursor:{findUnique:async()=>s.cursor,upsert:async({create})=>{s.cursor=create;}},
    indexedEvent:{createMany:async({data})=>{const k=data[0].txHash+':'+data[0].logIndex;if(s.receipts.has(k))return{count:0};s.receipts.add(k);return{count:1};}},
    coin:{findUnique:async({where})=>s.coins.has(where.address)?{...s.coins.get(where.address)}:null,findMany:async()=>[...s.coins.values()].map(c=>({...c})),
      upsert:async({where,create,update})=>{const row=s.coins.has(where.address)?{...s.coins.get(where.address),...update}:{volumeQuote:0,volumeUsd:0,tradeCount:0,...create};s.coins.set(where.address,row);return row;},
      update:async({where,data})=>{const row={...s.coins.get(where.address),...data};s.coins.set(where.address,row);return row;}},
    trade:{findUnique:async({where})=>s.trades.get(JSON.stringify(where))||null,upsert:async({where,create})=>{s.trades.set(JSON.stringify(where),create);}},
    rewardEvent:{upsert:async({where,create})=>{s.rewards.set(JSON.stringify(where),create);}},
    pricePoint:{create:async({data})=>{s.points.push(data);}},
  });
  let current=page;const published=[];
  const prisma={$transaction:async(fn)=>{const tentative=structuredClone(state);const result=await fn(makeDb(tentative));state=tentative;return result;},
    cursor:{findUnique:async()=>state.cursor},coin:{findMany:async()=>[...state.coins.values()].map(c=>({...c}))}};
  const client={getBlock:async({blockNumber})=>({number:blockNumber,hash:'hash'+blockNumber,timestamp:1000n}),
    getLogs:async({address,fromBlock,toBlock})=>{const set=(Array.isArray(address)?address:[address]).map(lcs);return current.filter(l=>set.includes(lcs(l.address))&&l.blockNumber>=fromBlock&&l.blockNumber<=toBlock);},
    readContract:async({address,functionName})=>({name:'N',symbol:'S',decimals:18,totalSupply:SUPPLY})[functionName]};
  const context={exports:{},console:{log(){},error(){},warn(){}},cfg:CFG,defineChain:x=>x,http:()=>({}),createPublicClient:()=>client,parseAbiItem:x=>x,getAddress:x=>x,erc20Abi:[],prisma,publish:u=>published.push(u),ingestion:{}};
  vm.runInNewContext(code('ingest.ts','\nexport { scan };'),context);
  await context.exports.scan(1n,6n);
  const trade=(tx,i)=>state.trades.get(JSON.stringify({txHash_logIndex:{txHash:tx,logIndex:i}}));
  const a=state.coins.get(COIN_A),b=state.coins.get(COIN_B),v3=state.coins.get(COIN_V3);
  assert.equal(a.product,'v4');assert.equal(a.reflectionBps,200);assert.equal(a.vault,VAULT_A);assert.equal(a.isV2,true);assert.equal(a.holdersBps,0);
  assert.equal(b.product,'v4');assert.equal(b.reflectionBps,0);assert.equal(b.vault,null);assert.equal(v3.product,'v3');assert.equal(v3.reflectionBps,0);
  // Curve reserves follow Traded exactly as on V3 (fee never enters the curve).
  const f1=split(10n**18n,200,0,false),f3=split(10n**18n,200,618,false),f2=split(45n*10n**16n,200,0,false);
  const netA=(10n**18n-f1.total)+(10n**18n-f3.total)-45n*10n**16n;
  assert.equal(a.virtualQuote,(VQ+netA).toString());assert.equal(a.realQuote,netA.toString());
  assert.equal(a.tokenReserve,(SUPPLY-5n*10n**20n-4n*10n**20n+2n*10n**20n).toString());
  assert.equal(trade('0xt1',2).fee,f1.total.toString());assert.equal(trade('0xt1',2).feeProtocol,f1.protocol.toString());assert.equal(trade('0xt1',2).feeCreator,f1.creator.toString());assert.equal(trade('0xt1',2).feeHolders,f1.holders.toString());assert.equal(trade('0xt1',2).feePenalty,'0');
  assert.equal(trade('0xt3',4).feePenalty,f3.penalty.toString());assert.equal(BigInt(trade('0xt3',4).feeProtocol)+BigInt(trade('0xt3',4).feeCreator)+BigInt(trade('0xt3',4).feeHolders),f3.total);
  assert.equal(trade('0xt2',1).isBuy,false);assert.equal(trade('0xt2',1).feeHolders,f2.holders.toString());
  assert.equal(trade('0xt4',3).feeHolders,'0');assert.equal(trade('0xv3t1',0).feeProtocol,'0');assert.equal(trade('0xv3t1',0).fee,'10000000000000000');
  // Graduation: poolId recorded, pool stays null, progress complete.
  assert.equal(a.graduated,true);assert.equal(a.poolId,POOL_A);assert.equal(a.pool,undefined);assert.equal(a.progressBps,10000);assert.equal(b.poolId,POOL_B);
  // Pool trades: gross quote from FeeAccrued, fee = protocol+creator+holders, net output on sells, price oriented per ordering.
  const g1=split(10n**18n,200,0,true),g2=split(9n*10n**17n,200,0,true),g3=split(2n*10n**18n,0,0,true),g4=split(5n*10n**17n,0,0,true);
  const s1=trade('0xs1',1),s2=trade('0xs2',2),s3=trade('0xs3',5),s4=trade('0xs4',6);
  assert.equal(s1.venue,'pool');assert.equal(s1.isBuy,true);assert.equal(s1.amountIn,(10n**18n).toString());assert.equal(s1.amountOut,(5n*10n**20n).toString());assert.equal(s1.fee,g1.total.toString());assert.equal(s1.feeProtocol,g1.protocol.toString());assert.equal(s1.feeCreator,g1.creator.toString());assert.equal(s1.feeHolders,g1.holders.toString());assert.equal(s1.trader,ROUTER);
  assert.ok(Math.abs(s1.priceQuote-1e-6)<1e-18,'coin=currency0 buy price');
  assert.equal(s2.isBuy,false);assert.equal(s2.amountIn,(6n*10n**20n).toString());assert.equal(s2.amountOut,(9n*10n**17n-g2.total).toString());assert.equal(s2.fee,g2.total.toString());
  assert.ok(Math.abs(s2.priceQuote-1/1100**2)/(1/1100**2)<1e-12,'coin=currency0 sell price');
  assert.equal(s3.isBuy,true);assert.equal(s3.amountIn,(2n*10n**18n).toString());assert.equal(s3.amountOut,(10n**21n).toString());assert.equal(s3.fee,g3.total.toString());assert.equal(s3.feeHolders,'0');
  assert.ok(Math.abs(s3.priceQuote-1e-6)/1e-6<1e-12,'coin=currency1 buy price (inverted sqrtPrice)');
  assert.equal(s4.isBuy,false);assert.equal(s4.amountIn,(2n*10n**20n).toString());assert.equal(s4.amountOut,(5n*10n**17n-g4.total).toString());
  assert.ok(Math.abs(s4.priceQuote-1/900**2)/(1/900**2)<1e-12,'coin=currency1 sell price');
  assert.ok(Math.abs(state.coins.get(COIN_A).priceQuote-1/1100**2)/(1/1100**2)<1e-12);assert.ok(Math.abs(state.coins.get(COIN_B).priceQuote-1/900**2)/(1/900**2)<1e-12);
  assert.equal(state.coins.get(COIN_A).tradeCount,5);assert.equal(state.coins.get(COIN_B).tradeCount,3);
  assert.ok(Math.abs(state.coins.get(COIN_A).volumeQuote-(1+1+0.45+1+0.9))<1e-9,'volume counts gross quote');
  assert.equal(trade('0xsx',8),undefined,'foreign poolId never indexed');
  // Rewards: vault Distributed/Claimed and hook FeesClaimed to the vault ("collected"); treasury payout ignored.
  const rewards=[...state.rewards.values()];
  assert.deepEqual(rewards.map(r=>r.kind).sort(),['claimed','collected','distributed']);
  assert.equal(rewards.find(r=>r.kind==='collected').amount,(2n*10n**16n).toString());assert.equal(rewards.find(r=>r.kind==='collected').asset,QUOTE);
  assert.equal(rewards.find(r=>r.kind==='claimed').asset,COIN_A);assert.ok(rewards.every(r=>r.coinAddress===COIN_A));
  // Receipts exist for state-changing events only (fee logs are annotations): 3 reg + 5 traded + 2 grad + 4 swaps + 3 rewards.
  assert.equal(state.receipts.size,17);assert.equal(state.points.length,9);assert.equal(state.cursor.curve,'0xcurve|v4:0xcurvev4');
  // Exactly-once: full replay is a no-op; duplicates re-emitted in a later block are skipped by receipt.
  const digest=()=>JSON.stringify([...state.coins.values(),...state.trades.values(),...state.rewards.values(),state.points],(_,v)=>typeof v==='bigint'?v.toString():v);
  const before=digest(),publishedBefore=published.length;
  await context.exports.scan(1n,6n);assert.equal(digest(),before);assert.equal(published.length,publishedBefore);
  current=[...page,...page.filter(l=>l.transactionHash==='0xs1'||l.transactionHash==='0xt1'||l.transactionHash==='0xdist').map(l=>({...l,blockNumber:7n,blockHash:'hash7'}))];
  await context.exports.scan(7n,7n);assert.equal(state.receipts.size,17);assert.equal(state.coins.get(COIN_A).tradeCount,5);assert.equal(state.rewards.size,3);
  // Fail closed on inconsistent fee events (nothing is written).
  const reject=async(logs,re)=>{const snap=digest();current=[...page,...logs];await assert.rejects(context.exports.scan(8n,8n),re);assert.equal(digest(),snap);assert.equal(state.cursor.lastBlock,7n);};
  await reject([mk(CFG.curveV4,'Traded',8,'0xbad1',0,{coin:COIN_B,trader:A('f1'),isBuy:true,amountIn:10n**18n,amountOut:1n,fee:1n})],/without FeeAllocated/);
  await reject([mk(CFG.curveV4,'FeeAllocated',8,'0xbad2',0,{coin:COIN_B,isBuy:true,protocolFee:1n,creatorFee:1n,holderFee:0n,penalty:0n}),mk(CFG.curveV4,'Traded',8,'0xbad2',1,{coin:COIN_B,trader:A('f1'),isBuy:true,amountIn:10n**18n,amountOut:1n,fee:3n})],/does not match/);
  await reject([swap('0xbad3',8,0,POOL_A,10n,-10n,Q96)],/without hook FeeAccrued/);
  await reject([accrued('0xbad4',8,0,POOL_A,false,10n**18n,200),swap('0xbad4',8,1,POOL_A,10n,-10n,Q96)],/direction mismatch/);
  // API surface: products from the configured curves; fee split on trades; product/reflection/poolId on coins.
  const app=require('fastify')({logger:false});app.listen=async()=>{};
  const apiCtx={exports:{},console:{log(){}},...gtModule(),Fastify:()=>app,cors:require('@fastify/cors'),websocket:require('@fastify/websocket'),rateLimit:require('@fastify/rate-limit'),registerSocialRoutes:()=>{},cfg:{chainId:1,curve:'0xcurve',curveV4:'0xcurvev4',corsOrigin:'*',port:0,pollMs:4000,...GT_CFG},bus:new EventEmitter(),serializeCoin:context.exports.serializeCoin,ingestion:{lastSuccessAt:Date.now(),lastBlock:'7',error:null},
    prisma:{$queryRaw:async()=>{},coin:{findMany:async()=>[...state.coins.values()],findUnique:async({where})=>state.coins.get(where.address)||null},trade:{findMany:async({where})=>[...state.trades.values()].filter(t=>t.coinAddress===where.coinAddress)}}};
  vm.runInNewContext(code('api.ts'),apiCtx);await apiCtx.exports.runApi();
  try{
    assert.deepEqual((await app.inject('/health')).json().products,['v3','v4']);
    const coin=(await app.inject('/coins/'+COIN_A)).json().coin;assert.equal(coin.product,'v4');assert.equal(coin.reflectionBps,200);assert.equal(coin.poolId,POOL_A);assert.equal(coin.pool,null);
    assert.equal((await app.inject('/coins/'+COIN_V3)).json().coin.product,'v3');
    const trades=(await app.inject('/coins/'+COIN_A+'/trades')).json().trades;
    const t=trades.find(t=>t.txHash==='0xs1');assert.equal(t.feeProtocol,g1.protocol.toString());assert.equal(t.feeCreator,g1.creator.toString());assert.equal(t.feeHolders,g1.holders.toString());assert.equal(t.feePenalty,'0');assert.equal(t.venue,'pool');
    assert.equal(trades.find(t=>t.txHash==='0xt3').feePenalty,f3.penalty.toString());
  }finally{await app.close();}
  console.log('PASS v4: reflection registration, FeeAllocated split (incl. anti-snipe penalty), Graduated(poolId), PoolManager Swap + hook FeeAccrued for both currency orderings (gross volume, net sell output, oriented price), vault/hook rewards, foreign pools ignored, exactly-once replay, fail-closed fee pairing, API fields; V3 curve indexed alongside.');
}
module.exports.v4Checks=v4Checks;
async function gtChecks(){
  const viem=require('viem');
  const app=require('fastify')({logger:false});app.listen=async()=>{};
  const COIN='0x'+'aa'.repeat(20),QUOTE='0x'+'ee'.repeat(20),CREATOR='0x'+'cc'.repeat(20),BUYER='0x'+'bb'.repeat(20);
  const coins=new Map([[COIN,{address:COIN,name:'Delos Test',symbol:'DLT',decimals:18,totalSupply:(10n**27n).toString(),creator:CREATOR,quote:QUOTE,quoteDecimals:18,product:'v4',reflectionBps:0,virtualQuote:(15n*10n**17n).toString(),tokenReserve:(10n**27n).toString(),virtualTokenOffset:(5n*10n**26n).toString(),graduationQuote:(2n*10n**16n).toString(),createdBlock:100n,createdAt:new Date(1700000100*1000),createdTxHash:'0xcreate',graduated:true,poolId:'0xpool',graduatedBlock:103n,graduatedTxHash:'0xgrad',graduatedTxIndex:2,graduatedLogIndex:7,graduatedAt:new Date(1700000103*1000)}]]);
  const trades=[
    {coinAddress:COIN,trader:BUYER,isBuy:true,amountIn:(10n**16n).toString(),amountOut:(25n*10n**24n).toString(),fee:(2n*10n**14n).toString(),priceQuote:1e-9,venue:'curve',block:101n,txIndex:3,txHash:'0xbuy',logIndex:5,ts:new Date(1700000101*1000),reserve0After:(1475n*10n**24n).toString(),reserve1After:(15098n*10n**14n).toString()},
    {coinAddress:COIN,trader:BUYER,isBuy:false,amountIn:(10n**24n).toString(),amountOut:(9n*10n**14n).toString(),fee:(2n*10n**13n).toString(),priceQuote:9e-10,venue:'curve',block:102n,txIndex:0,txHash:'0xsell',logIndex:1,ts:new Date(1700000102*1000),reserve0After:(1476n*10n**24n).toString(),reserve1After:(15089n*10n**14n).toString()},
    {coinAddress:COIN,trader:BUYER,isBuy:true,amountIn:'1',amountOut:'1',fee:'0',priceQuote:1,venue:'pool',block:104n,txIndex:0,txHash:'0xpoolswap',logIndex:0,ts:new Date(1700000104*1000)},
  ];
  const ingestion={lastSuccessAt:Date.now(),lastBlock:null,error:null};
  const ctx={exports:{},console:{log(){}},...gtModule(),Fastify:()=>app,cors:require('@fastify/cors'),websocket:require('@fastify/websocket'),rateLimit:require('@fastify/rate-limit'),registerSocialRoutes:()=>{},cfg:{chainId:1,curve:'0xcurve',curveV4:'0xcurvev4',corsOrigin:'*',port:0,pollMs:4000,...GT_CFG},bus:new EventEmitter(),serializeCoin:x=>x,ingestion,
    prisma:{$queryRaw:async()=>{},coin:{findMany:async()=>[...coins.values()],findUnique:async({where})=>coins.get(where.address)||null},trade:{findMany:async({where})=>trades.filter(t=>!where?.coinAddress||t.coinAddress===where.coinAddress)}}};
  vm.runInNewContext(code('api.ts'),ctx);await ctx.exports.runApi();
  try{
    assert.equal((await app.inject('/geckoterminal/latest-block')).statusCode,503);
    ingestion.lastBlock='105';
    assert.deepEqual((await app.inject('/geckoterminal/latest-block')).json(),{block:{blockNumber:105,blockTimestamp:1700000105}});
    assert.equal((await app.inject('/geckoterminal/asset?id=nope')).statusCode,400);
    assert.equal((await app.inject('/geckoterminal/asset?id=0x'+'dd'.repeat(20))).statusCode,404);
    const asset=(await app.inject('/geckoterminal/asset?id='+COIN)).json().asset;
    assert.equal(asset.id,viem.getAddress(COIN));assert.equal(asset.symbol,'DLT');assert.equal(asset.decimals,18);assert.equal(asset.totalSupply,'1000000000');
    assert.equal(asset.metadata.imageUrl,'https://img.test/'+COIN+'.png');assert.equal(asset.metadata.description,'A test coin');assert.equal(asset.metadata.website,'https://site.test/#/coin/'+COIN);
    const quote=(await app.inject('/geckoterminal/asset?id='+QUOTE)).json().asset;assert.equal(quote.symbol,'WETH');assert.equal(quote.totalSupply,'1000');
    const pair=(await app.inject('/geckoterminal/pair?id='+COIN)).json().pair;
    assert.equal(pair.dexKey,'delos');assert.equal(pair.asset0Id,asset.id);assert.equal(pair.asset1Id,quote.id);assert.equal(pair.createdAtBlockNumber,100);assert.equal(pair.createdAtBlockTimestamp,1700000100);assert.equal(pair.createdAtTxnId,'0xcreate');assert.equal(pair.feeBps,200);assert.equal(pair.creator,viem.getAddress(CREATOR));assert.equal(pair.metadata.graduationQuote,'0.02');
    assert.equal((await app.inject('/geckoterminal/pair?id=0x'+'dd'.repeat(20))).statusCode,404);
    assert.equal((await app.inject('/geckoterminal/events?fromBlock=5&toBlock=4')).statusCode,400);
    assert.equal((await app.inject('/geckoterminal/events?fromBlock=0&toBlock=5000')).statusCode,400);
    assert.equal((await app.inject('/geckoterminal/events?fromBlock=a&toBlock=4')).statusCode,400);
    const ev=(await app.inject('/geckoterminal/events?fromBlock=100&toBlock=104')).json().events;
    assert.deepEqual(ev.map(e=>[e.eventType,e.block.blockNumber,e.txnIndex,e.eventIndex]),[['swap',101,3,5],['swap',102,0,1],['exit',103,2,7]]);
    const buy=ev[0];assert.equal(buy.asset1In,'0.01');assert.equal(buy.asset0Out,'25000000');assert.equal(buy.metadata.fees1In,'0.0002');assert.equal(buy.reserves.asset0,'1475000000');assert.equal(buy.reserves.asset1,'1.5098');assert.equal(buy.maker,viem.getAddress(BUYER));assert.equal(buy.pairId,asset.id);assert.equal(buy.txnId,'0xbuy');assert.equal(buy.block.blockTimestamp,1700000101);
    assert.equal(buy.priceNative.slice(0,14),'0.000000001023'); // 1.5098 quote / 1,475,000,000 coins, full precision
    const sell=ev[1];assert.equal(sell.asset0In,'1000000');assert.equal(sell.asset1Out,'0.0009');assert.equal(sell.metadata.fees1Out,'0.00002');assert.equal(sell.asset1In,undefined);
    const exit=ev[2];assert.equal(exit.amount0,'1476000000');assert.equal(exit.amount1,'1.5089');assert.deepEqual(exit.reserves,{asset0:'0',asset1:'0'});assert.equal(exit.txnId,'0xgrad');assert.equal(exit.block.blockTimestamp,1700000103);assert.equal(exit.metadata.poolId,'0xpool');
    assert.deepEqual((await app.inject('/geckoterminal/events?fromBlock=200&toBlock=300')).json(),{events:[]});
  }finally{await app.close();}
  console.log('PASS geckoterminal: latest-block gated on ingestion, checksummed asset/pair ids, decimalized amounts, buy/sell orientation with fees, reserves after each trade, graduation exit, pool-venue trades excluded, range validation.');
}
module.exports.gtChecks=gtChecks;
module.exports.gtModule=gtModule;module.exports.GT_CFG=GT_CFG;
if(require.main===module)(async()=>{await apiChecks();await ingestChecks();await pricingChecks();await v4Checks();await gtChecks();})().catch(e=>{console.error(e);process.exit(1);}); // explicit non-zero exit
