// Tests for release-check.cjs: the gate must fail closed on every missing/placeholder value and pass
// only for a complete V4 configuration against a V4-presenting source tree.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { check, parseEnvFile } = require("./release-check.cjs");

const addr = (n) => "0x" + n.toString(16).padStart(40, "0");
const V4_KEYS = ["VITE_FACTORY_V4_ADDRESS", "VITE_CURVE_V4_ADDRESS", "VITE_V4_ROUTER", "VITE_V4_HOOK", "VITE_POOL_MANAGER", "VITE_STATE_VIEW", "VITE_V4_QUOTER"];
const LEGACY_KEYS = ["VITE_FACTORY_ADDRESS", "VITE_FACTORY_V2_ADDRESS", "VITE_LOCKER_ADDRESS", "VITE_CURVE_ADDRESS", "VITE_QUOTER"];
const GOOD = {
  VITE_CHAIN_ID: "4663",
  ...Object.fromEntries(V4_KEYS.map((k, i) => [k, addr(i + 1)])),
  VITE_INDEXER_URL: "https://indexer.example", VITE_FROM_BLOCK: "123",
  VITE_PRIVY_APP_ID: "c".repeat(25),
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "census-release-check-"));
// A V4-presenting tree: the marker is exported and neither V3 pattern remains.
const v4Src = path.join(tmp, "v4src"); fs.mkdirSync(path.join(v4Src, "pages"), { recursive: true });
fs.writeFileSync(path.join(v4Src, "config.ts"), 'export const GRADUATION_VENUE = "v4" as const;\nexport const LEGACY_V3_POOL_FEE = 10000; // legacy V3 pool reads only\n');
fs.writeFileSync(path.join(v4Src, "pages", "Coin.tsx"), "const feeRate = feeBps / 10000; // base + reflection\n");
// A V3-era tree: no marker, the 1% tier is the venue, and Coin.tsx labels graduated trades with it.
const v3Src = path.join(tmp, "v3src"); fs.mkdirSync(path.join(v3Src, "pages"), { recursive: true });
fs.writeFileSync(path.join(v3Src, "config.ts"), "export const DEFAULT_FEE = 10000; // 1% tier\n");
fs.writeFileSync(path.join(v3Src, "pages", "Coin.tsx"), "const feeRate = onCurve ? x : poolFee / 1e6;\n");
// A half-migrated tree: marker exported but the V3 patterns linger — still not releasable.
const halfSrc = path.join(tmp, "halfsrc"); fs.mkdirSync(path.join(halfSrc, "pages"), { recursive: true });
fs.writeFileSync(path.join(halfSrc, "config.ts"), 'export const GRADUATION_VENUE = "v4";\nexport const DEFAULT_FEE = 10000;\n');
fs.writeFileSync(path.join(halfSrc, "pages", "Coin.tsx"), "const feeRate = poolFee / 1e6;\n");

let n = 0;
const failsWith = (env, srcDir, re, chain = 4663) => { const r = check({ env, srcDir, releaseChainId: chain }); assert.ok(r.failures.some((f) => re.test(f)), `expected a failure matching ${re}; got ${JSON.stringify(r.failures)}`); n++; };
const passes = (env, srcDir, chain = 4663) => { const r = check({ env, srcDir, releaseChainId: chain }); assert.deepEqual(r.failures, [], `expected no failures; got ${JSON.stringify(r.failures)}`); n++; return r; };

