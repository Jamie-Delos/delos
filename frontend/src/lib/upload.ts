// Client-side logo handling for the launch wizard's drag-and-drop image field.
// `prepareImage` downscales the dropped file to a small thumbnail and returns a data URL for instant
// preview (keeps the payload tiny — logos land at tens of KB, not megabytes). `uploadImage` best-effort
// stores it via /api/upload and returns a persistent hosted URL; when the blob store isn't provisioned
// it returns null and the caller keeps the local preview (same graceful-degrade contract as metadata).

const MAX_DIM = 512;

export async function prepareImage(file: File): Promise<string> {
  const src = await readAsDataUrl(file);
  try {
    const img = await loadImage(src);
    const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    if (scale >= 1) return src; // already small enough — keep the original bytes
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return src;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/png"); // PNG keeps logo transparency
  } catch {
    return src; // decode failed (e.g. SVG/odd format) — fall back to the raw data URL for preview
  }
}

export async function uploadImage(dataUrl: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: dataUrl }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j?.url === "string" ? j.url : null;
  } catch {
    return null;
  }
}

export const isHostedUrl = (s: string) => /^https?:\/\//i.test(s) && s.length <= 400;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}
