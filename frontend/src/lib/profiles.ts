import { CHAIN, INDEXER_URL } from "../config";

export type ProfileFields = { displayName: string; bio: string; avatar: string; banner: string; x: string; telegram: string; website: string };
export type WalletProfile = ProfileFields & { wallet: string; updatedAt: string };
export const emptyProfile = (): ProfileFields => ({ displayName: "", bio: "", avatar: "", banner: "", x: "", telegram: "", website: "" });

function url(raw: string, hosts?: string[]): string {
  if (!raw.trim()) return "";
  const value = new URL(raw.trim());
  if (value.protocol !== "https:" || value.username || value.password || !value.hostname.includes(".") || (hosts && !hosts.includes(value.hostname))) throw new Error("Use a valid https link for each social.");
  if (value.toString().length > 200) throw new Error("Social link is too long.");
  return value.toString();
}
export function cleanProfile(raw: ProfileFields): ProfileFields {
  if (raw.displayName.length > 48 || raw.bio.length > 500) throw new Error("Name or bio is too long.");
  return { displayName: raw.displayName.trim(), bio: raw.bio.trim(), avatar: raw.avatar, banner: raw.banner,
    x: url(raw.x, ["x.com", "www.x.com", "twitter.com", "www.twitter.com"]),
    telegram: url(raw.telegram, ["t.me", "telegram.me"]), website: url(raw.website) };
}
// Keep byte-for-byte identical to indexer/src/social.ts.
function profileMessage(wallet: string, profile: ProfileFields, issuedAt: number, nonce: string) {
  return `Delos profile\nChain: ${CHAIN.id}\nWallet: ${wallet}\nProfile: ${JSON.stringify(profile)}\nIssued: ${issuedAt}\nNonce: ${nonce}`;
}
export async function getProfile(wallet: string): Promise<WalletProfile | null> {
  if (!INDEXER_URL) return null;
  const response = await fetch(`${INDEXER_URL}/profiles/${wallet.toLowerCase()}`);
  if (!response.ok) throw new Error("Profile unavailable");
  const body = await response.json();
  return body.profile ?? null;
}
export async function putProfile(wallet: string, raw: ProfileFields, sign: (message: string) => Promise<string>): Promise<WalletProfile> {
  if (!INDEXER_URL) throw new Error("Profile storage is not configured yet.");
  const owner = wallet.toLowerCase(), profile = cleanProfile(raw), issuedAt = Date.now(), nonce = crypto.randomUUID();
  const signature = await sign(profileMessage(owner, profile, issuedAt, nonce));
  const response = await fetch(`${INDEXER_URL}/profiles/${owner}`, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile, issuedAt, nonce, signature }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Profile save failed (${response.status})`);
  return body.profile as WalletProfile;
}
