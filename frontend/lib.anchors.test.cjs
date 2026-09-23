// Run: node lib.anchors.test.cjs. Bundle the real module with deterministic build-time config.
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { parseUnits } = require('viem');

const bundled = buildSync({
  entryPoints: [path.join(__dirname, 'src/lib/anchors.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
  define: { 'import.meta.env': '{}' },
}).outputFiles[0].text;
const loaded = new Module(path.join(__dirname, 'anchors-test.cjs'), module);
loaded.filename = path.join(__dirname, 'anchors-test.cjs');
loaded.paths = module.paths;
loaded._compile(bundled, loaded.filename);
const { ANCHORS, curveLaunchParams } = loaded.exports;
const eth = ANCHORS.find(a => a.key === 'ETH');
const hood = ANCHORS.find(a => a.key === 'HOOD');

(async () => {
  let calls = 0;
  const offline = { readContract: async () => { calls++; throw new Error('price RPC unavailable'); } };
  // ETH targets must remain exact and launchable even when the USD price pool/RPC is unavailable.
  for (const target of ['0.02', '4', '8']) {
    assert.deepEqual(await curveLaunchParams(offline, eth, Number(target)), {
      quote: eth.quote, virtualQuote: parseUnits('1.5', 18), graduationQuote: parseUnits(target, 18),
    });
  }
  assert.equal(calls, 0, 'ETH launch parameters must not read a USD oracle');
  const alias = { ...eth, key: 'WETH', quote: eth.quote.toLowerCase() };
  assert.equal((await curveLaunchParams(offline, alias, 0.02)).graduationQuote, parseUnits('0.02', 18));
  assert.equal(calls, 0, 'identify the ETH anchor by address, not its label');
  await assert.rejects(curveLaunchParams(offline, hood, 4), /price RPC unavailable/);
  assert.ok(calls > 0, 'non-ETH launches still require price reads');

  // $3,000 ETH / $30 HOOD: 1.5 ETH virtual reserve = 150 HOOD; 4 ETH target = 400 HOOD.
  const priced = { readContract: async ({ address, functionName }) => {
    const isEth = address === eth.pricePool;
    if (functionName === 'observe') throw new Error('oracle warming');
    if (functionName === 'token0') return isEth ? eth.quote : hood.quote;
    if (functionName === 'token1') return '0x1111111111111111111111111111111111111111';
    if (functionName === 'slot0') return [BigInt(Math.floor(Math.sqrt((isEth ? 3000 : 30) / 1e12) * 2 ** 96))];
    throw new Error(`unexpected read: ${functionName}`);
  } };
  const converted = await curveLaunchParams(priced, hood, 4);
  assert.equal(converted.quote, hood.quote);
  assert.ok(Math.abs(Number(converted.virtualQuote) / 1e18 - 150) < 1e-10);
  assert.ok(Math.abs(Number(converted.graduationQuote) / 1e18 - 400) < 1e-10);
  console.log('anchors: ETH rehearsal/standard targets, offline pricing, address identity and non-ETH conversion passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
