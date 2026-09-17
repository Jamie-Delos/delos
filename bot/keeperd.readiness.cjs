// Production keeper daemon checks: durable discovery, bounded pipeline, managed transactions with
// nonce/replacement recovery, signer limits, crash resume from the state file. Uses the REAL
// keeperd code with a deterministic fake chain adapter. Run: node keeperd.readiness.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { loadConfig, loadState, makeKeeper } = require('./src/keeperd.js');

const FACTORY = '0x' + 'fa'.repeat(20);
const CURVE = '0x' + 'cb'.repeat(20);
const LOCKER = '0x' + '10'.repeat(20);
const QUOTER = '0x' + '20'.repeat(20);
const TOKEN = '0x' + 'ab'.repeat(20);
const VAULT = '0x' + 'bd'.repeat(20);
const QUOTE = '0x' + 'ee'.repeat(20);
const HOLDER1 = '0x' + '01'.repeat(20);
const HOLDER2 = '0x' + '02'.repeat(20);
const EXCLUDED = '0x' + '03'.repeat(20);
const SIGNER = '0x' + '55'.repeat(20);
const OTHER = '0x' + '66'.repeat(20);

const FACTORY_IFACE = new ethers.Interface(['event LaunchedV2(address indexed token, address indexed creator, address curve, address vault, uint16 holdersBps)']);
const CURVE_IFACE = new ethers.Interface(['event Graduated(address indexed coin, address pool, uint256 tokenId, uint256 tokensIn, uint256 quoteIn)']);
const TOKEN_IFACE = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const mkLog = (address, iface, name, args, blockNumber) => {
  const e = iface.encodeEventLog(iface.getEvent(name), args);
  return { address, topics: e.topics, data: e.data, blockNumber };
};

function makeFakeChain() {
  const E = (n) => ethers.parseEther(n);
  const chain = {
    head: 100n,
    logs: [
      mkLog(FACTORY, FACTORY_IFACE, 'LaunchedV2', [TOKEN, HOLDER1, CURVE, VAULT, 10000], 10),
      mkLog(CURVE, CURVE_IFACE, 'Graduated', [TOKEN, '0x' + 'dd'.repeat(20), 7n, 1n, 1n], 50),
      mkLog(TOKEN, TOKEN_IFACE, 'Transfer', [ethers.ZeroAddress, HOLDER1, E('100')], 11),
      mkLog(TOKEN, TOKEN_IFACE, 'Transfer', [HOLDER1, HOLDER2, E('40')], 12),
      mkLog(TOKEN, TOKEN_IFACE, 'Transfer', [HOLDER1, EXCLUDED, E('10')], 13),
    ],
    sent: [], // every broadcast {kind is not known here; to, data, nonce, maxFeePerGas}
    receipts: new Map(),
    accountNonce: 5,
    signerBalance: E('1'),
    fee: 2n * 10n ** 9n,
    vaultAvailable: E('0.5'),
    vaultTokenFees: E('25'),
    collectable: [E('0.01'), E('0.02')],
    withdrawable: { [HOLDER1]: E('0.002'), [HOLDER2]: 1n, [EXCLUDED]: E('0.003') },
    mineImmediately: true,
    vaultOperator: SIGNER, // the vault delegated to our signer (test 7 flips this)
    curveKeeper: ethers.ZeroAddress,
    maxLogRange: 0n, // >0 => getLogs throws for wider ranges (busy-range simulation)
    sendFailures: 0, // >0 => the next N broadcasts throw after the intent is persisted

    address: SIGNER,
    chainId: async () => 4663,
    blockNumber: async () => chain.head,
    getLogs: async ({ address, fromBlock, toBlock, topics }) => {
      if (chain.maxLogRange > 0n && toBlock - fromBlock + 1n > chain.maxLogRange) throw new Error('query returned more than 10000 results');
      const set = (Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase());
      const wanted = topics?.[0] ? (Array.isArray(topics[0]) ? topics[0] : [topics[0]]) : null;
      return chain.logs.filter((l) => set.includes(l.address.toLowerCase()) && BigInt(l.blockNumber) >= fromBlock && BigInt(l.blockNumber) <= toBlock && (!wanted || wanted.includes(l.topics[0])));
    },
    read: async (addr, _abi, fn, args) => {
      if (fn === 'curves') return { quote: QUOTE, creator: HOLDER1, vault: VAULT, holdersBps: 10000, poolFee: 10000, virtualQuote: 0n, tokenReserve: 0n, realQuote: 0n, graduationQuote: 0n, graduated: true, exists: true };
      if (fn === 'balanceOf') return chain.vaultTokenFees;
      if (fn === 'operator') return chain.vaultOperator;
      if (fn === 'keeper') return chain.curveKeeper;
      throw new Error(`unexpected read ${fn}`);
    },
    simulate: async (addr, _abi, fn) => {
      if (fn === 'collectFees') return chain.collectable;
      throw new Error(`unexpected simulate ${fn}`);
    },
    contract: (addr, _abi) => {
      if (addr.toLowerCase() === VAULT.toLowerCase()) {
        return {
          target: addr,
          availableQuote: async () => chain.vaultAvailable,
          basketLength: async () => 1n,
          quote: async () => QUOTE,
          swapFee: async () => 3000n,
          allowanceHolder: async () => ethers.ZeroAddress,
          basket: async () => QUOTE, // quote-basket passthrough (no swap needed)
          weights: async () => 10000,
          paths: async () => '0x',
          excluded: async (a) => a.toLowerCase() === EXCLUDED.toLowerCase(),
          withdrawableOf: async (holder) => chain.withdrawable[holder] ?? chain.withdrawable[ethers.getAddress(holder)] ?? 0n,
        };
      }
      if (addr.toLowerCase() === QUOTER.toLowerCase()) {
        return {
          quoteExactInput: { staticCall: async () => [0n] },
          quoteExactInputSingle: { staticCall: async () => [0n] },
        };
      }
      throw new Error(`unexpected contract ${addr}`);
    },
    quoteSingle: async (_q, _in, _out, amountIn) => amountIn / 1000n, // 1 token fee -> 0.001 quote
    balance: async () => chain.signerBalance,
    nonce: async () => chain.accountNonce,
    feeData: async () => ({ maxFeePerGas: chain.fee }),
    estimateGas: async () => 200000n,
    send: async (tx) => {
      if (chain.sendFailures > 0) { chain.sendFailures--; throw new Error('replacement fee too low'); }
      const hash = '0x' + String(chain.sent.length + 1).padStart(64, '0');
      chain.sent.push({ ...tx, hash });
      if (chain.mineImmediately) {
        chain.receipts.set(hash, { status: 1, blockNumber: 99 });
        chain.accountNonce = tx.nonce + 1;
      }
      return hash;
    },
    receipt: async (hash) => chain.receipts.get(hash) ?? null,
    waitMined: async (hash) => chain.receipts.get(hash) ?? null,
  };
  return chain;
}