// complete V4 configuration + V4 presentation => releasable, with no legacy address at all
passes(GOOD, v4Src);
// every required V4 address: missing, zero, malformed, duplicated
for (const k of V4_KEYS) {
  failsWith({ ...GOOD, [k]: undefined }, v4Src, new RegExp(`${k}.*missing`));
  failsWith({ ...GOOD, [k]: "0x" + "0".repeat(40) }, v4Src, new RegExp(`${k}.*zero address`));
  failsWith({ ...GOOD, [k]: "0x1234" }, v4Src, new RegExp(`${k}.*missing or not`));
}
failsWith({ ...GOOD, VITE_V4_QUOTER: GOOD.VITE_CURVE_V4_ADDRESS }, v4Src, /VITE_V4_QUOTER duplicates VITE_CURVE_V4_ADDRESS/);
failsWith({ ...GOOD, VITE_V4_HOOK: GOOD.VITE_V4_ROUTER }, v4Src, /VITE_V4_HOOK duplicates VITE_V4_ROUTER/);
// legacy addresses are optional: absent is fine, well-formed is fine, malformed or colliding is not
passes({ ...GOOD, ...Object.fromEntries(LEGACY_KEYS.map((k, i) => [k, addr(100 + i)])) }, v4Src);
for (const k of LEGACY_KEYS) {
  passes({ ...GOOD, [k]: undefined }, v4Src);
  passes({ ...GOOD, [k]: "" }, v4Src);
  failsWith({ ...GOOD, [k]: "0x1234" }, v4Src, new RegExp(`${k}.*not a 20-byte hex address`));
  failsWith({ ...GOOD, [k]: GOOD.VITE_FACTORY_V4_ADDRESS }, v4Src, new RegExp(`${k} duplicates VITE_FACTORY_V4_ADDRESS`));
}
{ const r = passes({ ...GOOD, VITE_CURVE_ADDRESS: "0x" + "0".repeat(40) }, v4Src); assert.ok(r.warnings.some((w) => /VITE_CURVE_ADDRESS.*zero address/.test(w))); n++; }
// indexer URL: empty, unset, http
failsWith({ ...GOOD, VITE_INDEXER_URL: "" }, v4Src, /VITE_INDEXER_URL is empty/);
failsWith({ ...GOOD, VITE_INDEXER_URL: undefined }, v4Src, /VITE_INDEXER_URL is empty/);
failsWith({ ...GOOD, VITE_INDEXER_URL: "http://indexer.example" }, v4Src, /must be an https/);
// chain mismatch and off-mainnet Uniswap requirements
failsWith({ ...GOOD, VITE_CHAIN_ID: "46630" }, v4Src, /VITE_CHAIN_ID=46630 but this release targets chain 4663/);
failsWith({ ...GOOD, VITE_REHEARSAL_GRADUATION_ETH: "0.02" }, v4Src, /VITE_REHEARSAL_GRADUATION_ETH must be removed/);
failsWith({ ...GOOD, VITE_CHAIN_ID: "46630" }, v4Src, /VITE_WETH is required off mainnet/, 46630);
passes({ ...GOOD, VITE_CHAIN_ID: "46630", VITE_WETH: addr(7), VITE_SWAP_ROUTER: addr(8), VITE_V3_FACTORY: addr(9) }, v4Src, 46630);
// secrets and Privy
failsWith({ ...GOOD, VITE_ZEROX_API_KEY: "x" }, v4Src, /secret must never be a VITE_/);
failsWith({ ...GOOD, VITE_PRIVY_APP_ID: "short" }, v4Src, /VITE_PRIVY_APP_ID.*25-character/);
// V3 fee presentation is a release failure even with a complete env
failsWith(GOOD, v3Src, /GRADUATION_VENUE.*not exported/);
failsWith(GOOD, v3Src, /DEFAULT_FEE = 10000.*V4 canonical-pool fee.*not wired/);
failsWith(GOOD, v3Src, /Coin\.tsx.*V3 pool tier/);
// the marker alone is not enough: lingering V3 patterns still fail
failsWith(GOOD, halfSrc, /DEFAULT_FEE = 10000.*not wired/);
failsWith(GOOD, halfSrc, /Coin\.tsx.*V3 pool tier/);
// this checkout's real source tree presents the V4 product => the presentation check passes
passes(GOOD, path.join(__dirname, "src"));
// .env parsing: quotes, inline comments, blank/comment lines
const envFile = path.join(tmp, ".env"); fs.writeFileSync(envFile, '# c\nVITE_A="x y"\nVITE_B=0x1 # trailing\n\nVITE_C=\'z\'\n');
assert.deepEqual(parseEnvFile(envFile), { VITE_A: "x y", VITE_B: "0x1", VITE_C: "z" }); n++;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`release-check.test.cjs: ${n} checks passed`);
