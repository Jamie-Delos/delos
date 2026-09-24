const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const { encodeEventTopics, encodeAbiParameters, parseAbi, zeroAddress } = require('viem');
function load(file) {
  const filename = path.join(__dirname, 'trading-test.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, file)], bundle: true, platform: 'node', format: 'cjs', write: false,
    define: { 'import.meta.env': '{}' } }).outputFiles[0].text;
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = module.paths; loaded._compile(bundled, filename); return loaded.exports;
}
const { watchGraduation } = load('src/lib/curves.ts');
const { quotePaymentRoute, minimumOutput, receivedWeth } = load('src/lib/paymentRoutes.ts');
const { CONTRACTS } = load('src/config.ts');
const address = n => '0x' + n.toString(16).padStart(40, '0');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  let calls = 0, changes = 0;
  const stop = watchGraduation({ readContract: async () => { calls++; if (calls === 1) throw Error('RPC'); return calls >= 3; } }, address(1), address(2), () => changes++, 2);
  await wait(40); assert.equal(changes, 1); assert.equal(calls, 3); stop();
  let resolveRead; let cancelledChanges = 0;
  const cancel = watchGraduation({ readContract: () => new Promise(r => resolveRead = r) }, address(1), address(2), () => cancelledChanges++);
  cancel(); resolveRead(true); await wait(1); assert.equal(cancelledChanges, 0);
  assert.equal(minimumOutput(1000n, 100), 990n);
  assert.throws(() => minimumOutput(1n, 200), /too small/);
  assert.throws(() => minimumOutput(1000n, 10000), /Invalid/);
  const abi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const event = (token, to, value) => ({ address: token, topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from: address(8), to } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]) });
  assert.equal(receivedWeth([event(CONTRACTS.weth, address(1), 30n), event(CONTRACTS.weth, address(1), 20n), event(address(9), address(1), 999n), event(CONTRACTS.weth, address(2), 900n)], address(1)), 50n);
  // Best output, not smallest fee, wins; multi-hop competes with direct paths.
  const pc = { uid: 'route-test', readContract: async ({args}) => args[2] === 500 ? address(99) : zeroAddress,
    simulateContract: async ({args}) => ({ result: [args[0].length > 100 ? 200n : 100n, [], [], 1n] }) };
  const route = await quotePaymentRoute(pc, address(3), 1000n);
  assert.equal(route.amountOut, 200n); assert.deepEqual(route.fees, [500, 500]); assert.equal(route.viaUSDG, true);
  assert.ok(route.path.toLowerCase().endsWith(CONTRACTS.weth.slice(2).toLowerCase()));
  assert.equal(await quotePaymentRoute(pc, CONTRACTS.weth, 1000n), null);
  assert.equal(await quotePaymentRoute({ ...pc, uid: 'no-pools', readContract: async () => zeroAddress }, address(3), 1000n), null);
  assert.equal(await quotePaymentRoute({ ...pc, simulateContract: async () => { throw Error('no liquidity'); } }, address(3), 1000n), null);
  await assert.rejects(quotePaymentRoute({ ...pc, uid: 'rpc-error', readContract: async () => { throw Error('RPC unavailable'); } }, address(3), 1000n), /RPC unavailable/);
  console.log('Trading regressions passed: graduation retries/cancellation, protected minimums, exact WETH receipt, best route, unavailable liquidity/RPC.');
})().catch(e => { console.error(e); process.exitCode = 1; });
