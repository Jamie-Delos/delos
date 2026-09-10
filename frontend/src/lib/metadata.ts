// Client for the /api/metadata store (thesis / description / logo URL per launched coin).
// Degrades to null / false when the store isn't provisioned yet, so the UI never breaks.
export type CoinMetadata = { name?: string; thesis?: string; description?: string; image?: string };

export async function getMetadata(address: string): Promise<CoinMetadata | null> {
  try {
    const r = await fetch(`/api/metadata?address=${address}`);
    if (!r.ok) return null;
    const j = await r.json();
    return (j?.metadata as CoinMetadata) ?? null;
  } catch {
    return null;
  }
}

export async function putMetadata(address: string, metadata: CoinMetadata): Promise<boolean> {
  try {
    const r = await fetch(`/api/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, metadata }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
