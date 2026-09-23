const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { encodeEventTopics, encodeAbiParameters, parseAbi } = require('viem');
const { checkNetwork } = require('./network-check.cjs');
const bundled = buildSync({ entryPoints: [path.join(__dirname, 'src/lib/launchReceipt.ts')], bundle: true,
  platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const loaded = new Module(path.join(__dirname, 'launch-test.cjs'), module);
loaded.filename = path.join(__dirname, 'launch-test.cjs'); loaded.paths = module.paths;
loaded._compile(bundled, loaded.filename);
const { confirmLaunch } = loaded.exports;
const address = n => '0x' + n.toString(16).padStart(40, '0');
const factory = address(1), token = address(2), creator = address(3), curve = address(4), vault = address(5), quote = address(6);
const hash = '0x' + '11'.repeat(32);
const abi = parseAbi(['event LaunchedV4(address indexed token,address indexed creator,address curve,address vault,uint16 reflectionBps,address quote)']);
const event = { address: factory, topics: encodeEventTopics({ abi, eventName: 'LaunchedV4', args: { token, creator } }),
  data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint16' }, { type: 'address' }], [curve, vault, 0, quote]) };

(async () => {
  let polls = 0;
  let receipt = { status: 'reverted', logs: [] };
  let fail = false;
  const client = { getChainId: async () => 4663, waitForTransactionReceipt: async options => {
    polls++; assert.equal(options.hash, hash); assert.equal(options.timeout, 60_000);
    if (fail) throw new Error('receipt timeout'); return receipt;
  } };
  assert.deepEqual(await confirmLaunch(client, hash, factory, 4663), { status: 'reverted' });
  receipt = { status: 'success', logs: [event] };
  assert.deepEqual(await confirmLaunch(client, hash, factory, 4663), { status: 'success', token });
  receipt = { status: 'success', logs: [{ ...event, address: address(9) }] };
  await assert.rejects(confirmLaunch(client, hash, factory, 4663), /No launch event/);
  const before = polls;
  await assert.rejects(confirmLaunch({ ...client, getChainId: async () => 46630 }, hash, factory, 4663), /wrong network/);
  assert.equal(polls, before, 'never poll a receipt on the wrong chain');
  fail = true;
  await assert.rejects(confirmLaunch(client, hash, factory, 4663), /receipt timeout/);
  fail = false; receipt = { status: 'success', logs: [event] };
  assert.equal((await confirmLaunch(client, hash, factory, 4663)).token, token, 'retry checks the same transaction');
  assert.deepEqual(checkNetwork({}), []);
  assert.ok(checkNetwork({ VITE_CHAIN_ID: '46630' }).length);
  assert.ok(checkNetwork({ VITE_CHAIN_ID: '4663', VITE_RPC_URL: 'https://rpc.testnet.chain.robinhood.com' }).length);
  assert.ok(checkNetwork({ VITE_CHAIN_ID: '4663', VITE_WETH: '0x823F4ef19CCE787C7D10483896eE0102F48A88eb' }).length);
  assert.deepEqual(checkNetwork({ VITE_CHAIN_ID: '4663', VITE_RPC_URL: 'https://rpc.mainnet.chain.robinhood.com', VITE_WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' }), []);
  console.log('PASS: reverted/successful receipts, foreign events, chain mismatch, timeout/retry, mainnet configuration guards');
})().catch(error => { console.error(error); process.exitCode = 1; });
