import { useEffect, useState } from "react";
import { useSignMessage } from "wagmi";
import { CHAIN, INDEXER_URL } from "../config";
import { prepareImage, uploadImage } from "../lib/upload";
import { emptyProfile, getProfile, putProfile, type ProfileFields, type WalletProfile } from "../lib/profiles";
import { shortAddr } from "../census";
import "./profile-identity.css";

export function ProfileIdentity({ wallet, isMine }: { wallet: string; isMine: boolean }) {
  const { signMessageAsync } = useSignMessage();
  const [profile, setProfile] = useState<WalletProfile | null>(null);
  const [draft, setDraft] = useState<ProfileFields>(emptyProfile);
  const [avatarFile, setAvatarFile] = useState("");
  const [bannerFile, setBannerFile] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    setProfile(null); setEditing(false); setError("");
    void getProfile(wallet).then((p) => { if (active) setProfile(p); }).catch(() => { if (active) setError("Public profile could not be loaded."); });
    return () => { active = false; };
  }, [wallet]);
  const current = profile ?? { ...emptyProfile(), wallet, updatedAt: "" };
  const startEdit = () => { setDraft({ displayName: current.displayName, bio: current.bio, avatar: current.avatar, banner: current.banner,
    x: current.x, telegram: current.telegram, website: current.website }); setAvatarFile(""); setBannerFile(""); setError(""); setEditing(true); };
  const set = (key: keyof ProfileFields, value: string) => setDraft((p) => ({ ...p, [key]: value }));
  const selectImage = async (file: File | undefined, kind: "avatar" | "banner") => {
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type) || file.size > 8_000_000) { setError("Use a PNG, JPEG, WebP, or GIF under 8 MB."); return; }
    try { const data = await prepareImage(file, kind === "banner" ? 1600 : 512); if (kind === "avatar") setAvatarFile(data); else setBannerFile(data); setError(""); }
    catch { setError("That image could not be opened."); }
  };
  async function save() {
    if (saving) return;
    setSaving(true); setError("");
    try {
      const next = { ...draft };
      for (const [kind, data] of [["avatar", avatarFile], ["banner", bannerFile]] as const) {
        if (!data) continue;
        const result = await uploadImage(data, { address: wallet, chainId: CHAIN.id, signMessage: signMessageAsync });
        if (!result.url) throw new Error(`${kind === "avatar" ? "Photo" : "Banner"} upload: ${result.reason}`);
        next[kind] = result.url;
      }
      const saved = await putProfile(wallet, next, (message) => signMessageAsync({ message }));
      setProfile(saved); setAvatarFile(""); setBannerFile(""); setEditing(false);
    } catch (e) { setError(e instanceof Error ? e.message.slice(0, 180) : "Could not save profile."); }
    finally { setSaving(false); }
  }
  const copy = () => { void navigator.clipboard?.writeText(wallet); setCopied(true); window.setTimeout(() => setCopied(false), 1200); };
  const socials = [["X", current.x], ["Telegram", current.telegram], ["Website", current.website]] as const;
  return <section className="delos-profile" aria-label="Public profile">
    <div className="delos-profile__banner" style={current.banner ? { backgroundImage: `url("${current.banner}")` } : undefined} />
    <div className="delos-profile__body">
      <div className="delos-profile__avatar">{current.avatar ? <img src={current.avatar} alt="Profile" /> : shortAddr(wallet).slice(0, 4)}</div>
      <div className="delos-profile__heading"><div><h1>{current.displayName || shortAddr(wallet)}</h1>
        <button type="button" className="delos-profile__wallet" onClick={copy} title={wallet}>{shortAddr(wallet)} · {copied ? "Copied" : "Copy address"}</button></div>
        {isMine && INDEXER_URL && <button type="button" className="cx-quiet" onClick={() => editing ? setEditing(false) : startEdit()}>{editing ? "Cancel" : "Edit profile"}</button>}
      </div>
      {current.bio && <p className="delos-profile__bio">{current.bio}</p>}
      {socials.some(([, link]) => link) && <nav className="delos-profile__socials" aria-label="Social links">{socials.filter(([, link]) => link).map(([label, link]) =>
        <a key={label} href={link} target="_blank" rel="noopener noreferrer">{label} ↗</a>)}</nav>}
      {isMine && !INDEXER_URL && <p className="delos-profile__hint">Profile editing opens when Delos profile storage is connected.</p>}
      {editing && <div className="delos-profile__editor">
        <div className="delos-profile__image-fields"><label>Profile photo<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => { void selectImage(e.target.files?.[0], "avatar"); }} /></label>
          <label>Banner<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => { void selectImage(e.target.files?.[0], "banner"); }} /></label></div>
        {(avatarFile || bannerFile) && <p className="delos-profile__hint">New images will appear after you save.</p>}
        <label>Display name<input maxLength={48} value={draft.displayName} onChange={(e) => set("displayName", e.target.value)} placeholder="Your name" /></label>
        <label>Bio<textarea maxLength={500} value={draft.bio} onChange={(e) => set("bio", e.target.value)} placeholder="Tell people what you build, trade, or believe in." /></label>
        <div className="delos-profile__links"><label>X profile<input type="url" value={draft.x} onChange={(e) => set("x", e.target.value)} placeholder="https://x.com/you" /></label>
          <label>Telegram<input type="url" value={draft.telegram} onChange={(e) => set("telegram", e.target.value)} placeholder="https://t.me/you" /></label>
          <label>Website<input type="url" value={draft.website} onChange={(e) => set("website", e.target.value)} placeholder="https://example.com" /></label></div>
        <div className="delos-profile__actions"><span>Saving requires a wallet signature. Images require separate upload signatures.</span>
          <button type="button" className="cx-cta" disabled={saving} onClick={() => { void save(); }}>{saving ? "Saving…" : "Save profile"}</button></div>
      </div>}
      {error && <p role="alert" className="delos-profile__error">{error}</p>}
    </div>
  </section>;
}
