// Serverless proxy to the 0x Swap API, so the API key never ships to the browser.
// Deployed by Vercel as /api/zeroex (this file lives outside src/, so it's not part of the Vite build).
// Set ZEROX_API_KEY (and optionally ZEROX_API_BASE) in the Vercel project env — NOT as a VITE_ var,
// or it would be inlined into the client bundle and be public.
//
// The frontend calls: /api/zeroex?endpoint=price|quote&chainId=..&sellToken=..&buyToken=..&sellAmount=..
// Only price/quote and a fixed allowlist of params are forwarded, so this can't be used as an open proxy.
//
// ABUSE (CX-L1): the proxy spends a shared, paid 0x key. Two guards keep a scripted caller from
// exhausting the key's rate limit / running up the bill:
//   - a per-IP fixed-window rate limit (KV INCR, like /api/upload's quota); and
//   - a chain cap: with CENSUS_CHAIN_ID set, only that chain's quotes are proxied, so the key can't be
//     used for arbitrary chains.
// Best-effort: when KV isn't provisioned the proxy still works (unthrottled) rather than break trading —
// provision KV on mainnet (it is already required for /api/metadata and /api/upload).

const ALLOWED_PARAMS = new Set([
  "chainId", "sellToken", "buyToken", "sellAmount", "buyAmount",
  "taker", "slippageBps", "swapFeeRecipient", "swapFeeBps", "swapFeeToken",
]);

// Per-IP requests per minute. A human trader (debounced price polling + a quote on trade) stays well
// under this; an abuser is capped instead of hammering the shared key. Tunable via env.
const RATE_PER_MIN = Number(process.env.ZEROEX_RATE_PER_MIN || 120);

async function kv(command: unknown[]): Promise<any> {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { unavailable: true };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    return await r.json();
  } catch {
    return { unavailable: true };
  }
}

function clientIp(req: any): string {
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  const xr = req.headers?.["x-real-ip"];
  if (typeof xr === "string" && xr.length) return xr.trim();
  return "unknown";
}

// True when this IP has exceeded RATE_PER_MIN in the current minute window. Fail-open: any KV problem
// returns false (proxy still serves) so a KV outage can't take trading down — the limit is a cost cap,
// not an auth gate.
async function rateLimited(req: any): Promise<boolean> {
  const ip = clientIp(req);
  const key = `census:zeroex:${ip}:${Math.floor(Date.now() / 60000)}`;
  const counted = await kv(["INCR", key]);
  if (counted?.unavailable) return false;
  const n = Number(counted?.result);
  if (!Number.isFinite(n)) return false;
  if (n === 1) await kv(["EXPIRE", key, 120]);
  return n > RATE_PER_MIN;
}

export default async function handler(req: any, res: any) {
  try {
    const key = process.env.ZEROX_API_KEY;
    if (!key) return res.status(500).json({ message: "ZEROX_API_KEY is not set on the server" });

    const endpoint = String(req.query?.endpoint ?? "");
    if (endpoint !== "price" && endpoint !== "quote") {
      return res.status(400).json({ message: "endpoint must be 'price' or 'quote'" });
    }

    // Cost cap: only proxy quotes for Census's own chain (when configured), and throttle per IP.
    const wantChain = process.env.CENSUS_CHAIN_ID;
    const reqChain = req.query?.chainId;
    // When a chain is configured, require an EXACT match — a missing or non-string chainId must be
    // rejected too, not just a mismatched one, so the key is never spent off Census's chain (CX-L1).
    if (wantChain && (typeof reqChain !== "string" || reqChain !== wantChain)) {
      return res.status(400).json({ message: "unsupported or missing chain" });
    }
    if (await rateLimited(req)) {
      res.setHeader("retry-after", "60");
      return res.status(429).json({ message: "too many requests — slow down and retry" });
    }

    const base = process.env.ZEROX_API_BASE || "https://api.0x.org";
    const url = new URL(`${base}/swap/allowance-holder/${endpoint}`);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (ALLOWED_PARAMS.has(k) && typeof v === "string") url.searchParams.set(k, v);
    }

    const upstream = await fetch(url, { headers: { "0x-api-key": key, "0x-version": "v2" } });
    const bodyText = await upstream.text();
    res.status(upstream.status);
    res.setHeader("content-type", "application/json");
    // Short cache on indicative prices; never cache executable quotes.
    if (endpoint === "price") res.setHeader("cache-control", "public, max-age=5");
    return res.send(bodyText);
  } catch (e: any) {
    return res.status(502).json({ message: e?.message || "0x proxy error" });
  }
}
