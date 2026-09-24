#!/usr/bin/env node
// Release-configuration gate for the frontend bundle. FAILS CLOSED: a production build whose
// configuration is incomplete must not ship as "ready". Run before every production deploy:
//   npm run release:check              (reads .env, then .env.production, then process.env)
//   RELEASE_CHAIN_ID=46630 npm run release:check   (a testnet release)
// Exit code 1 lists every failure with the variable or file that must change.
const fs = require("node:fs");
const path = require("node:path");
const { checkNetwork } = require("./network-check.cjs");

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x" + "0".repeat(40);
// The V4 product stack (audit/V4-INTEGRATION-SPEC.md). Every one of these is required.
const REQUIRED_ADDRESSES = [
  ["VITE_FACTORY_V4_ADDRESS", "LaunchFactoryV4 (every new launch; CREATE2 deployer for the c0de grind)"],
  ["VITE_CURVE_V4_ADDRESS", "CensusCurveV4 (curve trading)"],
  ["VITE_V4_ROUTER", "CensusV4Router (post-graduation trades in the hooked pool)"],
  ["VITE_V4_HOOK", "CensusV4Hook (fee policy; part of the PoolKey)"],
  ["VITE_POOL_MANAGER", "Uniswap V4 PoolManager"],
  ["VITE_STATE_VIEW", "Uniswap V4 StateView (pool spot reads)"],
  ["VITE_V4_QUOTER", "Uniswap V4Quoter (impact-aware pool quotes; mainnet gate G13)"],
];
// Legacy V3-era addresses: optional (old testnet coins only), but if set they must be well-formed and
// must not collide with each other or with the V4 set.
const OPTIONAL_ADDRESSES = [
  ["VITE_FACTORY_ADDRESS", "LaunchFactory (legacy Prima)"],
  ["VITE_FACTORY_V2_ADDRESS", "LaunchFactoryV2 (legacy Maxima)"],
  ["VITE_LOCKER_ADDRESS", "LaunchLocker (legacy)"],
  ["VITE_CURVE_ADDRESS", "CensusCurve (legacy)"],
  ["VITE_QUOTER", "Uniswap V3 QuoterV2 (legacy pool quotes)"],
];

function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

// Match Vite's precedence, including local files (which must never be uploaded to Vercel).
function loadEnv(dir) {
  return { ...parseEnvFile(path.join(dir, ".env")), ...parseEnvFile(path.join(dir, ".env.local")), ...parseEnvFile(path.join(dir, ".env.production")), ...parseEnvFile(path.join(dir, ".env.production.local")), ...process.env };
}

