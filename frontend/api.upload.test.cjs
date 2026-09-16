// Authorization tests for api/upload.ts: wallet-signed uploads bound to the image bytes, expiry,
// per-wallet daily quota, fail-closed configuration, no provider-error leakage.
// Build first: npx esbuild api/upload.ts --bundle --platform=node --format=cjs --outfile=.test-build/upload.cjs --external:viem --external:@vercel/blob
// Run: node api.upload.test.cjs
const http = require('node:http');
const assert = require('node:assert');

async function main() {
  const { privateKeyToAccount } = require('viem/accounts');
  const { keccak256 } = require('viem');
  const wallet = privateKeyToAccount('0x' + '31'.repeat(32));
  const other = privateKeyToAccount('0x' + '32'.repeat(32));

  // Fake KV (INCR/EXPIRE) REST endpoint.
  const counters = {};
  let kvFail = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const cmd = JSON.parse(body);
      let reply = { result: null };
      if (kvFail) reply = { error: 'ERR' };
      else if (cmd[0] === 'INCR') { counters[cmd[1]] = (counters[cmd[1]] ?? 0) + 1; reply = { result: counters[cmd[1]] }; }
      else if (cmd[0] === 'EXPIRE') reply = { result: 1 };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.CENSUS_CHAIN_ID = '4663';
  process.env.KV_REST_API_URL = base;
  process.env.KV_REST_API_TOKEN = 'test';
  process.env.BLOB_READ_WRITE_TOKEN = 'blob-secret-token';
  process.env.UPLOAD_DAILY_QUOTA = '2';

  // Stub the blob SDK before loading the bundle (it is marked external).
  const Module = require('node:module');
  const realResolve = Module._resolveFilename;
  const puts = [];
  let putFail = false;
  require.cache['@vercel/blob'] = { id: '@vercel/blob', filename: '@vercel/blob', loaded: true, exports: { put: async () => { throw new Error('unused'); } } };
  Module._resolveFilename = function (request, ...rest) { return request === '@vercel/blob' ? '@vercel/blob' : realResolve.call(this, request, ...rest); };
  const mod = require('./.test-build/upload.cjs');
  mod.deps.put = async (name, buf, opts) => { if (putFail) throw new Error(`blob rejected token ${opts.token}`); puts.push({ name, size: buf.length, opts }); return { url: `https://blob.example/${name}` }; };
  const handler = mod.default;
  const { uploadMessage } = mod;
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  process.on('exit', () => { console.error = realError; });

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const image = `data:image/png;base64,${png.toString('base64')}`;
  const hash = keccak256(new Uint8Array(png));
  const now = () => Math.floor(Date.now() / 1000);
  const sign = (account, { issuedAt = now(), h = hash, chain = 4663, addr = account.address } = {}) => account.signMessage({ message: uploadMessage(chain, addr, h, issuedAt) });
  const res = () => { const r = { code: 0, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  const post = async (body) => { const r = res(); await handler({ method: 'POST', body }, r); return r; };
  let checks = 0;
  const check = (c, m) => { assert.ok(c, m); checks++; };

  check((await post({ image, address: wallet.address, issuedAt: now() })).code === 401, 'unsigned upload rejected');
  let t = now();
  check((await post({ image, address: wallet.address, signature: await sign(other, { issuedAt: t }), issuedAt: t })).code === 403, 'signature must come from the claimed wallet');
  t = now();
  check((await post({ image, address: wallet.address, signature: await sign(wallet, { issuedAt: t, h: keccak256('0x01') }), issuedAt: t })).code === 403, 'signature must bind the exact image bytes');
  t = now() - 11 * 60;
  check((await post({ image, address: wallet.address, signature: await sign(wallet, { issuedAt: t }), issuedAt: t })).body.message === 'signature expired', 'expired signature rejected');
  t = now();
  check((await post({ image: 'data:text/html;base64,PGh0bWw+', address: wallet.address, signature: await sign(wallet, { issuedAt: t }), issuedAt: t })).code === 400, 'non-image payloads rejected');

  t = now();
  let r = await post({ image, address: wallet.address, signature: await sign(wallet, { issuedAt: t }), issuedAt: t });
  check(r.code === 200 && r.body.url.startsWith('https://blob.example/census/4663/' + wallet.address.toLowerCase()), `signed upload stored under the wallet: ${JSON.stringify(r.body)}`);
  check(puts.length === 1 && puts[0].size === png.length && puts[0].opts.contentType === 'image/png', 'bytes and MIME forwarded to the store');
  r = await post({ image, address: wallet.address, signature: await sign(wallet, { issuedAt: t }), issuedAt: t });
  check(r.code === 200, 'second upload within quota');
  r = await post({ image, address: wallet.address, signature: await sign(wallet, { issuedAt: t }), issuedAt: t });
  check(r.code === 429 && puts.length === 2, 'per-wallet daily quota enforced before storing');
  t = now();
  r = await post({ image, address: other.address, signature: await sign(other, { issuedAt: t }), issuedAt: t });
  check(r.code === 200, 'quota is per wallet');

  kvFail = true;
  t = now();
  r = await post({ image, address: other.address, signature: await sign(other, { issuedAt: t }), issuedAt: t });
  check(r.code === 502, 'quota store failure is not treated as unlimited');
  kvFail = false;

  putFail = true;
  t = now();
  r = await post({ image, address: other.address, signature: await sign(other, { issuedAt: t }), issuedAt: t });
  check(r.code === 500 && !JSON.stringify(r.body).includes('blob-secret-token'), 'provider errors never leak');
  check(errors.some((e) => e.includes('[upload] request failed')), 'provider errors are logged');
  putFail = false;

  delete process.env.BLOB_READ_WRITE_TOKEN;
  check((await post({ image, address: wallet.address, signature: await sign(wallet), issuedAt: now() })).code === 503, 'no blob token -> fail closed');
  process.env.BLOB_READ_WRITE_TOKEN = 'blob-secret-token';
  delete process.env.CENSUS_CHAIN_ID;
  check((await post({ image, address: wallet.address, signature: await sign(wallet), issuedAt: now() })).code === 503, 'no chain id -> fail closed');
  process.env.CENSUS_CHAIN_ID = '4663';
  delete process.env.KV_REST_API_URL;
  check((await post({ image, address: wallet.address, signature: await sign(wallet), issuedAt: now() })).code === 503, 'no quota store -> fail closed');

  server.close();
  console.log(`upload authorization: ${checks} checks passed`);
}

main().catch((e) => { process.stderr.write(String((e && e.stack) || e) + String.fromCharCode(10)); process.exit(1); });
