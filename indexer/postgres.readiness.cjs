// REAL PostgreSQL readiness harness (no Docker needed): runs the ACTUAL ingest/api source against
// an embedded PostgreSQL server (real postgres.exe via the embedded-postgres npm package).
// Covers the previously-open gates that the in-memory harness could not:
//   1. committed Prisma migrations deploy onto a clean database (B13)
//   2. serializable transactions + advisory lock on real Postgres (B10/B11)
//   3. restart/replay determinism: digests equal across clean, fault-injected and resumed runs
//   4. TWO concurrent workers over the same range apply every event exactly once
//   5. hard-kill of the postgres process mid-ingest, WAL recovery, resume to an identical digest
//   6. SQL-level logical export/restore into a freshly-migrated database (pg_dump rehearsal on the
//      production toolchain remains a release gate; these binaries ship without pg_dump)
//   7. the actual Fastify API served from real Postgres data under concurrent load
// RPC is mocked deterministically — chain data is not what this harness tests. Run: npm run test:pg
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const { EventEmitter } = require('node:events');

const ROOT = __dirname;
const PASSWORD = 'census-test';
const jsonBig = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

function code(file, tail = '') {
  return ts.transpileModule(
    fs.readFileSync(path.join(ROOT, 'src', file), 'utf8').replace(/^import .*;\r?$/gm, '') + tail,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
}

// ---------- embedded postgres ----------
async function startServer(dataDir, port, { fresh } = { fresh: true }) {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: PASSWORD, port, persistent: true });
  if (fresh) await pg.initialise();
  await pg.start();
  return pg;
}
function killServerHard(dataDir) {
  const pid = Number(fs.readFileSync(path.join(dataDir, 'postmaster.pid'), 'utf8').split(/\r?\n/)[0]);
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `taskkill failed: ${r.stderr}`);
  } else {
    process.kill(pid, 'SIGKILL'); // postmaster dies without a checkpoint; backends follow
  }
}
function dbUrl(port, name) {
  return `postgresql://postgres:${PASSWORD}@127.0.0.1:${port}/${name}?schema=public&connection_limit=10`;
}
function migrateDeploy(url) {
  const r = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', shell: true, timeout: 120000,
  });
  assert.equal(r.status, 0, `prisma migrate deploy failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
function prismaClient(url) {
  const { PrismaClient } = require('@prisma/client');
  return new PrismaClient({ datasources: { db: { url } } });
}

// ---------- deterministic mock chain ----------
const COINS = ['0x' + 'c1'.repeat(20), '0x' + 'c2'.repeat(20), '0x' + 'c3'.repeat(20)];
const QUOTE = '0x' + 'ee'.repeat(20);
// logPage 20 blocks => every run commits many separate serializable transactions (pages).
// Both products in one deployment: the legacy V3 curve and the V4 curve + PoolManager + hook.
const CFG = {
  chainId: 4663, curve: '0x' + 'cc'.repeat(20), curveV4: '0x' + 'cd'.repeat(20), poolManager: '0x' + 'de'.repeat(20), hook: '0x' + 'df'.repeat(20),
  weth: QUOTE, ethUsd: 3000, logPage: 20n, startBlock: 1n, pollMs: 50,
};

const POOL = '0x' + 'dd'.repeat(20);
const VAULT0 = '0x' + 'bb'.repeat(20);
// V4 coin: registered with 2% reflection, N_V4 curve buys (each with its FeeAllocated), graduated into a
// hooked V4 pool (poolId), one pool buy + one pool sell (PoolManager Swap + hook FeeAccrued), then the
// vault/hook reward lifecycle. COIN_V4 (0xc4..) < QUOTE (0xee..) so the coin is currency0.
const COIN_V4 = '0x' + 'c4'.repeat(20);
const VAULT_V4 = '0x' + 'b4'.repeat(20);
const POOL_ID_V4 = '0x' + '04'.repeat(32);
const N_V4 = 20;
const REGISTRATIONS = COINS.length + 1;
// CensusFeeMath.calculate: total = gross*(200+reflection)/1e4 (no penalty here), holders = gross*reflection/1e4,
// shared = total-holders, protocol = shared*(9000 curve | 3000 pool)/1e4, creator = shared-protocol.
function feeSplit(gross, reflectionBps, graduated) {
  const total = gross * BigInt(200 + reflectionBps) / 10000n, holders = gross * BigInt(reflectionBps) / 10000n, shared = total - holders;
  const protocol = shared * (graduated ? 3000n : 9000n) / 10000n;
  return { total, holders, protocol, creator: shared - protocol };
}
function makeStream(nTrades, nDupes) {
  const logs = [];
  const mk = (address, eventName, block, tx, logIndex, args) => ({
    address, eventName, args, blockNumber: BigInt(block), blockHash: 'hash' + block, transactionHash: tx, logIndex,
  });
  for (let i = 0; i < COINS.length; i++) {
    logs.push(mk(CFG.curve, 'Registered', 1, '0xreg' + i, i, {
      coin: COINS[i], quote: QUOTE, creator: '0x' + 'aa'.repeat(20),
      vault: i === 0 ? VAULT0 : '0x0000000000000000000000000000000000000000',
      holdersBps: i === 0 ? 10000 : 0, virtualQuote: 10n ** 18n, graduationQuote: 4n * 10n ** 18n,
      ...(i === 1 ? { virtualTokenOffset: 10n ** 24n } : {}), // mix PF + historical registrations
    }));
  }
  const perBlock = 10;
  for (let i = 0; i < nTrades; i++) {
    const block = 2 + Math.floor(i / perBlock);
    const coin = COINS[i % COINS.length];
    const sell = i % 7 === 6 && i > 50; // occasional sells, small, after buys accumulated
    const amountIn = sell ? 1000n + BigInt(i) : (10n ** 14n) * BigInt(1 + (i % 50));
    const fee = amountIn / 50n;
    const amountOut = sell ? 10n ** 10n : (10n ** 15n) * BigInt(1 + (i % 30));
    logs.push(mk(CFG.curve, 'Traded', block, '0xtrade' + i, i % perBlock, {
      coin, trader: '0xf' + String(i % 9) + '00'.repeat(19), isBuy: !sell, amountIn, amountOut, fee,
    }));
  }
  const lastBlock = 2 + Math.ceil(nTrades / perBlock);
  // Replayed duplicates (same tx/logIndex) arriving again in a later block.
  for (let i = 0; i < nDupes; i++) {
    const src = logs[COINS.length + (i % nTrades)];
    logs.push({ ...src, blockNumber: BigInt(lastBlock), blockHash: 'hash' + lastBlock });
  }
  logs.push(mk(CFG.curve, 'Graduated', lastBlock + 1, '0xgrad', 99, {
    coin: COINS[0], pool: POOL, tokenId: 1n, tokensIn: 1n, quoteIn: 1n,
  }));
  // Post-graduation: swaps in the coin's own locked pool + the vault reward lifecycle.
  // COINS[0] (0xc1..) sorts below QUOTE (0xee..), so the coin is token0: quote flow = amount1.
  logs.push(mk(POOL, 'Swap', lastBlock + 2, '0xswap1', 0, {
    sender: '0xf1' + '00'.repeat(19), recipient: '0xf1' + '00'.repeat(19),
    amount0: -(5n * 10n ** 20n), amount1: 10n ** 18n, sqrtPriceX96: 2n ** 96n / 1000n, liquidity: 10n ** 18n, tick: 100,
  }));
  logs.push(mk(POOL, 'Swap', lastBlock + 2, '0xswap2', 1, {
    sender: '0xf2' + '00'.repeat(19), recipient: '0xf2' + '00'.repeat(19),
    amount0: 6n * 10n ** 20n, amount1: -(9n * 10n ** 17n), sqrtPriceX96: 2n ** 96n / 1100n, liquidity: 10n ** 18n, tick: 90,
  }));
  logs.push(mk(VAULT0, 'LaunchFeesConverted', lastBlock + 3, '0xconv', 0, { tokenIn: 7n * 10n ** 18n, quoteOut: 10n ** 16n }));
  logs.push(mk(VAULT0, 'Distributed', lastBlock + 3, '0xdist', 1, { quoteSpent: 10n ** 16n }));
  logs.push(mk(VAULT0, 'Claimed', lastBlock + 4, '0xclaim', 0, { holder: '0xf1' + '00'.repeat(19), stock: QUOTE, amount: 3n * 10n ** 15n }));

  // ---- V4 product (appended after the duplicate generation so the V3 replay indices stay put) ----
  logs.push(mk(CFG.curveV4, 'Registered', 1, '0xregv4', 10, {
    coin: COIN_V4, quote: QUOTE, creator: '0x' + 'aa'.repeat(20), vault: VAULT_V4, reflectionBps: 200,
    virtualQuote: 10n ** 18n, graduationQuote: 4n * 10n ** 18n, virtualTokenOffset: 10n ** 24n,
  }));
  for (let i = 0; i < N_V4; i++) {
    const gross = (10n ** 15n) * BigInt(1 + i);
    const f = feeSplit(gross, 200, false);
    logs.push(mk(CFG.curveV4, 'FeeAllocated', 2 + i, '0xv4trade' + i, 50, { coin: COIN_V4, isBuy: true, protocolFee: f.protocol, creatorFee: f.creator, holderFee: f.holders, penalty: 0n }));
    logs.push(mk(CFG.curveV4, 'Traded', 2 + i, '0xv4trade' + i, 51, { coin: COIN_V4, trader: '0xf3' + '00'.repeat(19), isBuy: true, amountIn: gross, amountOut: (10n ** 15n) * BigInt(1 + i), fee: f.total }));
  }
  logs.push(mk(CFG.curveV4, 'Graduated', lastBlock + 1, '0xgradv4', 100, { coin: COIN_V4, poolId: POOL_ID_V4, tokensIn: 1n, quoteIn: 1n, liquidity: 1n }));
  // Buy: FeeAccrued (beforeSwap) precedes the Swap; the swapper's deltas are net of the hook fee (negative = paid).
  const b = feeSplit(10n ** 18n, 200, true);
  logs.push(mk(CFG.hook, 'FeeAccrued', lastBlock + 2, '0xv4swap1', 10, { poolId: POOL_ID_V4, buy: true, quoteVolume: 10n ** 18n, protocolFee: b.protocol, creatorFee: b.creator, holderFee: b.holders }));
  logs.push(mk(CFG.poolManager, 'Swap', lastBlock + 2, '0xv4swap1', 11, {
    id: POOL_ID_V4, sender: '0x' + '99'.repeat(20), amount0: 5n * 10n ** 20n, amount1: -(10n ** 18n - b.total), sqrtPriceX96: 2n ** 96n / 1000n, liquidity: 10n ** 18n, tick: 0, fee: 0,
  }));
  // Sell: the Swap precedes FeeAccrued (afterSwap); the pool pays the gross quote and the hook keeps its fee.
  const s = feeSplit(9n * 10n ** 17n, 200, true);
  logs.push(mk(CFG.poolManager, 'Swap', lastBlock + 2, '0xv4swap2', 12, {
    id: POOL_ID_V4, sender: '0x' + '99'.repeat(20), amount0: -(6n * 10n ** 20n), amount1: 9n * 10n ** 17n, sqrtPriceX96: 2n ** 96n / 1200n, liquidity: 10n ** 18n, tick: 0, fee: 0,
  }));
  logs.push(mk(CFG.hook, 'FeeAccrued', lastBlock + 2, '0xv4swap2', 13, { poolId: POOL_ID_V4, buy: false, quoteVolume: 9n * 10n ** 17n, protocolFee: s.protocol, creatorFee: s.creator, holderFee: s.holders }));
  // A swap of an unrelated pool on the same PoolManager is never indexed.
  logs.push(mk(CFG.poolManager, 'Swap', lastBlock + 2, '0xv4other', 14, { id: '0x' + '0f'.repeat(32), sender: '0x' + '99'.repeat(20), amount0: -1n, amount1: 1n, sqrtPriceX96: 2n ** 96n, liquidity: 1n, tick: 0, fee: 0 }));
  logs.push(mk(VAULT_V4, 'Distributed', lastBlock + 3, '0xv4dist', 10, { quoteSpent: 10n ** 16n }));
  logs.push(mk(CFG.hook, 'FeesClaimed', lastBlock + 3, '0xv4collect', 11, { asset: QUOTE, recipient: VAULT_V4, amount: 2n * 10n ** 16n }));
  logs.push(mk(CFG.hook, 'FeesClaimed', lastBlock + 3, '0xv4collect', 12, { asset: QUOTE, recipient: '0x' + '77'.repeat(20), amount: 5n * 10n ** 15n })); // treasury payout: ignored
  logs.push(mk(VAULT_V4, 'Claimed', lastBlock + 4, '0xv4claim', 10, { holder: '0xf1' + '00'.repeat(19), asset: COIN_V4, amount: 3n * 10n ** 15n }));
  return { logs, endBlock: BigInt(lastBlock + 4) };
}

function makeRpc(stream, hooks = {}) {
  return {
    getBlock: async ({ blockNumber }) => {
      if (hooks.blockFail && hooks.blockFail(blockNumber)) throw new Error('injected RPC block outage');
      return { number: blockNumber, hash: 'hash' + blockNumber, timestamp: 1700000000n + blockNumber };
    },
    getLogs: async ({ address, fromBlock, toBlock }) => {
      if (hooks.logsFail && hooks.logsFail(fromBlock, toBlock)) throw new Error('injected RPC logs outage');
      const set = (Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase());
      return stream.logs.filter((l) => set.includes(l.address.toLowerCase()) && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    readContract: async ({ address, functionName }) => {
      if (address.toLowerCase() === COIN_V4) return { name: 'Coin V4', symbol: 'CV4', decimals: 18, totalSupply: 10n ** 27n }[functionName];
      const i = COINS.indexOf(address.toLowerCase());
      if (i < 0) throw new Error('unknown token');
      return { name: `Coin ${i}`, symbol: `C${i}`, decimals: 18, totalSupply: 10n ** 27n }[functionName];
    },
    getChainId: async () => CFG.chainId,
  };
}

function loadIngest(prisma, rpc, published = []) {
  const context = {
    exports: {}, console: { log() {}, error() {} },
    cfg: { ...CFG }, defineChain: (x) => x, http: () => ({}), createPublicClient: () => rpc,
    parseAbiItem: (x) => x, getAddress: (x) => x, erc20Abi: [], prisma,
    publish: (u) => published.push(u), ingestion: {},
  };
  vm.runInNewContext(code('ingest.ts', '\nexport { scan, getCursor };'), context);
  return context.exports;
}

// ---------- digest ----------
async function digest(prisma) {
  const strip = ({ id, updatedAt, ...rest }) => rest;
  const coins = (await prisma.coin.findMany({ orderBy: { address: 'asc' } })).map(({ updatedAt, ...r }) => r);
  const trades = (await prisma.trade.findMany({ orderBy: [{ txHash: 'asc' }, { logIndex: 'asc' }] })).map(strip);
  const points = (await prisma.pricePoint.findMany({ orderBy: [{ coinAddress: 'asc' }, { block: 'asc' }, { priceQuote: 'asc' }, { ts: 'asc' }] })).map(strip);
  const receipts = await prisma.indexedEvent.findMany({ orderBy: [{ txHash: 'asc' }, { logIndex: 'asc' }] });
  const rewards = (await prisma.rewardEvent.findMany({ orderBy: [{ txHash: 'asc' }, { logIndex: 'asc' }] })).map(strip);
  const cursor = await prisma.cursor.findUnique({ where: { id: 'curve' } });
  const body = jsonBig({ coins, trades, points, receipts, rewards, cursor });
  return { hash: crypto.createHash('sha256').update(body).digest('hex'), counts: { coins: coins.length, trades: trades.length, points: points.length, receipts: receipts.length, rewards: rewards.length, cursor: cursor?.lastBlock } };
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'census-pg-'));
  const PORT = 55490 + Math.floor(Math.random() * 400);
  const CRASH_PORT = PORT + 1;
  const mainData = path.join(base, 'main');
  const crashData = path.join(base, 'crash');
  const stream = makeStream(2000, 200);
  let server = null, crashServer = null;
  const clients = [];
  const track = (c) => { clients.push(c); return c; };

  try {
    server = await startServer(mainData, PORT);
    for (const name of ['ref', 'recovery', 'conc', 'restore', 'load']) await server.createDatabase(name);

    // ---- 1. committed migrations deploy onto every clean database ----
    for (const name of ['ref', 'recovery', 'conc', 'restore', 'load']) migrateDeploy(dbUrl(PORT, name));
    console.log('PASS migrate: committed migrations deploy cleanly onto 5 fresh real databases');

    // ---- 2. reference run: full stream through real serializable transactions ----
    const ref = track(prismaClient(dbUrl(PORT, 'ref')));
    const refPublished = [];
    const refIngest = loadIngest(ref, makeRpc(stream), refPublished);
    let t0 = Date.now();
    await refIngest.scan(1n, stream.endBlock);
    const refDigest = await digest(ref);
    assert.equal(refDigest.counts.trades, 2002 + N_V4 + 2); // 2000 V3 curve trades + 2 V3 pool swaps + N_V4 V4 curve trades + 2 V4 pool swaps
    assert.equal(refDigest.counts.receipts, 2009 + 1 + N_V4 + 1 + 2 + 3); // V3: 3 reg + 2000 + 1 grad + 2 swaps + 3 rewards; V4: reg + trades + grad + 2 swaps + 3 rewards (fee logs carry no receipt)
    assert.equal(refDigest.counts.rewards, 6); // V3 converted/distributed/claimed + V4 distributed/collected/claimed
    assert.equal(refDigest.counts.coins, 4);
    assert.equal(refDigest.counts.cursor, stream.endBlock);
    // V4 coin: reflection registration, exact reserves from Traded, fee split from FeeAllocated, poolId graduation,
    // hooked-pool swaps with gross volume / net sell output / oriented price, and the reward ledger.
    const v4 = await ref.coin.findUnique({ where: { address: COIN_V4 } });
    assert.equal(v4.product, 'v4'); assert.equal(v4.reflectionBps, 200); assert.equal(v4.vault, VAULT_V4); assert.equal(v4.holdersBps, 0);
    assert.ok(v4.graduated && v4.poolId === POOL_ID_V4 && v4.pool === null && v4.progressBps === 10000);
    let netV4 = 0n, tokensV4 = 0n;
    for (let i = 0; i < N_V4; i++) { const gross = (10n ** 15n) * BigInt(1 + i); netV4 += gross - feeSplit(gross, 200, false).total; tokensV4 += (10n ** 15n) * BigInt(1 + i); }
    assert.equal(v4.virtualQuote, (10n ** 18n + netV4).toString()); assert.equal(v4.realQuote, netV4.toString()); assert.equal(v4.tokenReserve, (10n ** 27n - tokensV4).toString());
    assert.equal(v4.tradeCount, N_V4 + 2);
    assert.ok(Math.abs(v4.priceQuote - 1 / 1200 ** 2) / (1 / 1200 ** 2) < 1e-9, 'V4 price follows the PoolManager sqrtPrice');
    const v4Trades = await ref.trade.findMany({ where: { coinAddress: COIN_V4 }, orderBy: [{ block: 'asc' }, { logIndex: 'asc' }] });
    const f7 = feeSplit(8n * 10n ** 15n, 200, false), t7 = v4Trades[7];
    assert.equal(t7.venue, 'curve'); assert.equal(t7.fee, f7.total.toString()); assert.equal(t7.feeProtocol, f7.protocol.toString()); assert.equal(t7.feeCreator, f7.creator.toString()); assert.equal(t7.feeHolders, f7.holders.toString()); assert.equal(t7.feePenalty, '0');
    const [buy, sell] = v4Trades.slice(-2), fb = feeSplit(10n ** 18n, 200, true), fs2 = feeSplit(9n * 10n ** 17n, 200, true);
    assert.equal(buy.venue, 'pool'); assert.equal(buy.isBuy, true); assert.equal(buy.amountIn, (10n ** 18n).toString()); assert.equal(buy.amountOut, (5n * 10n ** 20n).toString());
    assert.equal(buy.fee, fb.total.toString()); assert.equal(buy.feeProtocol, fb.protocol.toString()); assert.equal(buy.feeCreator, fb.creator.toString()); assert.equal(buy.feeHolders, fb.holders.toString());
    assert.ok(Math.abs(buy.priceQuote - 1e-6) / 1e-6 < 1e-9);
    assert.equal(sell.isBuy, false); assert.equal(sell.amountIn, (6n * 10n ** 20n).toString()); assert.equal(sell.amountOut, (9n * 10n ** 17n - fs2.total).toString()); assert.equal(sell.fee, fs2.total.toString());
    assert.equal(await ref.trade.count({ where: { txHash: '0xv4other' } }), 0, 'foreign poolId ignored');
    const v4Rewards = await ref.rewardEvent.findMany({ where: { coinAddress: COIN_V4 } });
    assert.deepEqual(v4Rewards.map((r) => r.kind).sort(), ['claimed', 'collected', 'distributed']);
    assert.equal(v4Rewards.find((r) => r.kind === 'collected').amount, (2n * 10n ** 16n).toString());
    assert.equal(v4Rewards.find((r) => r.kind === 'claimed').asset, COIN_V4);
    assert.equal(refDigest.counts.cursor, stream.endBlock);
    assert.equal((await ref.cursor.findUnique({ where: { id: 'curve' } })).curve, `${CFG.curve}|v4:${CFG.curveV4}`);
    for (const c of COINS) { const row = await ref.coin.findUnique({ where: { address: c } }); assert.equal(row.product, 'v3'); assert.equal(row.poolId, null); }
    assert.equal((await ref.trade.findFirst({ where: { coinAddress: COINS[1] } })).feeProtocol, '0');
    const pfCoin = await ref.coin.findUnique({ where: { address: COINS[1] } });
    assert.equal(pfCoin.virtualTokenOffset, (10n ** 24n).toString());
    const expectedPfPrice = Number(pfCoin.virtualQuote) / Number(BigInt(pfCoin.tokenReserve) + BigInt(pfCoin.virtualTokenOffset));
    assert.ok(Math.abs(pfCoin.priceQuote / expectedPfPrice - 1) < 1e-14); // PostgreSQL float round-trip
    assert.equal((await ref.coin.findUnique({ where: { address: COINS[2] } })).virtualTokenOffset, '0');
    assert.ok(refPublished.length >= 2004, 'updates published after commit');
    // Post-graduation swaps landed as venue=pool trades and moved the coin's spot price.
    const poolTrades = await ref.trade.findMany({ where: { venue: 'pool', coinAddress: COINS[0] } });
    assert.equal(poolTrades.length, 2);
    assert.equal(poolTrades.filter((t) => t.isBuy).length, 1);
    const gradCoin = await ref.coin.findUnique({ where: { address: COINS[0] } });
    assert.ok(gradCoin.graduated && gradCoin.pool === POOL);
    assert.ok(Math.abs(gradCoin.priceQuote - 1 / 1100 ** 2) / (1 / 1100 ** 2) < 1e-9, 'price follows the pool sqrtPrice');
    // Replaying the whole range changes nothing (restart determinism).
    await refIngest.scan(1n, stream.endBlock);
    assert.equal((await digest(ref)).hash, refDigest.hash);
    console.log(`PASS reference: 2000 V3 trades + 200 duplicate replays + graduation + pool swaps + reward events, plus a V4 coin (reflection, FeeAllocated split, poolId graduation, PoolManager/hook swaps, vault/hook rewards) applied exactly once on real Postgres (${Date.now() - t0}ms); full-range replay is a no-op`);

    // ---- 3. RPC fault mid-run rolls back atomically; resume converges to the same digest ----
    const rec = track(prismaClient(dbUrl(PORT, 'recovery')));
    let failing = true;
    const recIngest = loadIngest(rec, makeRpc(stream, { logsFail: (from) => failing && from > 100n }));
    await assert.rejects(recIngest.scan(1n, stream.endBlock), /outage/);
    const partial = await rec.cursor.findUnique({ where: { id: 'curve' } });
    assert.ok(partial && partial.lastBlock >= 100n && partial.lastBlock < stream.endBlock, 'durable cursor stops at last committed page');
    const committedReceipts = await rec.indexedEvent.count();
    const committedTrades = await rec.trade.count();
    assert.equal(committedReceipts, committedTrades + REGISTRATIONS, 'no partially-applied page: receipts match applied events');
    failing = false;
    await recIngest.scan(partial.lastBlock + 1n, stream.endBlock);
    assert.equal((await digest(rec)).hash, refDigest.hash);
    console.log('PASS recovery: RPC outage mid-run left only whole committed pages; resume from the durable cursor reaches the reference digest');

    // ---- 4. two concurrent workers, exactly-once ----
    const concA = track(prismaClient(dbUrl(PORT, 'conc')));
    const concB = track(prismaClient(dbUrl(PORT, 'conc')));
    const worker = async (prisma) => {
      const ing = loadIngest(prisma, makeRpc(stream));
      for (let attempt = 0; attempt < 200; attempt++) {
        const cursor = await ing.getCursor();
        if (cursor >= stream.endBlock) return attempt;
        try { await ing.scan(cursor + 1n, stream.endBlock); } catch { /* lock/serialization contention: retry from durable cursor like the live loop */ }
      }
      throw new Error('worker did not converge');
    };
    t0 = Date.now();
    await Promise.all([worker(concA), worker(concB)]);
    const concDigest = await digest(concA);
    assert.equal(concDigest.hash, refDigest.hash);
    console.log(`PASS concurrency: two workers over the same range on one real database applied every event exactly once (${Date.now() - t0}ms)`);

    // ---- 5. hard-kill postgres mid-ingest; WAL recovery; resume ----
    crashServer = await startServer(crashData, CRASH_PORT);
    await crashServer.createDatabase('crash');
    migrateDeploy(dbUrl(CRASH_PORT, 'crash'));
    let crashClient = prismaClient(dbUrl(CRASH_PORT, 'crash'));
    const crashIngest = loadIngest(crashClient, makeRpc(stream));
    const running = crashIngest.scan(1n, stream.endBlock).then(() => 'finished', (e) => e);
    // Wait until several pages committed, then kill the server process tree outright.
    const monitor = prismaClient(dbUrl(CRASH_PORT, 'crash'));
    let seen = null;
    for (let i = 0; i < 600 && !seen; i++) {
      await new Promise((r) => setTimeout(r, 25));
      try { const c = await monitor.cursor.findUnique({ where: { id: 'curve' } }); if (c && c.lastBlock >= 20n) seen = c.lastBlock; } catch { /* not yet */ }
    }
    await monitor.$disconnect().catch(() => {});
    assert.ok(seen !== null, 'ingest committed pages before the crash');
    killServerHard(crashData);
    const outcome = await running;
    assert.notEqual(outcome, 'finished', 'the worker must fail when the database dies');
    await crashClient.$disconnect().catch(() => {});
    // Restart the SAME data directory: postgres replays WAL; only whole pages exist.
    crashServer = await startServer(crashData, CRASH_PORT, { fresh: false });
    crashClient = track(prismaClient(dbUrl(CRASH_PORT, 'crash')));
    const afterCrash = await crashClient.cursor.findUnique({ where: { id: 'curve' } });
    assert.ok(afterCrash && afterCrash.lastBlock >= 20n, 'durable cursor survived the crash');
    assert.equal(await crashClient.indexedEvent.count(), (await crashClient.trade.count()) + REGISTRATIONS, 'crash left no partially-applied page');
    const resumed = loadIngest(crashClient, makeRpc(stream));
    await resumed.scan(afterCrash.lastBlock + 1n, stream.endBlock);
    assert.equal((await digest(crashClient)).hash, refDigest.hash);
    console.log(`PASS crash: postgres hard-killed mid-ingest at block ${afterCrash.lastBlock}; WAL recovery + resume reached the reference digest`);

    // ---- 6. logical export/restore into a freshly-migrated database ----
    const restore = track(prismaClient(dbUrl(PORT, 'restore')));
    await restore.coin.createMany({ data: await ref.coin.findMany() });
    await restore.trade.createMany({ data: await ref.trade.findMany() });
    await restore.pricePoint.createMany({ data: await ref.pricePoint.findMany() });
    await restore.rewardEvent.createMany({ data: await ref.rewardEvent.findMany() });
    await restore.indexedEvent.createMany({ data: await ref.indexedEvent.findMany() });
    const cur = await ref.cursor.findUnique({ where: { id: 'curve' } });
    await restore.cursor.create({ data: cur });
    assert.equal((await digest(restore)).hash, refDigest.hash);
    // And the restored database keeps ingesting (replay no-op + it is a valid live target).
    const restoredIngest = loadIngest(restore, makeRpc(stream));
    await restoredIngest.scan(1n, stream.endBlock);
    assert.equal((await digest(restore)).hash, refDigest.hash);
    console.log('PASS restore: logical export into a freshly-migrated database matches the reference digest and remains a valid live target (pg_dump rehearsal on production tooling remains a release gate)');

    // ---- 7. sustained load on real Postgres ----
    const load = track(prismaClient(dbUrl(PORT, 'load')));
    const bigStream = makeStream(10000, 1000);
    const loadIngestCtx = loadIngest(load, makeRpc(bigStream));
    t0 = Date.now();
    await loadIngestCtx.scan(1n, bigStream.endBlock);
    const loadDigest = await digest(load);
    const loadMs = Date.now() - t0;
    assert.equal(loadDigest.counts.trades, 10002 + N_V4 + 2);
    assert.equal(loadDigest.counts.receipts, 10009 + 1 + N_V4 + 1 + 2 + 3);
    console.log(`PASS load: 10000 unique + 1000 duplicate events through real serializable transactions in ${loadMs}ms (${Math.round(11000 / (loadMs / 1000))} events/s incl. duplicates; local single-node, not a production capacity claim)`);

    // ---- 8. the actual API served from real Postgres data ----
    const app = require('fastify')({ logger: false });
    app.listen = async () => {};
    const ingestion = { lastSuccessAt: Date.now(), lastBlock: stream.endBlock.toString(), error: null };
    const apiContext = {
      exports: {}, console: { log() {} }, Fastify: () => app,
      cors: require('@fastify/cors'), websocket: require('@fastify/websocket'), rateLimit: require('@fastify/rate-limit'), registerSocialRoutes: () => {},
      cfg: { chainId: CFG.chainId, curve: CFG.curve, curveV4: CFG.curveV4, corsOrigin: '*', port: 0, pollMs: 4000 },
      bus: new EventEmitter(), serializeCoin: (x) => JSON.parse(jsonBig(x)), ingestion, prisma: ref,
    };
    vm.runInNewContext(code('api.ts'), apiContext);
    await apiContext.exports.runApi();
    try {
      const health = await app.inject('/health');
      assert.equal(health.statusCode, 200);
      assert.deepEqual(health.json().products, ['v3', 'v4']);
      const coins = (await app.inject('/coins?limit=10')).json();
      assert.equal(coins.coins.length, 4);
      assert.deepEqual(coins.coins.map((c) => c.product).sort(), ['v3', 'v3', 'v3', 'v4']);
      // V4 fields served from real rows: product/reflectionBps/poolId on the coin, the fee split on trades, "collected" rewards.
      const v4Detail = (await app.inject(`/coins/${COIN_V4}`)).json().coin;
      assert.equal(v4Detail.product, 'v4'); assert.equal(v4Detail.reflectionBps, 200); assert.equal(v4Detail.poolId, POOL_ID_V4); assert.equal(v4Detail.pool, null); assert.equal(v4Detail.graduated, true);
      const v4ApiTrades = (await app.inject(`/coins/${COIN_V4}/trades?limit=5`)).json().trades;
      const poolBuy = v4ApiTrades.find((t) => t.txHash === '0xv4swap1');
      assert.equal(poolBuy.venue, 'pool'); assert.equal(poolBuy.fee, feeSplit(10n ** 18n, 200, true).total.toString()); assert.equal(poolBuy.feeHolders, (2n * 10n ** 16n).toString()); assert.equal(poolBuy.feePenalty, '0');
      assert.deepEqual((await app.inject(`/coins/${COIN_V4}/rewards`)).json().rewards.map((r) => r.kind).sort(), ['claimed', 'collected', 'distributed']);
      const v3Detail = (await app.inject(`/coins/${COINS[1]}`)).json().coin;
      assert.equal(v3Detail.product, 'v3'); assert.equal(v3Detail.reflectionBps, 0); assert.equal(v3Detail.poolId, null);
      const detail = (await app.inject(`/coins/${COINS[0]}`)).json();
      assert.equal(detail.coin.tradeCount, await ref.trade.count({ where: { coinAddress: COINS[0] } }));
      const trades = (await app.inject(`/coins/${COINS[0]}/trades?limit=5`)).json();
      assert.ok(trades.trades.some((t) => t.venue === 'pool'), 'post-graduation pool swaps served');
      const rewards = (await app.inject(`/coins/${COINS[0]}/rewards`)).json();
      assert.equal(rewards.rewards.length, 3);
      assert.deepEqual(rewards.rewards.map((r) => r.kind).sort(), ['claimed', 'converted', 'distributed']);
      const holderRewards = (await app.inject(`/coins/${COINS[0]}/rewards?holder=0xf1${'00'.repeat(19)}`)).json();
      assert.equal(holderRewards.rewards.length, 1);
      assert.equal((await app.inject(`/coins/${COINS[0]}/rewards?holder=zzz`)).statusCode, 400);
      const chart = (await app.inject(`/coins/${COINS[0]}/chart?limit=50`)).json();
      assert.ok(chart.points.length > 0 && chart.points.length <= 50);
      for (let i = 1; i < chart.points.length; i++) assert.ok(chart.points[i].t >= chart.points[i - 1].t, 'chart ascending, recent window');
      assert.equal((await app.inject('/coins?limit=abc')).statusCode, 400);
      t0 = Date.now();
      const failures = [];
      for (let i = 0; i < 20; i++) {
        await Promise.all(Array.from({ length: 50 }, async (_, j) => {
          const r = await app.inject({ url: `/coins?limit=50`, remoteAddress: `10.0.${i}.${j + 1}` });
          if (r.statusCode !== 200) failures.push(`${r.statusCode}: ${String(r.body).slice(0, 160)}`);
        }));
      }
      assert.equal(failures.length, 0, `${failures.length} of 1000 API requests failed under load: ${[...new Set(failures)].join(' | ')}`);
      console.log(`PASS api: actual Fastify handlers on real Postgres — health (products), board, V3 + V4 coin detail (product/reflectionBps/poolId), trades with fee split, rewards, recent chart, validation; 1000 requests at concurrency 50 in ${Date.now() - t0}ms (in-process transport)`);
    } finally { await app.close(); }

    console.log('ALL REAL-POSTGRES CHECKS PASSED');
  } finally {
    for (const c of clients) await c.$disconnect().catch(() => {});
    if (server) await server.stop().catch(() => {});
    if (crashServer) await crashServer.stop().catch(() => {});
    // Only remove the temporary directory created by this harness, including on Windows.
    try {
      const resolved = fs.realpathSync(base);
      assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('census-pg-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    } catch { /* Windows file locks; retain the temp dir if cleanup cannot be verified */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); }); // exit explicitly: a failed check must never report success
