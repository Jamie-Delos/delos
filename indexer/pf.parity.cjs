// Cross-layer test: consume raw event topics/data emitted by the real local PF contracts.
// Run contracts/test/pf.graduation.test.js first to generate the fixture (no RPC needed here).
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const {parseAbi,parseAbiItem,decodeEventLog}=require('viem');
const fixture=JSON.parse(fs.readFileSync(process.argv[2] || path.join(__dirname,'../contracts/.test-build/pf-events.json'),'utf8'));
function code(file,tail=''){return ts.transpileModule(fs.readFileSync(path.join(__dirname,'src',file),'utf8').replace(/^import .*;\r?$/gm,'')+tail,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;}
const abis={exports:{},parseAbi};vm.runInNewContext(code('abis.ts'),abis);
const rows=new Map(),trades=new Map(),points=[];
const db={coin:{
  findUnique:async({where})=>rows.get(where.address)||null,
  upsert:async({where,create})=>{const row={volumeQuote:0,volumeUsd:0,tradeCount:0,...create};rows.set(where.address,row);return row;},
  update:async({where,data})=>{const row={...rows.get(where.address),...data};rows.set(where.address,row);return row;},
},trade:{findUnique:async({where})=>trades.get(JSON.stringify(where)),upsert:async({where,create})=>trades.set(JSON.stringify(where),create)},pricePoint:{create:async({data})=>points.push(data)}};
const context={exports:{},cfg:{chainId:1,weth:fixture.quote.toLowerCase(),ethUsd:3000,rpcUrl:'unused'},defineChain:x=>x,http:()=>({}),createPublicClient:()=>({}),parseAbiItem};
vm.runInNewContext(code('ingest.ts','\nexport { onRegistered,onTraded,derive };'),context);
(async()=>{
  const coin=fixture.coin.toLowerCase();
  // onRegistered flags holdersIndexed from the page's tokenMap (holder backfill); no token transfers are indexed here.
  const ctx={tokenMeta:new Map([[coin,{name:'PF test',symbol:'PFT',decimals:18,totalSupply:fixture.totalSupply}]]),blocks:new Map([['1',{hash:'hash1',ts:new Date(1000)}]]),tokenMap:new Map()};
  for(const [i,e] of fixture.events.entries()){
    const decoded=decodeEventLog({abi:abis.exports.curveAbi,topics:e.encoded.topics,data:e.encoded.data,strict:true});
    const log={...decoded,blockNumber:1n,transactionHash:'tx'+i,logIndex:i};
    if(decoded.eventName==='Registered')await context.exports.onRegistered(log,db,()=>{},ctx);
    else await context.exports.onTraded(log,db,()=>{},ctx);
  }
  const row=rows.get(coin);
  for(const key of ['virtualQuote','tokenReserve','realQuote'])assert.equal(row[key],fixture.state[key],key);
  assert.equal(row.virtualTokenOffset,fixture.offset);
  assert.equal(row.totalSupply,fixture.totalSupply);
  assert.equal(row.progressBps,10000);
  assert.equal(row.tradeCount,fixture.events.length-1);
  const expected=Number(fixture.state.virtualQuote)/Number(BigInt(fixture.state.tokenReserve)+BigInt(fixture.offset));
  assert.ok(Math.abs(row.priceQuote/expected-1)<1e-14);
  // Legacy Registered topic remains readable and retains its original zero-offset price model.
  const old='event Registered(address indexed coin,address quote,address creator,address vault,uint16 holdersBps,uint256 virtualQuote,uint256 graduationQuote)';
  const {encodeEventTopics,encodeAbiParameters}=require('viem');
  const legacy=decodeEventLog({abi:abis.exports.curveAbi,topics:encodeEventTopics({abi:parseAbi([old]),eventName:'Registered',args:{coin:fixture.coin}}),data:encodeAbiParameters([{type:'address'},{type:'address'},{type:'address'},{type:'uint16'},{type:'uint256'},{type:'uint256'}],[fixture.quote,fixture.quote,'0x0000000000000000000000000000000000000000',0,1500000000000000000n,4000000000000000000n])});
  await context.exports.onRegistered({...legacy,blockNumber:1n},db,()=>{},ctx);
  assert.equal(rows.get(coin).virtualTokenOffset,'0');
  assert.equal(rows.get(coin).priceQuote,1.5e18/Number(fixture.totalSupply));
  console.log(`PASS PF contract/indexer parity: ${fixture.events.length-1} real trades, partial-fill fees, exact reserves, price, supply, new + legacy event topics.`);
})().catch(e=>{console.error(e);process.exitCode=1;});
