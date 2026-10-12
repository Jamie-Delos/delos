import "dotenv/config";

const addr = (v: string | undefined, d: string) => (v ?? d).toLowerCase() as `0x${string}`;

// Optional contract address: unset/empty => null (that product is not indexed); set => must be a
// 0x address. The V4 product (CensusCurveV4 + PoolManager + Census hook) is enabled by CURVE_V4_ADDRESS.
function optAddr(name: string): `0x${string}` | null {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v.trim())) throw new Error(`${name} must be a 0x address when set`);
  return v.trim().toLowerCase() as `0x${string}`;
}
const curveV4 = optAddr("CURVE_V4_ADDRESS");
// Contract addresses are deployment-specific: never silently index an old testnet stack.
const curve = optAddr("CURVE_ADDRESS");

export const cfg = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  rpcUrl: process.env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
  chainId: Number(process.env.CHAIN_ID ?? 4663),
  curve,
  factory: addr(process.env.FACTORY_ADDRESS, "0x0000000000000000000000000000000000000000"),
  factoryV2: addr(process.env.FACTORY_V2_ADDRESS, "0x0000000000000000000000000000000000000000"),
  // V4 product (audit/V4-INTEGRATION-SPEC.md). All optional individually; the ingester indexes the V4
  // curve when CURVE_V4_ADDRESS is set, PoolManager swaps of graduated V4 coins when
  // POOL_MANAGER_ADDRESS is set, and hook fee events when HOOK_ADDRESS is set.
  curveV4,
  factoryV4: optAddr("FACTORY_V4_ADDRESS"),
  poolManager: optAddr("POOL_MANAGER_ADDRESS"),
  hook: optAddr("HOOK_ADDRESS"),
  weth: addr(process.env.WETH_ADDRESS, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  startBlock: BigInt(process.env.START_BLOCK ?? 0),
  pollMs: Number(process.env.POLL_MS ?? 4000),
  logPage: BigInt(process.env.LOG_PAGE ?? 5000),
  port: Number(process.env.PORT ?? 8080),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  // USD pricing fails CLOSED: no default. Unset/invalid => USD fields are null (never 0 or a stale
  // placeholder). ETH_USD prices WETH-quoted coins; QUOTE_USD ("0xaddr=1.23,0xaddr2=4.5") prices other
  // quote assets (e.g. HOOD). Company-coin quotes are not priced here (null) until a feed exists.
  ethUsd: parseUsd(process.env.ETH_USD),
  quoteUsd: parseQuoteUsd(process.env.QUOTE_USD),
  // Behind a load balancer the client IP arrives in X-Forwarded-For. Set TRUST_PROXY to the number
  // of trusted hops (e.g. 1) or a comma-separated list of proxy IPs/CIDRs; never a bare "true"
  // (anyone could then spoof the header and share or escape the rate-limit bucket). Unset = direct.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // Explicitly reviewed token=wallet pairs. A launch creator is not automatically a verified company.
  companyCalloutWallets: parseCompanyWallets(process.env.COMPANY_CALLOUT_WALLETS),
};

function parseCompanyWallets(v: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const entry of (v ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const [coin, wallet, extra] = entry.split("=");
    if (extra !== undefined || !/^0x[0-9a-fA-F]{40}$/.test(coin ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(wallet ?? "")) {
      throw new Error("COMPANY_CALLOUT_WALLETS must contain comma-separated coin=wallet addresses");
    }
    (out[coin.toLowerCase()] ??= []).push(wallet.toLowerCase());
  }
  return out;
}

function parseUsd(v: string | undefined): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error("ETH_USD must be a positive number when set");
  return n;
}

function parseQuoteUsd(v: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (v === undefined || v.trim() === "") return out;
  for (const part of v.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [a, p] = part.split("=").map((s) => s.trim());
    const n = Number(p);
    if (!/^0x[0-9a-fA-F]{40}$/.test(a ?? "") || !Number.isFinite(n) || n <= 0) throw new Error(`QUOTE_USD entry invalid: "${part}" (expected 0xaddress=positive number)`);
    out[a.toLowerCase()] = n;
  }
  return out;
}

function parseTrustProxy(v: string | undefined): number | string[] | false {
  if (v === undefined || v.trim() === "" || v.trim() === "false") return false;
  if (v.trim() === "true") throw new Error("TRUST_PROXY must be a hop count or a proxy IP/CIDR list, not 'true'");
  if (/^\d+$/.test(v.trim())) return Number(v.trim());
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

if (!Number.isSafeInteger(cfg.chainId) || cfg.chainId <= 0 || !Number.isFinite(cfg.pollMs) || cfg.pollMs < 500 || cfg.logPage <= 0n || cfg.logPage > 5000n || cfg.startBlock < 0n) {
  throw new Error("Invalid CHAIN_ID, POLL_MS, LOG_PAGE or START_BLOCK");
}
if (cfg.curve !== null && !/^0x[0-9a-f]{40}$/.test(cfg.curve)) throw new Error("Invalid CURVE_ADDRESS");
if (cfg.curve === null && cfg.curveV4 === null) throw new Error("Set CURVE_ADDRESS (legacy V3) and/or CURVE_V4_ADDRESS (V4 product); nothing to index otherwise");
if (cfg.curve !== null && cfg.curve === cfg.curveV4) throw new Error("CURVE_ADDRESS and CURVE_V4_ADDRESS must differ");
