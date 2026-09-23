// Production keeper daemon checks: durable discovery, bounded pipeline, managed transactions with
// nonce/replacement recovery, signer limits, crash resume from the state file. Uses the REAL
// keeperd code with a deterministic fake chain adapter. Run: node keeperd.readiness.cjs
// Tests 1-12 cover the legacy V3 cycle; the V4-* block at the end covers the V4 product
// (LaunchedV4/Graduated(poolId) discovery, hook.claimFor collection, distribute minOut planning for a
// [quote, stock] basket pre/post graduation via the shared Uniswap/0x planners, the stale launch-token
// basket guard, pushes, restart, reflection-off launches, startup wiring, combined process).
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

  // =====================================================================================
  // V4 product: LaunchFactoryV4 + CensusCurveV4 + CensusV4Hook + CensusRewardVault.
  // Same real keeperd code, same fake-chain approach; the V4 fake extends the legacy one so a
  // combined (legacy + V4 in one process) cycle can be exercised too.
  // =====================================================================================
  const { verifyV4Wiring } = require('./src/keeperd.js');
  const { applySlippage } = require('./src/keeper0x.js');
  const FACTORY4 = '0x' + 'f4'.repeat(20);
  const CURVE4 = '0x' + 'c4'.repeat(20);
  const HOOK = '0x' + '44'.repeat(20);
  const ROUTER4 = '0x' + '74'.repeat(20);
  const POOL_MANAGER = '0x' + 'a4'.repeat(20);
  const GRADUATOR = '0x' + '64'.repeat(20);
  const TREASURY = '0x' + '77'.repeat(20);
  const CREATOR = '0x' + '88'.repeat(20);
  const TOKEN4 = '0x' + 'ac'.repeat(20);
  const TOKEN_NOREF = '0x' + 'ad'.repeat(20); // reflection off: no vault
  const VAULT4 = '0x' + 'b4'.repeat(20);
  const STOCK = '0x' + '5c'.repeat(20);
  const POOL_ID = '0x' + '1234'.repeat(16);
  const lc = (a) => String(a).toLowerCase();
  const FACTORY4_IFACE = new ethers.Interface(['event LaunchedV4(address indexed token, address indexed creator, address curve, address vault, uint16 reflectionBps, address quote)']);
  const CURVE4_IFACE = new ethers.Interface(['event Graduated(address indexed coin, bytes32 indexed poolId, uint256 tokensIn, uint256 quoteIn, uint128 liquidity)']);
  const VAULT_IFACE = new ethers.Interface(['function distribute(uint256[] minOut)', 'function distributeVia0x(uint256[] sellAmounts, bytes[] swapData, uint256[] minOut)', 'function claimFor(address holder)']);
  const HOOK_IFACE = new ethers.Interface(['function claimFor(address asset, address recipient)']);
  const E = (n) => ethers.parseEther(n);
  const BAL4 = E('1'); // vault.availableQuote()
  const WEIGHT_QUOTE = 7000, WEIGHT_STOCK = 3000;
  const PORTION_STOCK = (BAL4 * BigInt(WEIGHT_STOCK)) / 10000n;

  function makeFakeChainV4() {
    const chain = Object.assign(makeFakeChain(), {
      head: 40n, // before the graduation blocks (50/55); raise to 100n to discover them
      hookRegistrar: GRADUATOR, routerHook: HOOK, curveKeeperV4: SIGNER,
      vault4Operator: OTHER, // not delegated per vault: authority comes from curve.keeper()
      hookClaimable: { [VAULT4]: E('0.05'), [CREATOR]: E('0.01'), [TREASURY]: E('0.02') },
      vault4Available: BAL4,
      // A current CensusRewardVault basket: the quote asset and/or allow-listed stocks, never the launch token.
      basket4: [QUOTE, STOCK], weights4: [WEIGHT_QUOTE, WEIGHT_STOCK],
      withdrawable4: { [HOLDER1]: E('0.002') },
      curveReads: [], v3Quotes: [],
    });
    chain.logs.push(
      mkLog(FACTORY4, FACTORY4_IFACE, 'LaunchedV4', [TOKEN4, CREATOR, CURVE4, VAULT4, 300, QUOTE], 10),
      mkLog(TOKEN4, TOKEN_IFACE, 'Transfer', [ethers.ZeroAddress, HOLDER1, E('100')], 11),
      mkLog(TOKEN4, TOKEN_IFACE, 'Transfer', [HOLDER1, HOLDER2, E('40')], 12),
      mkLog(TOKEN4, TOKEN_IFACE, 'Transfer', [HOLDER1, EXCLUDED, E('10')], 13),
      mkLog(FACTORY4, FACTORY4_IFACE, 'LaunchedV4', [TOKEN_NOREF, CREATOR, CURVE4, ethers.ZeroAddress, 0, QUOTE], 15),
      mkLog(CURVE4, CURVE4_IFACE, 'Graduated', [TOKEN4, POOL_ID, E('800000000'), E('10'), 12345n], 50),
      mkLog(CURVE4, CURVE4_IFACE, 'Graduated', [TOKEN_NOREF, '0x' + 'ab'.repeat(32), E('800000000'), E('10'), 1n], 55),
    );
    const baseRead = chain.read, baseContract = chain.contract;
    chain.read = async (addr, abi, fn, args) => {
      const a = lc(addr);
      if (a === lc(CURVE4)) {
        chain.curveReads.push(fn);
        if (fn === 'keeper') return chain.curveKeeperV4;
        if (fn === 'graduator') return GRADUATOR;
        throw new Error(`unexpected V4 curve read ${fn} (the keeper never prices anything on the curve)`);
      }
      if (a === lc(HOOK)) {
        if (fn === 'registrar') return chain.hookRegistrar;
        if (fn === 'manager') return POOL_MANAGER;
        if (fn === 'protocol') return TREASURY;
        if (fn === 'claimable') { assert.equal(lc(args[0]), lc(QUOTE), 'hook claims are keyed on the launch quote'); return chain.hookClaimable[lc(args[1])] ?? 0n; }
      }
      if (a === lc(ROUTER4) && fn === 'hook') return chain.routerHook;
      if (a === lc(VAULT4) && fn === 'operator') return chain.vault4Operator;
      return baseRead(addr, abi, fn, args);
    };
    chain.contract = (addr, abi) => {
      const a = lc(addr);
      if (a === lc(VAULT4)) {
        return {
          target: addr,
          availableQuote: async () => chain.vault4Available,
          basketLength: async () => BigInt(chain.basket4.length),
          quote: async () => QUOTE,
          token: async () => TOKEN4,
          swapFee: async () => 3000n,
          allowanceHolder: async () => ethers.ZeroAddress,
          basket: async (i) => chain.basket4[Number(i)],
          weights: async (i) => chain.weights4[Number(i)],
          paths: async () => '0x',
          excluded: async (h) => lc(h) === lc(EXCLUDED),
          withdrawableOf: async (holder, asset) => (lc(asset) === lc(STOCK) ? (chain.withdrawable4[lc(holder)] ?? 0n) : 0n),
        };
      }
      if (a === lc(QUOTER)) {
        return {
          quoteExactInput: { staticCall: async () => { throw new Error('no multi-hop route in this fake'); } },
          quoteExactInputSingle: { staticCall: async (p) => { chain.v3Quotes.push(p); return [BigInt(p.amountIn) * 3n]; } }, // 3 stock per quote unit
        };
      }
      return baseContract(addr, abi);
    };
    return chain;
  }
  const V4_ENV = { CURVE_V4_ADDRESS: CURVE4, FACTORY_V4_ADDRESS: FACTORY4, HOOK_ADDRESS: HOOK, V4_ROUTER_ADDRESS: ROUTER4, POOL_MANAGER_ADDRESS: POOL_MANAGER, QUOTER_ADDRESS: QUOTER };
  // Expected distribute(minOut[]) for the [quote, stock] basket: quote entry 0, stock via the V3 quoter at SLIPPAGE_BPS.
  const EXPECTED_MIN_OUT = [0n, applySlippage(PORTION_STOCK * 3n)];
  function v4Cfg(dir, overrides = {}) {
    return loadConfig({
      DRY_RUN: 'false', PRIVATE_KEY: '0x' + '11'.repeat(32), ...V4_ENV,
      KEEPER_STATE_FILE: path.join(dir, 'v4.json'), KEEPER_START_BLOCK: '1',
      PUSH_MIN_WEI: '1000000000000', MIN_SIGNER_WEI: '100000000000000000', MAX_FEE_GWEI: '50', REPLACE_AFTER_MS: '1000', ...overrides,
    });
  }
  const txsTo = (chain, addr, selector) => chain.sent.filter((t) => lc(t.to) === lc(addr) && (!selector || t.data.startsWith(selector)));
  const hookRecipients = (chain) => txsTo(chain, HOOK, HOOK_IFACE.getFunction('claimFor').selector).map((t) => { const d = HOOK_IFACE.decodeFunctionData('claimFor', t.data); assert.equal(lc(d[0]), lc(QUOTE)); return lc(d[1]); });
  const distributeMinOut = (chain) => txsTo(chain, VAULT4, VAULT_IFACE.getFunction('distribute').selector).map((t) => [...VAULT_IFACE.decodeFunctionData('distribute', t.data)[0]].map(BigInt));

  // ---- V4-1. dry run: LaunchedV4 discovery (vault + reflection-off), own cursor, plan logged, nothing signed ----
  {
    const chain = makeFakeChainV4();
    const cfg = v4Cfg(dir, { DRY_RUN: 'true', KEEPER_STATE_FILE: path.join(dir, 'v4-dry.json') });
    assert.equal(cfg.v4, true); assert.equal(cfg.legacy, false);
    const lines = [];
    const keeper = makeKeeper({ cfg, chain, log: (...a) => lines.push(a.join(' ')) });
    await keeper.cycle();
    assert.equal(chain.sent.length, 0, 'dry run must not sign');
    const reg = keeper.state.v4;
    assert.equal(reg.cursor, '40', 'V4 cursor persisted');
    assert.equal(keeper.state.cursor, null, 'legacy cursor untouched when the legacy cycle is off');
    const l = reg.launches[lc(TOKEN4)];
    assert.ok(l, 'V4 launch discovered');
    assert.deepEqual([l.vault, l.creator, l.quote, l.reflectionBps, l.graduated, l.poolId], [lc(VAULT4), lc(CREATOR), lc(QUOTE), 300, false, null]);
    assert.equal(reg.launches[lc(TOKEN_NOREF)].vault, ethers.ZeroAddress, 'reflection-off launch recorded without a vault');
    assert.ok(lines.some((x) => x.includes('[dry] would send distribute:')), 'the distribution was planned in dry run');
    assert.equal(chain.v3Quotes.length, 1, 'the stock leg was priced through the shared Uniswap planner');
    assert.ok(!chain.curveReads.some((fn) => fn !== 'keeper' && fn !== 'graduator'), 'nothing is priced on the curve');
    console.log('PASS v4 dry run: LaunchedV4 discovery persisted under its own cursor, plan produced, zero signatures');
  }

  // ---- V4-2. live, pre-graduation: no hook claims yet; distribute [quote, stock] with planner-priced stock minOut; push ----
  const v4State = path.join(dir, 'v4-live.json');
  {
    const chain = makeFakeChainV4();
    const cfg = v4Cfg(dir, { KEEPER_STATE_FILE: v4State });
    const alerts = [];
    const keeper = makeKeeper({ cfg, chain, log: silent, alert: async (a) => alerts.push(a) });
    await keeper.cycle();
    assert.equal(txsTo(chain, HOOK).length, 0, 'nothing to claim from the hook before graduation');
    const mins = distributeMinOut(chain);
    assert.equal(mins.length, 1, 'one distribute');
    // [quote, stock]: 0 for the quote entry (pinned), V3 quoter at SLIPPAGE_BPS for the stock — as for a legacy vault.
    assert.deepEqual(mins[0], EXPECTED_MIN_OUT);
    assert.equal(chain.v3Quotes.length, 1, 'the stock leg used the shared Uniswap planner');
    assert.equal(lc(chain.v3Quotes[0].tokenIn), lc(QUOTE));
    assert.equal(lc(chain.v3Quotes[0].tokenOut), lc(STOCK));
    assert.equal(BigInt(chain.v3Quotes[0].amountIn), PORTION_STOCK);
    assert.ok(!chain.curveReads.some((fn) => fn !== 'keeper' && fn !== 'graduator'), 'nothing is priced on the curve');
    const pushes = txsTo(chain, VAULT4, VAULT_IFACE.getFunction('claimFor').selector);
    assert.equal(pushes.length, 1, 'one push');
    assert.equal(lc(VAULT_IFACE.decodeFunctionData('claimFor', pushes[0].data)[0]), lc(HOLDER1), 'pushed to the holder over PUSH_MIN_WEI (HOLDER2 under, EXCLUDED excluded)');
    assert.equal(chain.sent.length, 2, `distribute + push only, got ${chain.sent.length}`);
    assert.deepEqual(chain.sent.map((t) => t.nonce), [5, 6], 'sequential managed nonces');
    const l = keeper.state.v4.launches[lc(TOKEN4)];
    assert.equal(BigInt(l.holders[lc(HOLDER1)]), E('50')); assert.equal(BigInt(l.holders[lc(HOLDER2)]), E('40'));
    assert.equal(alerts.length, 0);
    assert.equal(keeper.state.pending, null);
    console.log('PASS v4 pre-graduation: distribute minOut = [0, quoter - slippage], push delivered, no hook work, nothing priced on the curve');
  }

  // ---- V4-3. restart + graduation: cursor/registry resumed, Graduated(poolId) discovered, hook.claimFor(quote, vault),
  //           same planner-priced minOut after graduation, creator/treasury claims deduped, reflection-off launch gets no vault work ----
  {
    const chain = makeFakeChainV4();
    chain.head = 100n;
    const cfg = v4Cfg(dir, { KEEPER_STATE_FILE: v4State });
    const alerts = [];
    const keeper = makeKeeper({ cfg, chain, log: silent, alert: async (a) => alerts.push(a) });
    assert.equal(keeper.state.v4.cursor, '40', 'V4 cursor resumed from disk');
    assert.ok(keeper.state.v4.launches[lc(TOKEN4)], 'registry resumed');
    await keeper.cycle();
    const reg = keeper.state.v4;
    assert.equal(reg.cursor, '100');
    assert.equal(reg.launches[lc(TOKEN4)].graduated, true);
    assert.equal(reg.launches[lc(TOKEN4)].poolId, POOL_ID, 'bytes32 poolId recorded from Graduated');
    assert.equal(reg.launches[lc(TOKEN_NOREF)].graduated, true);
    // Hook claims: vault, creator, treasury — each exactly once although two launches share quote+creator.
    assert.deepEqual(hookRecipients(chain).sort(), [lc(TREASURY), lc(CREATOR), lc(VAULT4)].sort());
    assert.equal(lc(chain.sent[0].to), lc(HOOK), 'vault collection first');
    assert.equal(lc(HOOK_IFACE.decodeFunctionData('claimFor', chain.sent[0].data)[1]), lc(VAULT4));
    // Post-graduation minOut comes from the very same planners (no curve, no V4 pool quote): [0, quoter - slippage].
    const mins = distributeMinOut(chain);
    assert.equal(mins.length, 1);
    assert.deepEqual(mins[0], EXPECTED_MIN_OUT);
    assert.equal(chain.v3Quotes.length, 1, 'stock leg priced by the shared Uniswap planner after graduation too');
    assert.equal(lc(chain.v3Quotes[0].tokenOut), lc(STOCK));
    assert.ok(!chain.curveReads.some((fn) => fn !== 'keeper' && fn !== 'graduator'), 'curve never consulted for pricing');
    // Every transaction targets the hook or the reflection vault: the reflection-off launch got no vault work or push.
    for (const t of chain.sent) assert.ok([lc(HOOK), lc(VAULT4)].includes(lc(t.to)), `unexpected target ${t.to}`);
    assert.equal(chain.sent.length, 5, `claim(vault) + distribute + claim(creator) + claim(treasury) + push, got ${chain.sent.length}`);
    assert.deepEqual(chain.sent.map((t) => t.nonce), [5, 6, 7, 8, 9]);
    assert.equal(alerts.length, 0);
    console.log('PASS v4 graduation + restart: resumed from disk, poolId recorded, hook.claimFor(quote, vault/creator/treasury) once each, planner minOut unchanged, reflection-off launch skipped');
  }

  // ---- V4-4. stale deployment guard: a basket that still names the launch token is never distributed; one alert, one log line;
  //           claims and pushes still run; the skip survives a restart without re-alerting ----
  {
    const chain = makeFakeChainV4();
    chain.head = 100n;
    chain.basket4 = [TOKEN4, QUOTE, STOCK]; chain.weights4 = [5000, 3000, 2000]; // impossible with current contracts
    const stale = path.join(dir, 'v4-stale.json');
    const cfg = v4Cfg(dir, { KEEPER_STATE_FILE: stale });
    const alerts = [], lines = [];
    const keeper = makeKeeper({ cfg, chain, log: (...a) => lines.push(a.join(' ')), alert: async (a) => alerts.push(a) });
    await keeper.cycle();
    await keeper.cycle();
    assert.equal(distributeMinOut(chain).length, 0, 'no distribute for a basket holding the launch token');
    assert.equal(txsTo(chain, VAULT4, VAULT_IFACE.getFunction('distributeVia0x').selector).length, 0);
    const guard = alerts.filter((a) => a.message.includes('names the launch token'));
    assert.equal(guard.length, 1, 'exactly one alert across two cycles');
    assert.equal(guard[0].level, 'error');
    assert.equal(lc(guard[0].detail.token), lc(TOKEN4));
    assert.equal(lines.filter((x) => x.includes('names the launch token')).length, 1, 'logged once, not every cycle');
    assert.equal(keeper.state.v4.launches[lc(TOKEN4)].launchTokenBasket, true, 'skip flag persisted on the launch record');
    assert.equal(chain.v3Quotes.length, 0, 'no leg was priced at all');
    // The fake hook/vault never drain, so claims and the push recur every cycle: 3 hook claims + 1 push per cycle.
    assert.equal(hookRecipients(chain).length, 6, 'hook claims unaffected (3 per cycle x 2 cycles)');
    assert.equal(txsTo(chain, VAULT4, VAULT_IFACE.getFunction('claimFor').selector).length, 2, 'push unaffected (1 per cycle x 2 cycles)');
    assert.equal(alerts.filter((a) => a.message.includes('pipeline failed')).length, 0, 'guard is a clean skip, not a pipeline error');
    // Restart from the persisted state: still skipped, still silent, other work still running.
    const again = makeKeeper({ cfg: v4Cfg(dir, { KEEPER_STATE_FILE: stale }), chain, log: (...a) => lines.push(a.join(' ')), alert: async (a) => alerts.push(a) });
    await again.cycle();
    assert.equal(distributeMinOut(chain).length, 0);
    assert.equal(alerts.filter((a) => a.message.includes('names the launch token')).length, 1, 'no re-alert after restart');
    assert.equal(lines.filter((x) => x.includes('names the launch token')).length, 1, 'no re-log after restart');
    assert.equal(hookRecipients(chain).length, 9, 'hook claims keep running after the restart');
    assert.equal(txsTo(chain, VAULT4, VAULT_IFACE.getFunction('claimFor').selector).length, 3, 'pushes keep running after the restart');
    console.log('PASS v4 stale basket guard: launch token in a V4 basket -> distribute skipped for good with a single alert; claims and pushes continue');
  }

  // ---- V4-5. undelegated V4 vault (no curve keeper, operator elsewhere): collect + push run, distribute skipped ----
  {
    const chain = makeFakeChainV4();
    chain.head = 100n; chain.curveKeeperV4 = ethers.ZeroAddress;
    const cfg = v4Cfg(dir, { KEEPER_STATE_FILE: path.join(dir, 'v4-undelegated.json') });
    const alerts = [];
    const keeper = makeKeeper({ cfg, chain, log: silent, alert: async (a) => alerts.push(a) });
    await keeper.cycle();
    assert.equal(distributeMinOut(chain).length, 0, 'distribute needs operator or curve keeper');
    assert.equal(hookRecipients(chain).length, 3);
    assert.equal(txsTo(chain, VAULT4, VAULT_IFACE.getFunction('claimFor').selector).length, 1);
    assert.equal(alerts.filter((a) => a.level === 'error').length, 0);
    console.log('PASS v4 authority: undelegated vault skips distribute without errors; permissionless claims and pushes still run');
  }

  // ---- V4-6. startup wiring: mismatched hook/router/pool manager refused; keeper mismatch warns in dry run, refuses live ----
  {
    const chain = makeFakeChainV4();
    const live = v4Cfg(dir, { KEEPER_STATE_FILE: path.join(dir, 'v4-wiring.json') });
    const ok = await verifyV4Wiring(live, chain, silent);
    assert.deepEqual(ok, { registrar: lc(GRADUATOR), routerHook: lc(HOOK), keeper: lc(SIGNER) });
    chain.routerHook = OTHER;
    await assert.rejects(verifyV4Wiring(live, chain, silent), /router\.hook\(\)/, 'router pointing at another hook is refused');
    chain.routerHook = HOOK; chain.hookRegistrar = OTHER;
    await assert.rejects(verifyV4Wiring(live, chain, silent), /registrar/, 'hook not registered by the curve graduator is refused');
    chain.hookRegistrar = GRADUATOR;
    await assert.rejects(verifyV4Wiring(v4Cfg(dir, { POOL_MANAGER_ADDRESS: OTHER }), chain, silent), /manager/, 'wrong pool manager is refused');
    chain.curveKeeperV4 = OTHER;
    await assert.rejects(verifyV4Wiring(live, chain, silent), /curve\.keeper\(\)/, 'live run refuses a signer that is not the curve keeper');
    const warned = [];
    const dry = v4Cfg(dir, { DRY_RUN: 'true' });
    assert.equal((await verifyV4Wiring(dry, chain, (m) => warned.push(m))).keeper, lc(OTHER));
    assert.ok(warned.some((m) => m.includes('curve.keeper()')), 'dry run warns instead');
    console.log('PASS v4 wiring: hook/router/pool-manager mismatches refused; keeper mismatch warns in dry run and refuses live');
  }

  // ---- V4-7. both products in one process: separate registries and cursors, one shared managed-nonce stream ----
  {
    const chain = makeFakeChainV4();
    chain.head = 100n;
    const cfg = freshCfg(dir, { ...V4_ENV, KEEPER_STATE_FILE: path.join(dir, 'both.json') });
    assert.equal(cfg.legacy, true); assert.equal(cfg.v4, true);
    const alerts = [];
    const keeper = makeKeeper({ cfg, chain, log: silent, alert: async (a) => alerts.push(a) });
    await keeper.cycle();
    assert.ok(keeper.state.launches[lc(TOKEN)] && !keeper.state.launches[lc(TOKEN4)], 'legacy registry holds only LaunchedV2 launches');
    assert.ok(keeper.state.v4.launches[lc(TOKEN4)] && !keeper.state.v4.launches[lc(TOKEN)], 'V4 registry holds only LaunchedV4 launches');
    assert.equal(keeper.state.cursor, '100'); assert.equal(keeper.state.v4.cursor, '100');
    const targets = chain.sent.map((t) => lc(t.to));
    assert.equal(targets[0], lc(LOCKER), 'legacy collect first');
    assert.equal(txsTo(chain, VAULT).length, 3, 'legacy convert + distribute + push');
    assert.equal(hookRecipients(chain).length, 3); assert.equal(distributeMinOut(chain).length, 1);
    assert.equal(chain.sent.length, 9, `4 legacy + 5 V4, got ${chain.sent.length}`);
    assert.deepEqual(chain.sent.map((t) => t.nonce), [5, 6, 7, 8, 9, 10, 11, 12, 13], 'one nonce stream across both products');
    assert.equal(alerts.length, 0);
    console.log('PASS combined: legacy V3 and V4 cycles run in one process with separate registries and a single managed nonce stream');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ALL KEEPERD CHECKS PASSED');
})().catch((e) => { console.error(e); process.exitCode = 1; });
