// Authorization tests for api/metadata.ts (B18): creator-signed writes, on-chain creator
// verification, chain-scoped keys, atomic KV writes, fail-closed configuration.
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
  // One local server plays both the JSON-RPC node and the Upstash KV REST endpoint.
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      if (req.url.startsWith('/rpc')) {
        const call = (r) => {
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
      let result = null;
      if (parsed[0] === 'SET') { kvStore[parsed[1]] = parsed[2]; result = 'OK'; }
      if (parsed[0] === 'GET') result = kvStore[parsed[1]] ?? null;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result }));
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

  const res = () => {
    const r = { code: 0, body: null, headers: {} };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    return r;
  };
  const meta = { name: 'Test', thesis: 't', description: 'd', image: '' };
  const contentHash = keccak256(stringToBytes(JSON.stringify({ name: 'Test', thesis: 't', description: 'd', image: '' })));
  const sign = (account, chain = 4663, token = TOKEN, hash = contentHash) =>
    account.signMessage({ message: metadataMessage(chain, token, hash) });

  // 1. Unsigned write rejected.
  let r = res();
  await handler({ method: 'POST', body: { address: TOKEN, chainId: 4663, metadata: meta } }, r);
  assert.strictEqual(r.code, 401, 'unsigned write must be rejected');

  // 2. Wrong chain rejected.
  r = res();
  await handler({ method: 'POST', body: { address: TOKEN, chainId: 1, metadata: meta, signature: await sign(creator) } }, r);
  assert.strictEqual(r.code, 400, 'wrong chain must be rejected');

  // 3. Non-creator signature rejected.
  r = res();
  await handler({ method: 'POST', body: { address: TOKEN, chainId: 4663, metadata: meta, signature: await sign(stranger) } }, r);
  assert.strictEqual(r.code, 403, 'non-creator signature must be rejected');

  // 4. Signature over DIFFERENT content rejected (binding to the content hash).
  r = res();
  await handler({ method: 'POST', body: { address: TOKEN, chainId: 4663, metadata: { ...meta, description: 'tampered' }, signature: await sign(creator) } }, r);
  assert.strictEqual(r.code, 403, 'signature must bind the exact content');

  // 5. Unknown (unregistered / merely predicted) launch rejected even with a valid signature.
  r = res();
  await handler({ method: 'POST', body: { address: UNKNOWN, chainId: 4663, metadata: meta, signature: await sign(creator, 4663, UNKNOWN) } }, r);
  assert.strictEqual(r.code, 403, 'unknown launch must be rejected');

  // 6. Creator-signed write accepted, stored atomically under the chain-scoped key.
  r = res();
  await handler({ method: 'POST', body: { address: TOKEN, chainId: 4663, metadata: meta, signature: await sign(creator) } }, r);
  assert.strictEqual(r.code, 200, `creator write should succeed: ${JSON.stringify(r.body)}`);
  const setCmd = kvCommands.find((c) => c[0] === 'SET');
  assert.ok(setCmd, 'a KV SET must be issued');
  assert.strictEqual(setCmd[1], `census:meta:4663:${TOKEN.toLowerCase()}`, 'key must be chain-scoped');

  // 7. Read it back.
  r = res();
  await handler({ method: 'GET', query: { address: TOKEN } }, r);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.metadata.name, 'Test');

  // 8. Creator can correct their own metadata (authorized overwrite).
  const meta2 = { name: 'Test', thesis: 'updated', description: 'd', image: '' };
  r = res();
  await handler({ method: 'POST', body: { address: TOKEN, chainId: 4663, metadata: meta2, signature: await creator.signMessage({ message: metadataMessage(4663, TOKEN, keccak256(stringToBytes(JSON.stringify(meta2)))) }) } }, r);
  assert.strictEqual(r.code, 200, 'creator correction should succeed');
  r = res();
  await handler({ method: 'GET', query: { address: TOKEN } }, r);
  assert.strictEqual(r.body.metadata.thesis, 'updated');

  // 9. Fail closed when verification is unconfigured.
  delete process.env.CENSUS_RPC_URL;
  r = res();
  await handler({ method: 'POST', body: { address: TOKEN, chainId: 4663, metadata: meta, signature: await sign(creator) } }, r);
  assert.strictEqual(r.code, 503, 'missing RPC config must fail closed');

  server.close();
  console.log('metadata authorization: 9 checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
