// Serverless proxy to the 0x Swap API, so the API key never ships to the browser.
// Deployed by Vercel as /api/zeroex (this file lives outside src/, so it's not part of the Vite build).
// Set ZEROX_API_KEY (and optionally ZEROX_API_BASE) in the Vercel project env — NOT as a VITE_ var,
// or it would be inlined into the client bundle and be public.
//
// The frontend calls: /api/zeroex?endpoint=price|quote&chainId=..&sellToken=..&buyToken=..&sellAmount=..
// Only price/quote and a fixed allowlist of params are forwarded, so this can't be used as an open proxy.

const ALLOWED_PARAMS = new Set([
  "chainId", "sellToken", "buyToken", "sellAmount", "buyAmount",
  "taker", "slippageBps", "swapFeeRecipient", "swapFeeBps", "swapFeeToken",
]);

export default async function handler(req: any, res: any) {
  try {
    const key = process.env.ZEROX_API_KEY;
    if (!key) return res.status(500).json({ message: "ZEROX_API_KEY is not set on the server" });

    const endpoint = String(req.query?.endpoint ?? "");
    if (endpoint !== "price" && endpoint !== "quote") {
      return res.status(400).json({ message: "endpoint must be 'price' or 'quote'" });
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
