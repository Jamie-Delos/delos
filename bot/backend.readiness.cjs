// Evaluate the real keeper planning functions without loading env or running main/signing.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(__dirname+'/src/keeper0x.js','utf8').replace('require("dotenv").config();','').split('const cmd = process.argv[2];')[0]+'\nmodule.exports={planUniswap,planZeroEx};';
const context={require,module:{exports:{}},process:{env:{}},fetch:()=>{throw new Error('network disabled');},console};
vm.runInNewContext(source,context);
(async()=>{
  let calls=0;
  const quoter={quoteExactInputSingle:{staticCall:async(p)=>{calls++;assert.equal(p.tokenIn,p.tokenOut);throw new Error('same-token pool does not exist');}}};
  const plan=await context.module.exports.planUniswap(quoter,'0xquote',3000,['0xquote'],[10000],['0x'],[18],10n**18n);
  assert.equal(plan.minOut[0],10n**18n);
  assert.equal(calls,0);
  console.log('PASS: quote-equals-basket payout keeps the asset without requesting a swap.');
})().catch(e=>{console.error(e);process.exitCode=1;});
