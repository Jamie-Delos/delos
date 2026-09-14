// Actual API and ingestion source; isolated adapters test failure boundaries, not Postgres itself.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const {EventEmitter}=require('node:events');
function code(file,tail='') {return ts.transpileModule(fs.readFileSync(__dirname+'/src/'+file,'utf8').replace(/^import .*;\r?$/gm,'')+tail,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;}
async function apiChecks(){
  const app=require('fastify')({logger:false});app.listen=async()=>{};
  const ingestion={lastSuccessAt:0,lastBlock:null,error:'starting'};
  let failDb=false,chartQuery;
  const context={exports:{},console:{log(){}},Fastify:()=>app,cors:require('@fastify/cors'),websocket:require('@fastify/websocket'),rateLimit:require('@fastify/rate-limit'),cfg:{chainId:1,curve:'0xcurve',corsOrigin:'*',port:0,pollMs:4000},bus:new EventEmitter(),serializeCoin:x=>x,ingestion,
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
    coin:{findUnique:async()=>s.coin?{...s.coin}:null,update:async({data})=>{if(failure==='coin')throw Error('coin failure');return s.coin={...s.coin,...data};}},
    trade:{findUnique:async({where})=>s.trades.get(JSON.stringify(where))||null,upsert:async({where,create})=>{s.trades.set(JSON.stringify(where),create);}},
    pricePoint:{create:async({data})=>{if(failure==='point')throw Error('point failure');s.points.push(data);}},
  });
  const prisma={$transaction:async(fn)=>{const tentative=structuredClone(state);const result=await fn(makeDb(tentative));state=tentative;return result;}};
  const client={getBlock:async({blockNumber})=>({number:blockNumber,hash:reorg?'changed':'hash'+blockNumber,timestamp:1000n}),getLogs:async()=>{if(rpcFailure)throw Error('RPC outage');return page;}};
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
  console.log(`PASS ingest: RPC/write rollback, post-commit notifications, replay, missing registration, reorg/hash rejection; 10000 unique + 1000 duplicate events applied once (${Date.now()-start}ms, in-memory adapters).`);
}
module.exports={apiChecks,ingestChecks};
if(require.main===module)(async()=>{await apiChecks();await ingestChecks();})().catch(e=>{console.error(e);process.exitCode=1;});