function check({ env, srcDir, releaseChainId }) {
  const failures = [];
  if (releaseChainId === 4663) failures.push(...checkNetwork(env));
  const warnings = [];
  const chainId = Number(env.VITE_CHAIN_ID ?? 4663);
  if (chainId !== releaseChainId) failures.push(`VITE_CHAIN_ID=${env.VITE_CHAIN_ID ?? "(unset => 4663)"} but this release targets chain ${releaseChainId}`);
  if ((env.VITE_REHEARSAL_GRADUATION_ETH ?? "").trim()) failures.push("VITE_REHEARSAL_GRADUATION_ETH must be removed for a live release");

  const seen = new Map();
  for (const [key, what] of REQUIRED_ADDRESSES) {
    const v = (env[key] ?? "").trim();
    if (!ADDRESS.test(v)) failures.push(`${key} (${what}) is missing or not a 20-byte hex address`);
    else if (v.toLowerCase() === ZERO) failures.push(`${key} (${what}) is the zero address: the bundle would ship unconfigured`);
    else if (seen.has(v.toLowerCase())) failures.push(`${key} duplicates ${seen.get(v.toLowerCase())}: two contracts cannot share an address`);
    else seen.set(v.toLowerCase(), key);
  }
  for (const [key, what] of OPTIONAL_ADDRESSES) {
    const v = (env[key] ?? "").trim();
    if (!v) continue; // legacy: unset is fine
    if (!ADDRESS.test(v)) failures.push(`${key} (${what}) is set but not a 20-byte hex address (unset it, or set the legacy address)`);
    else if (v.toLowerCase() === ZERO) warnings.push(`${key} (${what}) is the zero address: legacy coins are off (unset it to silence this)`);
    else if (seen.has(v.toLowerCase())) failures.push(`${key} duplicates ${seen.get(v.toLowerCase())}: two contracts cannot share an address`);
    else seen.set(v.toLowerCase(), key);
  }
  if (releaseChainId !== 4663) {
    for (const key of ["VITE_WETH", "VITE_SWAP_ROUTER", "VITE_V3_FACTORY"]) {
      const v = (env[key] ?? "").trim();
      if (!ADDRESS.test(v) || v.toLowerCase() === ZERO) failures.push(`${key} is required off mainnet (CX-H3: no silent mainnet fallback)`);
    }
  }

  const indexer = (env.VITE_INDEXER_URL ?? "").trim();
  if (!indexer) failures.push("VITE_INDEXER_URL is empty: the board would scan chain logs from the browser on every load (G10)");
  else if (!/^https:\/\/[^\s/]+/.test(indexer)) failures.push(`VITE_INDEXER_URL="${indexer}" must be an https:// origin`);

  const fromBlock = Number(env.VITE_FROM_BLOCK ?? 0);
  if (!Number.isInteger(fromBlock) || fromBlock <= 0) warnings.push("VITE_FROM_BLOCK is unset/0: the no-indexer fallback scans from block 0 (set it to the factory deploy block)");
  const privy = (env.VITE_PRIVY_APP_ID ?? "").trim();
  if (privy && privy.length !== 25) failures.push("VITE_PRIVY_APP_ID is set but is not a 25-character Privy App ID (sign-up would be silently disabled)");
  if (!privy) warnings.push("VITE_PRIVY_APP_ID is unset: wallet-only connect, no email/social sign-up");
  for (const key of Object.keys(env)) {
    if (/^VITE_/.test(key) && /(SECRET|PRIVATE|API_KEY)/i.test(key)) failures.push(`${key}: a secret must never be a VITE_ variable (it ships in the browser bundle)`);
  }

  // Fee presentation must match the agreed V4 product: 2% base (+ optional 1-4% reflection) charged by
  // the Census hook in the canonical pool. A source tree that still graduates into a Uniswap V3 tier
  // (DEFAULT_FEE = 10000 => "1% pool fee") or labels graduated trades with the tier (poolFee / 1e6) is a
  // V3 release, not the V4 product. `GRADUATION_VENUE = "v4"` in config.ts marks a V4 tree; the two
  // V3 patterns must be gone from it as well.
  const configTs = readIf(path.join(srcDir, "config.ts"));
  const coinTsx = readIf(path.join(srcDir, "pages", "Coin.tsx"));
  const v4Marker = /GRADUATION_VENUE\s*=\s*["']v4["']/.test(configTs);
  if (!v4Marker) failures.push("src/config.ts: GRADUATION_VENUE = \"v4\" is not exported; the V4 canonical-pool product (2% base + reflection, Census hook) is not wired (P0 in GO-LIVE-READINESS)");
  if (/DEFAULT_FEE\s*=\s*10000/.test(configTs)) failures.push("src/config.ts: DEFAULT_FEE = 10000 (Uniswap V3 1% tier) is still the graduation venue; the V4 canonical-pool fee (2% base + reflection) is not wired (P0 in GO-LIVE-READINESS)");
  if (/poolFee\s*\/\s*1e6/.test(coinTsx)) failures.push("src/pages/Coin.tsx: graduated trades are labelled with the V3 pool tier (poolFee / 1e6 => \"pool fee\"); V4 fee breakdown (base + reflection, Census/creator split) is not presented");
  return { failures, warnings, chainId };
}

function readIf(file) { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; }

module.exports = { check, loadEnv, parseEnvFile, REQUIRED_ADDRESSES, OPTIONAL_ADDRESSES };

if (require.main === module) {
  const dir = __dirname;
  const releaseChainId = Number(process.env.RELEASE_CHAIN_ID ?? 4663);
  const { failures, warnings, chainId } = check({ env: loadEnv(dir), srcDir: path.join(dir, "src"), releaseChainId });
  console.log(`release-check: chain ${chainId} (release target ${releaseChainId})`);
  for (const w of warnings) console.log(`  WARN ${w}`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  if (failures.length) { console.log(`release-check: NOT RELEASABLE (${failures.length} failure${failures.length === 1 ? "" : "s"})`); process.exit(1); }
  console.log("release-check: configuration complete");
}
