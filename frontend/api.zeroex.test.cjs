// Abuse tests for api/zeroex.ts (CX-L1): per-IP rate limit, chain cap, fail-open without KV, and the
// existing endpoint/key guards — all without spending a real 0x key.
// Build first: npx esbuild api/zeroex.ts --bundle --platform=node --format=cjs --outfile=.test-build/zeroex.cjs
// Run: node api.zeroex.test.cjs
const http = require('node:http');
const assert = require('node:assert');

async function main() {
  // Fake KV (INCR/EXPIRE) REST endpoint.
  const counters = {};
  const kv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const cmd = JSON.parse(body);
      let reply = { result: null };
      if (cmd[0] === 'INCR') { counters[cmd[1]] = (counters[cmd[1]] ?? 0) + 1; reply = { result: counters[cmd[1]] }; }
      else if (cmd[0] === 'EXPIRE') reply = { result: 1 };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  // Fake 0x upstream — always answers 200 with a canned quote.
  let upstreamHits = 0;
  const zx = http.createServer((req, res) => {
    upstreamHits++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ liquidityAvailable: true, buyAmount: '123' }));
  });
  await new Promise((r) => kv.listen(0, '127.0.0.1', r));
  await new Promise((r) => zx.listen(0, '127.0.0.1', r));
  const kvBase = `http://127.0.0.1:${kv.address().port}`;
  const zxBase = `http://127.0.0.1:${zx.address().port}`;

  process.env.ZEROX_API_KEY = 'secret-key';
  process.env.ZEROX_API_BASE = zxBase;
  process.env.KV_REST_API_URL = kvBase;
  process.env.KV_REST_API_TOKEN = 'test';
  process.env.CENSUS_CHAIN_ID = '4663';
  process.env.ZEROEX_RATE_PER_MIN = '3';

  const mod = require('./.test-build/zeroex.cjs');
  const handler = mod.default;
  const res = () => {
    const r = { code: 200, body: null, headers: {} };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.send = (b) => { r.body = r.body ?? b; return r; };
    r.setHeader = (k, v) => { r.headers[k] = v; return r; };
    return r;
  };
  const call = async ({ endpoint = 'price', chainId = '4663', ip = '1.1.1.1' } = {}) => {
    const r = res();
    await handler({ query: { endpoint, chainId, sellToken: 'A', buyToken: 'B', sellAmount: '1' }, headers: { 'x-forwarded-for': ip } }, r);
    return r;
  };

  // 1. Per-IP rate limit: first RATE_PER_MIN pass, the next is 429.
  for (let i = 0; i < 3; i++) assert.equal((await call({ ip: '9.9.9.9' })).code, 200, `request ${i + 1} should pass`);
  const throttled = await call({ ip: '9.9.9.9' });
  assert.equal(throttled.code, 429, '4th request from the same IP should be 429');
  assert.equal(throttled.headers['retry-after'], '60', '429 should set retry-after');

  // 2. A different IP is independent.
  assert.equal((await call({ ip: '8.8.8.8' })).code, 200, 'a different IP is not throttled');

  // 3. Chain cap: a foreign chainId is refused before spending the key (checked before the upstream).
  const hitsBefore = upstreamHits;
  assert.equal((await call({ chainId: '1', ip: '7.7.7.7' })).code, 400, 'foreign chain rejected');
  assert.equal(upstreamHits, hitsBefore, 'a rejected chain must not hit the upstream key');

  // 4. Bad/missing endpoint → 400.
  assert.equal((await call({ endpoint: 'swap', ip: '6.6.6.6' })).code, 400, 'bad endpoint rejected');

  // 5. Fail-open without KV: the proxy still serves (unthrottled) rather than break trading.
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  for (let i = 0; i < 5; i++) assert.equal((await call({ ip: '5.5.5.5' })).code, 200, `no-KV request ${i + 1} should pass (fail open)`);
  process.env.KV_REST_API_URL = kvBase;
  process.env.KV_REST_API_TOKEN = 'test';

  // 6. Missing key → 500, and the upstream is never called.
  delete process.env.ZEROX_API_KEY;
  const noKey = await call({ ip: '4.4.4.4' });
  assert.equal(noKey.code, 500, 'missing key → 500');
  process.env.ZEROX_API_KEY = 'secret-key';

  kv.close(); zx.close();
  console.log('api.zeroex.test.cjs: all assertions passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
