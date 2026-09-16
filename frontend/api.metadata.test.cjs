// Authorization tests for api/metadata.ts (B18 + review M10–M12): creator-signed writes, on-chain
// creator verification with RPC chain cross-check, chain-scoped keys, timestamped signatures with
// expiry and rollback protection, verified KV writes, fail-closed configuration, no error leakage.
// Build first: npx esbuild api/metadata.ts --bundle --platform=node --format=cjs --outfile=.test-build/metadata.cjs --external:viem
// Run: node api.metadata.test.cjs
const http = require('node:http');
const assert = require('node:assert');

async function main() {
  const { privateKeyToAccount } = require('viem/accounts');
  const { encodeAbiParameters } = require('viem');

  const creator = privateKeyToAccount('0x' + '11'.repeat(32));
  const stranger = privateKeyToAccount('0x' + '22'.repeat(32));
  const TOKEN = '0x' + 'ab'.repeat(20);
  const UNKNOWN = '0x' + 'cd'.repeat(20);
  const CURVE = '0x' + 'ee'.repeat(20);

  const kvCommands = [];
  let kvStore = {};
  let rpcChainHex = '0x1237'; // 4663
  let kvSetReply = () => 'OK';
  // One local server plays both the JSON-RPC node and the Upstash KV REST endpoint.
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      if (req.url.startsWith('/rpc')) {
        const call = (r) => {
          if (r.method === 'eth_chainId') return { jsonrpc: '2.0', id: r.id, result: rpcChainHex };
          if (r.method !== 'eth_call') return { jsonrpc: '2.0', id: r.id, result: '0x' };
          const known = r.params[0].data.toLowerCase().includes(TOKEN.slice(2).toLowerCase());
          const result = encodeAbiParameters(
            [
              { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint16' },
              { type: 'uint24' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' },
              { type: 'uint256' }, { type: 'bool' }, { type: 'bool' },
            ],
            ['0x' + '00'.repeat(20), known ? creator.address : '0x' + '00'.repeat(20),
             '0x' + '00'.repeat(20), 0, 0, 0n, 0n, 0n, 0n, false, known],
          );
          return { jsonrpc: '2.0', id: r.id, result };
        };
        const out = Array.isArray(parsed) ? parsed.map(call) : call(parsed);
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(out));
      }
      // KV: single-command POST bodies like ["SET", key, value] / ["GET", key]
      kvCommands.push(parsed);
      let reply = { result: null };
      if (parsed[0] === 'SET') { const r = kvSetReply(); if (r === 'OK') kvStore[parsed[1]] = parsed[2]; reply = r === 'OK' ? { result: 'OK' } : { error: r }; }
      if (parsed[0] === 'GET') reply = { result: kvStore[parsed[1]] ?? null };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  process.env.CENSUS_CHAIN_ID = '4663';
  process.env.CENSUS_RPC_URL = `${base}/rpc`;
  process.env.CENSUS_CURVE_ADDRESS = CURVE;
  process.env.KV_REST_API_URL = base;
  process.env.KV_REST_API_TOKEN = 'test-token';

  const mod = require('./.test-build/metadata.cjs');
  const handler = mod.default;
  const { metadataMessage } = mod;
  const { keccak256, stringToBytes } = require('viem');
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  process.on('exit', () => { console.error = realError; });

  const res = () => {
    const r = { code: 0, body: null, headers: {} };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    return r;
  };
  const now = () => Math.floor(Date.now() / 1000);
  const meta = { name: 'Test', thesis: 't', description: 'd', image: '' };
  const hashOf = (m) => keccak256(stringToBytes(JSON.stringify({ name: m.name, thesis: m.thesis, description: m.description, image: m.image })));
  const sign = (account, { chain = 4663, token = TOKEN, m = meta, issuedAt = now() } = {}) =>
    account.signMessage({ message: metadataMessage(chain, token, hashOf(m), issuedAt) });
  const post = async (body) => { const r = res(); await handler({ method: 'POST', body }, r); return r; };
  let checks = 0;
  const check = (cond, msg) => { assert.ok(cond, msg); checks++; };

  // 1. Unsigned write rejected.
  check((await post({ address: TOKEN, chainId: 4663, metadata: meta, issuedAt: now() })).code === 401, 'unsigned write must be rejected');

  // 2. Wrong chain rejected.
  check((await post({ address: TOKEN, chainId: 1, metadata: meta, signature: await sign(creator), issuedAt: now() })).code === 400, 'wrong chain must be rejected');

  // 3. Non-creator signature rejected.
  let t = now();
  check((await post({ address: TOKEN, chainId: 4663, metadata: meta, signature: await sign(stranger, { issuedAt: t }), issuedAt: t })).code === 403, 'non-creator signature must be rejected');

  // 4. Signature over DIFFERENT content rejected (binding to the content hash).
  t = now();
  check((await post({ address: TOKEN, chainId: 4663, metadata: { ...meta, description: 'tampered' }, signature: await sign(creator, { issuedAt: t }), issuedAt: t })).code === 403, 'signature must bind the exact content');

  // 5. Unknown (unregistered / merely predicted) launch rejected even with a valid signature.
  t = now();
  check((await post({ address: UNKNOWN, chainId: 4663, metadata: meta, signature: await sign(creator, { token: UNKNOWN, issuedAt: t }), issuedAt: t })).code === 403, 'unknown launch must be rejected');

  // 6. Expired and future-dated signatures rejected (M11).
  t = now() - 11 * 60;
  check((await post({ address: TOKEN, chainId: 4663, metadata: meta, signature: await sign(creator, { issuedAt: t }), issuedAt: t })).body.message === 'signature expired', 'expired signature must be rejected');
  t = now() + 600;
  check((await post({ address: TOKEN, chainId: 4663, metadata: meta, signature: await sign(creator, { issuedAt: t }), issuedAt: t })).code === 400, 'future-dated signature must be rejected');

  // 7. Creator-signed write accepted, stored atomically under the chain-scoped key (SET reply verified).
  const t1 = now() - 5;
  const sig1 = await sign(creator, { issuedAt: t1 });
  let r = await post({ address: TOKEN, chainId: 4663, metadata: meta, signature: sig1, issuedAt: t1 });
  check(r.code === 200, `creator write should succeed: ${JSON.stringify(r.body)}`);
  const setCmd = kvCommands.find((c) => c[0] === 'SET');
  check(setCmd && setCmd[1] === `census:meta:4663:${TOKEN.toLowerCase()}`, 'key must be chain-scoped');

  // 8. Read it back (bookkeeping fields are not exposed).
  r = res();
  await handler({ method: 'GET', query: { address: TOKEN } }, r);
  check(r.code === 200 && r.body.metadata.name === 'Test' && r.body.metadata.issuedAt === undefined, 'read back without bookkeeping');

  // 9. Creator can correct their own metadata (authorized overwrite, newer timestamp).
  const meta2 = { name: 'Test', thesis: 'updated', description: 'd', image: '' };
  const t2 = now();
  r = await post({ address: TOKEN, chainId: 4663, metadata: meta2, signature: await sign(creator, { m: meta2, issuedAt: t2 }), issuedAt: t2 });
  check(r.code === 200, 'creator correction should succeed');
  r = res(); await handler({ method: 'GET', query: { address: TOKEN } }, r);
  check(r.body.metadata.thesis === 'updated', 'correction visible');

  // 10. Rollback protection: replaying the captured v1 signature cannot overwrite v2 (M11).
  r = await post({ address: TOKEN, chainId: 4663, metadata: meta, signature: sig1, issuedAt: t1 });
  check(r.code === 409, 'replayed older signature must be rejected');
  r = res(); await handler({ method: 'GET', query: { address: TOKEN } }, r);
  check(r.body.metadata.thesis === 'updated', 'v2 survives the replay attempt');

  // 11. A KV SET that is not acknowledged is not reported as success.
  kvSetReply = () => 'ERR readonly';
  const t3 = now() + 30; // newer than the stored write, within the future-skew tolerance
  r = await post({ address: TOKEN, chainId: 4663, metadata: { ...meta2, thesis: 'v3' }, signature: await sign(creator, { m: { ...meta2, thesis: 'v3' }, issuedAt: t3 }), issuedAt: t3 });
  check(r.code === 502, 'unacknowledged KV write must not return 200');
  kvSetReply = () => 'OK';

  // 12. RPC serving a different chain than CENSUS_CHAIN_ID fails closed (M10).
  rpcChainHex = '0xb60e'; // 46630 testnet
  const t4 = now() + 30;
  r = await post({ address: TOKEN, chainId: 4663, metadata: { ...meta2, thesis: 'v4' }, signature: await sign(creator, { m: { ...meta2, thesis: 'v4' }, issuedAt: t4 }), issuedAt: t4 });
  check(r.code === 503 && /different chain/.test(r.body.message), 'RPC chain mismatch must fail closed');
  rpcChainHex = '0x1237';

  // 13. Unexpected errors never leak the RPC URL (M12).
  process.env.CENSUS_RPC_URL = 'http://127.0.0.1:1/rpc-secret-path';
  const t5 = now();
  r = await post({ address: TOKEN, chainId: 4663, metadata: meta2, signature: await sign(creator, { m: meta2, issuedAt: t5 }), issuedAt: t5 });
  check(r.code === 500 && !JSON.stringify(r.body).includes('rpc-secret-path'), 'error responses must be generic');
  check(errors.some((e) => e.includes('[metadata] request failed')), 'details are logged server-side');
  process.env.CENSUS_RPC_URL = `${base}/rpc`;

  // 14. Fail closed when verification is unconfigured; no silent mainnet default for the chain id (M10).
  delete process.env.CENSUS_RPC_URL;
  check((await post({ address: TOKEN, chainId: 4663, metadata: meta, signature: await sign(creator), issuedAt: now() })).code === 503, 'missing RPC config must fail closed');
  process.env.CENSUS_RPC_URL = `${base}/rpc`;
  delete process.env.CENSUS_CHAIN_ID;
  check((await post({ address: TOKEN, chainId: 4663, metadata: meta, signature: await sign(creator), issuedAt: now() })).code === 503, 'missing CENSUS_CHAIN_ID must fail closed, not default to mainnet');
  r = res(); await handler({ method: 'GET', query: { address: TOKEN } }, r);
  check(r.code === 200 && r.body.metadata === null && r.body.store === 'unconfigured', 'reads report the unconfigured store');

  server.close();
  console.log(`metadata authorization: ${checks} checks passed`);
}

main().catch((e) => { process.stderr.write(String((e && e.stack) || e) + String.fromCharCode(10)); process.exit(1); });
