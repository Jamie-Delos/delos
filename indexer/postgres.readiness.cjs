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
  const r = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { encoding: 'utf8' });
  assert.equal(r.status, 0, `taskkill failed: ${r.stderr}`);
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
const CFG = { chainId: 4663, curve: '0x' + 'cc'.repeat(20), weth: QUOTE, ethUsd: 3000, logPage: 20n, startBlock: 1n, pollMs: 50 };

function makeStream(nTrades, nDupes) {
  const logs = [];
  const mk = (eventName, block, tx, logIndex, args) => ({
    eventName, args, blockNumber: BigInt(block), blockHash: 'hash' + block, transactionHash: tx, logIndex,
  });
  for (let i = 0; i < COINS.length; i++) {
    logs.push(mk('Registered', 1, '0xreg' + i, i, {
      coin: COINS[i], quote: QUOTE, creator: '0x' + 'aa'.repeat(20),
      vault: i === 0 ? '0x' + 'bb'.repeat(20) : '0x0000000000000000000000000000000000000000',
      holdersBps: i === 0 ? 10000 : 0, virtualQuote: 10n ** 18n, graduationQuote: 4n * 10n ** 18n,
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
    logs.push(mk('Traded', block, '0xtrade' + i, i % perBlock, {
      coin, trader: '0xf' + String(i % 9) + '00'.repeat(19), isBuy: !sell, amountIn, amountOut, fee,
    }));
  }
  const lastBlock = 2 + Math.ceil(nTrades / perBlock);
  // Replayed duplicates (same tx/logIndex) arriving again in a later block.
  for (let i = 0; i < nDupes; i++) {
    const src = logs[COINS.length + (i % nTrades)];
    logs.push({ ...src, blockNumber: BigInt(lastBlock), blockHash: 'hash' + lastBlock });
  }
  logs.push(mk('Graduated', lastBlock + 1, '0xgrad', 99, {
    coin: COINS[0], pool: '0x' + 'dd'.repeat(20), tokenId: 1n, tokensIn: 1n, quoteIn: 1n,
  }));
  return { logs, endBlock: BigInt(lastBlock + 1) };
}

function makeRpc(stream, hooks = {}) {
  return {
    getBlock: async ({ blockNumber }) => {
      if (hooks.blockFail && hooks.blockFail(blockNumber)) throw new Error('injected RPC block outage');
      return { number: blockNumber, hash: 'hash' + blockNumber, timestamp: 1700000000n + blockNumber };
    },
    getLogs: async ({ fromBlock, toBlock }) => {
      if (hooks.logsFail && hooks.logsFail(fromBlock, toBlock)) throw new Error('injected RPC logs outage');
      return stream.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    readContract: async ({ address, functionName }) => {
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
  const cursor = await prisma.cursor.findUnique({ where: { id: 'curve' } });
  const body = jsonBig({ coins, trades, points, receipts, cursor });
  return { hash: crypto.createHash('sha256').update(body).digest('hex'), counts: { coins: coins.length, trades: trades.length, points: points.length, receipts: receipts.length, cursor: cursor?.lastBlock } };
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
    assert.equal(refDigest.counts.trades, 2000);
    assert.equal(refDigest.counts.receipts, 2004); // 3 registrations + 2000 trades + 1 graduation
    assert.equal(refDigest.counts.coins, 3);
    assert.equal(refDigest.counts.cursor, stream.endBlock);
    assert.ok(refPublished.length >= 2004, 'updates published after commit');
    // Replaying the whole range changes nothing (restart determinism).
    await refIngest.scan(1n, stream.endBlock);
    assert.equal((await digest(ref)).hash, refDigest.hash);
    console.log(`PASS reference: 2000 trades + 200 duplicate replays + graduation applied exactly once on real Postgres (${Date.now() - t0}ms); full-range replay is a no-op`);

    // ---- 3. RPC fault mid-run rolls back atomically; resume converges to the same digest ----
    const rec = track(prismaClient(dbUrl(PORT, 'recovery')));
    let failing = true;
    const recIngest = loadIngest(rec, makeRpc(stream, { logsFail: (from) => failing && from > 100n }));
    await assert.rejects(recIngest.scan(1n, stream.endBlock), /outage/);
    const partial = await rec.cursor.findUnique({ where: { id: 'curve' } });
    assert.ok(partial && partial.lastBlock >= 100n && partial.lastBlock < stream.endBlock, 'durable cursor stops at last committed page');
    const committedReceipts = await rec.indexedEvent.count();
    const committedTrades = await rec.trade.count();
    assert.equal(committedReceipts, committedTrades + 3, 'no partially-applied page: receipts match applied events');
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
    assert.equal(await crashClient.indexedEvent.count(), (await crashClient.trade.count()) + 3, 'crash left no partially-applied page');
    const resumed = loadIngest(crashClient, makeRpc(stream));
    await resumed.scan(afterCrash.lastBlock + 1n, stream.endBlock);
    assert.equal((await digest(crashClient)).hash, refDigest.hash);
    console.log(`PASS crash: postgres hard-killed mid-ingest at block ${afterCrash.lastBlock}; WAL recovery + resume reached the reference digest`);

    // ---- 6. logical export/restore into a freshly-migrated database ----
    const restore = track(prismaClient(dbUrl(PORT, 'restore')));
    await restore.coin.createMany({ data: await ref.coin.findMany() });
    await restore.trade.createMany({ data: await ref.trade.findMany() });
    await restore.pricePoint.createMany({ data: await ref.pricePoint.findMany() });
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
    assert.equal(loadDigest.counts.trades, 10000);
    assert.equal(loadDigest.counts.receipts, 10004);
    console.log(`PASS load: 10000 unique + 1000 duplicate events through real serializable transactions in ${loadMs}ms (${Math.round(11000 / (loadMs / 1000))} events/s incl. duplicates; local single-node, not a production capacity claim)`);

    // ---- 8. the actual API served from real Postgres data ----
    const app = require('fastify')({ logger: false });
    app.listen = async () => {};
    const ingestion = { lastSuccessAt: Date.now(), lastBlock: stream.endBlock.toString(), error: null };
    const apiContext = {
      exports: {}, console: { log() {} }, Fastify: () => app,
      cors: require('@fastify/cors'), websocket: require('@fastify/websocket'), rateLimit: require('@fastify/rate-limit'),
      cfg: { chainId: CFG.chainId, curve: CFG.curve, corsOrigin: '*', port: 0, pollMs: 4000 },
      bus: new EventEmitter(), serializeCoin: (x) => JSON.parse(jsonBig(x)), ingestion, prisma: ref,
    };
    vm.runInNewContext(code('api.ts'), apiContext);
    await apiContext.exports.runApi();
    try {
      assert.equal((await app.inject('/health')).statusCode, 200);
      const coins = (await app.inject('/coins?limit=10')).json();
      assert.equal(coins.coins.length, 3);
      const detail = (await app.inject(`/coins/${COINS[0]}`)).json();
      assert.equal(detail.coin.tradeCount, await ref.trade.count({ where: { coinAddress: COINS[0] } }));
      const chart = (await app.inject(`/coins/${COINS[0]}/chart?limit=50`)).json();
      assert.ok(chart.points.length > 0 && chart.points.length <= 50);
      for (let i = 1; i < chart.points.length; i++) assert.ok(chart.points[i].t >= chart.points[i - 1].t, 'chart ascending, recent window');
      assert.equal((await app.inject('/coins?limit=abc')).statusCode, 400);
      t0 = Date.now();
      let failures = 0;
      for (let i = 0; i < 20; i++) {
        await Promise.all(Array.from({ length: 50 }, async (_, j) => {
          const r = await app.inject({ url: `/coins?limit=50`, remoteAddress: `10.0.${i}.${j + 1}` });
          if (r.statusCode !== 200) failures++;
        }));
      }
      assert.equal(failures, 0);
      console.log(`PASS api: actual Fastify handlers on real Postgres — health, board, coin detail, recent chart, validation; 1000 requests at concurrency 50 in ${Date.now() - t0}ms (in-process transport)`);
    } finally { await app.close(); }

    console.log('ALL REAL-POSTGRES CHECKS PASSED');
  } finally {
    for (const c of clients) await c.$disconnect().catch(() => {});
    if (server) await server.stop().catch(() => {});
    if (crashServer) await crashServer.stop().catch(() => {});
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* Windows file locks; temp dir */ }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
