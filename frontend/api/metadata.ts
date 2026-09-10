// Metadata store for launched coins — thesis / description / logo URL, keyed by token address.
// The chain holds name/ticker/economics; this holds the off-chain copy the wizard collects.
// Backed by Vercel KV (Upstash Redis REST): enable "KV" storage on the Vercel project and it injects
// KV_REST_API_URL + KV_REST_API_TOKEN. Until then this degrades gracefully (GET returns null,
// POST returns 503) so the launch flow still works — the metadata just isn't persisted yet.
//   GET  /api/metadata?address=0x…          -> { address, metadata: {…} | null }
//   POST /api/metadata { address, metadata } -> { ok: true }   (first-write-wins, anti-grief)

const KEY = (addr: string) => `census:meta:${addr.toLowerCase()}`;
const isAddr = (s: any) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

async function kv(path: string, init?: any): Promise<any> {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return { unavailable: true };
  const r = await fetch(`${url}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.headers || {}) } });
  return r.json();
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method === "GET") {
      const address = String(req.query?.address ?? "");
      if (!isAddr(address)) return res.status(400).json({ message: "bad address" });
      const out = await kv(`/get/${KEY(address)}`);
      if (out?.unavailable) return res.status(200).json({ address, metadata: null, store: "unavailable" });
      let metadata: any = null;
      try { metadata = out?.result ? JSON.parse(out.result) : null; } catch { metadata = null; }
      res.setHeader("cache-control", "public, max-age=10");
      return res.status(200).json({ address, metadata });
    }
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const address = String(body.address ?? "");
      if (!isAddr(address)) return res.status(400).json({ message: "bad address" });
      const meta = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
      const clean = {
        name: String(meta.name ?? "").slice(0, 64),
        thesis: String(meta.thesis ?? "").slice(0, 140),
        description: String(meta.description ?? "").slice(0, 2000),
        image: String(meta.image ?? "").slice(0, 400),
      };
      const existing = await kv(`/get/${KEY(address)}`);
      if (existing?.unavailable) return res.status(503).json({ message: "metadata store not provisioned" });
      if (existing?.result) return res.status(409).json({ message: "metadata already set" }); // immutable first write
      await kv(`/set/${KEY(address)}`, { method: "POST", body: JSON.stringify(clean) });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ message: "method not allowed" });
  } catch (e: any) {
    return res.status(500).json({ message: e?.message ?? "error" });
  }
}
