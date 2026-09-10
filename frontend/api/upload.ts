// Logo upload for the launch wizard. Accepts a small image data URL (POST { image }) and stores it in
// Vercel Blob, returning a public https URL that fits the metadata store's URL field.
// Provision "Blob" storage on the Vercel project to inject BLOB_READ_WRITE_TOKEN; until then this
// returns 503 and the wizard keeps a local preview (same graceful-degrade contract as /api/metadata).
//   POST /api/upload { image: "data:image/png;base64,…" } -> { url: "https://….public.blob…" }
import { put } from "@vercel/blob";

const MAX_BYTES = 1_500_000; // downscaled logos are tens of KB; well under Vercel's 4.5MB function-body limit

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== "POST") return res.status(405).json({ message: "method not allowed" });
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) return res.status(503).json({ message: "image store not provisioned" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const dataUrl = String(body.image ?? "");
    const m = /^data:(image\/(png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) return res.status(400).json({ message: "expected an image data URL" });

    const mime = m[1];
    const ext = mime.split("/")[1].replace("jpeg", "jpg");
    const buf = Buffer.from(m[3], "base64");
    if (!buf.length) return res.status(400).json({ message: "empty image" });
    if (buf.length > MAX_BYTES) return res.status(413).json({ message: "image too large" });

    const name = `census/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { url } = await put(name, buf, { access: "public", contentType: mime, token });
    return res.status(200).json({ url });
  } catch (e: any) {
    return res.status(500).json({ message: e?.message ?? "upload error" });
  }
}