function freshCfg(dir, overrides = {}) {
  const cfg = loadConfig({
    DRY_RUN: 'false', PRIVATE_KEY: '0x' + '11'.repeat(32),
    FACTORY_V2_ADDRESS: FACTORY, CURVE_ADDRESS: CURVE, LOCKER_ADDRESS: LOCKER, QUOTER_ADDRESS: QUOTER,
    KEEPER_STATE_FILE: path.join(dir, 'state.json'), KEEPER_START_BLOCK: '1',
    PUSH_MIN_WEI: '1000000000000', MIN_SIGNER_WEI: '100000000000000000', MAX_FEE_GWEI: '50',
    REPLACE_AFTER_MS: '1000', ...overrides,
  });
  return cfg;
}
const silent = () => {};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-keeperd-'));

  // ---- 1. dry run discovers everything and signs nothing ----
  {
    const chain = makeFakeChain();
    const cfg = freshCfg(dir, { DRY_RUN: 'true', KEEPER_STATE_FILE: path.join(dir, 'dry.json') });
    const keeper = makeKeeper({ cfg, chain, log: silent });
    await keeper.cycle();
    assert.equal(chain.sent.length, 0, 'dry run must not sign');
    assert.ok(keeper.state.launches[TOKEN.toLowerCase()], 'launch discovered');
    assert.equal(keeper.state.launches[TOKEN.toLowerCase()].lockerTokenId, '7', 'graduation discovered');
    assert.equal(keeper.state.cursor, '100');
    console.log('PASS dry run: discovery persisted, zero signatures');
  }

  // ---- 2. live cycle executes the bounded pipeline in order ----
  const stateFile = path.join(dir, 'live.json');
  {
    const chain = makeFakeChain();
    const cfg = freshCfg(dir, { KEEPER_STATE_FILE: stateFile });
    const alerts = [];
    const keeper = makeKeeper({ cfg, chain, log: silent, alert: async (a) => alerts.push(a) });
    await keeper.cycle();
    const kinds = chain.sent.map((t) => t.to.toLowerCase());
    // collectFees -> locker; convertLaunchFees + distribute + claimFor(HOLDER1) -> vault.
    assert.equal(kinds[0], LOCKER.toLowerCase(), 'collect first');
    assert.equal(chain.sent.length, 4, `expected 4 transactions, got ${chain.sent.length}`);
    assert.deepEqual(chain.sent.map((t) => t.nonce), [5, 6, 7, 8], 'sequential managed nonces');
    // The push went only to HOLDER1: HOLDER2 is under PUSH_MIN_WEI, EXCLUDED is excluded.
    const claims = chain.sent.filter((t) => t.data.startsWith(new ethers.Interface(['function claimFor(address)']).getFunction('claimFor').selector));
    assert.equal(claims.length, 1);
    assert.ok(claims[0].data.toLowerCase().includes(HOLDER1.slice(2).toLowerCase()));
    // Holder balances tracked from Transfer logs.
    const launch = keeper.state.launches[TOKEN.toLowerCase()];
    assert.equal(BigInt(launch.holders[HOLDER1.toLowerCase()]), ethers.parseEther('50'));
    assert.equal(BigInt(launch.holders[HOLDER2.toLowerCase()]), ethers.parseEther('40'));
    assert.equal(keeper.state.pending, null, 'nothing left in flight');
    assert.equal(alerts.length, 0);
    console.log('PASS live cycle: collect -> convert -> distribute -> push, sequential nonces, thresholds and exclusions respected');
  }

  // ---- 3. restart from the state file: no duplicate discovery or re-push spam ----
  {
    const chain = makeFakeChain();
    const cfg = freshCfg(dir, { KEEPER_STATE_FILE: stateFile });
    chain.vaultAvailable = 0n; chain.vaultTokenFees = 0n; chain.collectable = [0n, 0n];
    chain.withdrawable = {};
    const keeper = makeKeeper({ cfg, chain, log: silent });
    assert.equal(keeper.state.cursor, '100', 'cursor resumed');
    await keeper.cycle();
    assert.equal(chain.sent.length, 0, 'nothing to do after restart');
    console.log('PASS restart: cursor and launch registry resumed from disk, no duplicate work');
  }

  // ---- 4. pending transaction recovery: mined, superseded, and stuck+replaced ----
  {
    const chain = makeFakeChain();
    const cfg = freshCfg(dir, { KEEPER_STATE_FILE: path.join(dir, 'pending.json') });
    const alerts = [];
    const keeper = makeKeeper({ cfg, chain, log: silent, alert: async (a) => alerts.push(a) });
    // a) mined while we were down
    keeper.state.pending = { kind: 'x', to: VAULT, data: '0x', nonce: 5, gasLimit: '200000', maxFeePerGas: '2000000000', hash: '0xmined', sentAt: Date.now() };
    chain.receipts.set('0xmined', { status: 1, blockNumber: 90 });
    assert.equal(await keeper.resolvePending(), true);
    assert.equal(keeper.state.pending, null);
    // b) superseded nonce
    keeper.state.pending = { kind: 'x', to: VAULT, data: '0x', nonce: 3, gasLimit: '200000', maxFeePerGas: '2000000000', hash: '0xgone', sentAt: Date.now() };
    assert.equal(await keeper.resolvePending(), true);
    assert.equal(keeper.state.pending, null);
    assert.ok(alerts.some((a) => a.message.includes('superseded')));
    // c) stuck: same nonce, replacement broadcast with a bumped fee
    keeper.state.pending = { kind: 'x', to: VAULT, data: '0xdead', nonce: 5, gasLimit: '200000', maxFeePerGas: '2000000000', hash: '0xstuck', sentAt: Date.now() - 10_000 };
    chain.mineImmediately = false;
    assert.equal(await keeper.resolvePending(), false, 'replacement still in flight');
    assert.equal(chain.sent.length, 1);
    assert.equal(chain.sent[0].nonce, 5, 'replacement reuses the nonce');
    assert.ok(BigInt(chain.sent[0].maxFeePerGas) > 2000000000n, 'fee bumped');
    assert.ok(BigInt(keeper.state.pending.maxFeePerGas) <= 50n * 10n ** 9n, 'fee capped by MAX_FEE_GWEI');
    assert.equal(keeper.state.pending.replacements, 1);
    console.log('PASS pending recovery: mined cleared, superseded cleared with alert, stuck replaced at same nonce under the fee cap');
  }

  // ---- 5. signer balance floor blocks live sends and alerts ----
  {
    const chain = makeFakeChain();
    const cfg = freshCfg(dir, { KEEPER_STATE_FILE: path.join(dir, 'broke.json') });
    chain.signerBalance = 1n; // below MIN_SIGNER_WEI
    const alerts = [];
    const keeper = makeKeeper({ cfg, chain, log: silent, alert: async (a) => alerts.push(a) });
    await keeper.cycle();
    assert.equal(chain.sent.length, 0, 'no transactions with an underfunded signer');
    assert.ok(alerts.some((a) => a.message.includes('MIN_SIGNER_WEI')));
    console.log('PASS signer floor: underfunded signer sends nothing and raises an alert');
  }

  // ---- 6. state file is atomic and BigInt-safe ----
  {
    const f = path.join(dir, 'atomic.json');
    const { saveState } = require('./src/keeperd.js');
    saveState(f, { cursor: '100', big: 123n, nested: { v: 456n } });
    const back = loadState(f);
    assert.equal(back.big, 123n);
    assert.equal(back.nested.v, 456n);
    assert.ok(!fs.existsSync(f + '.tmp'));
    console.log('PASS state file: atomic write, BigInt round-trip');
  }

  // ---- 7. H1: an undelegated vault skips convert/distribute but collect + push still run ----
  {
    const chain = makeFakeChain();
    chain.vaultOperator = OTHER; // creator never ran setOperator(keeper) and no curve keeper is registered
    const cfg = freshCfg(dir, { KEEPER_STATE_FILE: path.join(dir, 'undelegated.json') });
    const alerts = [];
    const keeper = makeKeeper({ cfg, chain, log: silent, alert: async (a) => alerts.push(a) });
    await keeper.cycle();
    assert.equal(chain.sent.length, 2, `collect + push only, got ${chain.sent.length}`);
    assert.equal(chain.sent[0].to.toLowerCase(), LOCKER.toLowerCase());
    assert.ok(chain.sent[1].data.startsWith(new ethers.Interface(['function claimFor(address)']).getFunction('claimFor').selector), 'push still delivered');
    assert.equal(alerts.filter((a) => a.level === 'error').length, 0, 'no error storm for an undelegated vault');
    // Registering our signer as the curve keeper authorizes every vault without per-coin delegation.
    chain.curveKeeper = SIGNER;
    chain.vaultAvailable = ethers.parseEther('0.5'); chain.vaultTokenFees = ethers.parseEther('25'); chain.collectable = [0n, 0n]; chain.withdrawable = {};
    await keeper.cycle();
    assert.equal(chain.sent.length, 4, 'convert + distribute ran once the curve keeper is the signer');
    console.log('PASS authority: undelegated vault skips convert/distribute without errors, push still runs; curve keeper authorizes all vaults');
  }

  // ---- 8. H2: a failed broadcast never stalls the daemon; the intent is cleared once the nonce is confirmed unconsumed ----
  {
    const chain = makeFakeChain();
    chain.sendFailures = 1;
    const cfg = freshCfg(dir, { KEEPER_STATE_FILE: path.join(dir, 'broadcast.json') });
    const alerts = [];
    const keeper = makeKeeper({ cfg, chain, log: silent, alert: async (a) => alerts.push(a) });
    await keeper.cycle();
    assert.ok(alerts.some((a) => a.message.includes('broadcast failed')), 'failed broadcast alerted');
    // The next managed send sees hash=null + nonce unconsumed -> clears the intent and proceeds.
    assert.ok(alerts.some((a) => a.message.includes('never broadcast')), 'stale intent recognised');
    assert.equal(keeper.state.pending, null, 'stale intent cleared');
    assert.ok(chain.sent.length >= 1, 'work resumed after the failed broadcast');
    assert.equal(chain.sent[0].nonce, 5, 'the unconsumed nonce was reused, not skipped');
    console.log('PASS broadcast failure: pending{hash:null} is recovered on the next cycle instead of stalling forever');
  }

  // ---- 9. H3: a busy block range halves the log chunk instead of stalling discovery ----
  {
    const chain = makeFakeChain();
    chain.maxLogRange = 16n; // the RPC refuses anything wider
    const cfg = freshCfg(dir, { KEEPER_STATE_FILE: path.join(dir, 'busy.json'), KEEPER_LOG_CHUNK: '64', DRY_RUN: 'true' });
    const keeper = makeKeeper({ cfg, chain, log: silent });
    await keeper.cycle();
    assert.equal(keeper.state.cursor, '100', 'discovery reached the head through narrower chunks');
    assert.ok(keeper.state.launches[TOKEN.toLowerCase()], 'launch still discovered');
    assert.equal(BigInt(keeper.state.launches[TOKEN.toLowerCase()].holders[HOLDER2.toLowerCase()]), ethers.parseEther('40'), 'holders still tracked');
    console.log('PASS busy range: getLogs failures shrink the chunk and discovery completes');
  }

  // ---- 10. DRY_RUN is sign-free even with a stale pending record; replaced hashes are kept ----
  {
    const chain = makeFakeChain();
    const cfg = freshCfg(dir, { KEEPER_STATE_FILE: path.join(dir, 'drypending.json'), DRY_RUN: 'true' });
    const keeper = makeKeeper({ cfg, chain, log: silent });
    keeper.state.pending = { kind: 'x', to: VAULT, data: '0xdead', nonce: 5, gasLimit: '200000', maxFeePerGas: '2000000000', hash: '0xstuck', sentAt: Date.now() - 10_000 };
    assert.equal(await keeper.resolvePending(), false);
    assert.equal(chain.sent.length, 0, 'dry run must not broadcast a replacement');
    // Live: replacement keeps the original hash; a mined original still resolves the record.
    const live = makeKeeper({ cfg: freshCfg(dir, { KEEPER_STATE_FILE: path.join(dir, 'replaced.json') }), chain, log: silent });
    live.state.pending = { kind: 'x', to: VAULT, data: '0xdead', nonce: 5, gasLimit: '200000', maxFeePerGas: '2000000000', hash: '0xorig', sentAt: Date.now() - 10_000 };
    chain.mineImmediately = false;
    assert.equal(await live.resolvePending(), false);
    assert.deepEqual(live.state.pending.replaced, ['0xorig']);
    chain.receipts.set('0xorig', { status: 1, blockNumber: 95 });
    assert.equal(await live.resolvePending(), true, 'mined original recognised after replacement');
    assert.equal(live.state.pending, null);
    console.log('PASS replacement: dry run signs nothing; replaced hashes are retained and a mined original resolves the record');
  }

  // ---- 11. M15: corrupt state refuses to start; lock file keeps a second daemon off the same state ----
  {
    const { acquireLock } = require('./src/keeperd.js');
    const f = path.join(dir, 'corrupt.json');
    fs.writeFileSync(f, '{"launches":{"x":');
    assert.throws(() => loadState(f), /corrupt/);
    fs.writeFileSync(f + '.lock', String(process.ppid)); // held by a live process (our parent shell)
    assert.throws(() => acquireLock(f), /another keeperd/);
    fs.writeFileSync(f + '.lock', '999999999'); // stale lock from a dead pid is reclaimed
    const release = acquireLock(f);
    assert.equal(fs.readFileSync(f + '.lock', 'utf8'), String(process.pid));
    release();
    assert.ok(!fs.existsSync(f + '.lock'), 'lock released on exit');
    console.log('PASS state safety: corrupt state file is a hard error; lock file rejects a second instance');
  }

  // ---- 12. cycle-level failure raises an alert instead of crashing silently ----
  {
    const chain = makeFakeChain();
    chain.blockNumber = async () => { throw new Error('RPC down'); };
    const cfg = freshCfg(dir, { KEEPER_STATE_FILE: path.join(dir, 'rpcdown.json') });
    const alerts = [];
    const keeper = makeKeeper({ cfg, chain, log: silent, alert: async (a) => alerts.push(a) });
    await keeper.cycle();
    assert.ok(alerts.some((a) => a.message.includes('discovery/recovery failed')));
    assert.equal(chain.sent.length, 0);
    await keeper.cycle();
    assert.equal(alerts.length, 1, 'identical alert deduplicated within ALERT_REPEAT_MS');
    console.log('PASS cycle failure: alerted via webhook (deduplicated), nothing sent, no crash');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ALL KEEPERD CHECKS PASSED');
})().catch((e) => { console.error(e); process.exitCode = 1; });
