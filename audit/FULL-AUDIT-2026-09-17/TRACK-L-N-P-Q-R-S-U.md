# Census audit — hands-on tracks (serverless, frontend, secrets, content, mobile)

Done by me directly with evidence (build + bundle grep + live dev-server/browser at localhost:5173).
Tags: PROVEN / DERIVED / SUSPECTED. Severity S0–S4.

## Headline

The serverless API surface and the front-end are in **good shape**. Every write endpoint is
signature-bound and creator-verified, no secret ships to the browser, there is no stored-XSS path,
the trade flow can't be double-submitted and doesn't fake success, and the layout doesn't overflow at
phone width. The real gaps are **rate-limiting / cost caps** on the public endpoints, **single-RPC
fragility** (see track K), and a handful of **a11y / polish** items — not auth bypass or theft.

---

## Track L — serverless API (`frontend/api/{zeroex,upload,metadata}.ts`)

### CX-L1 — S2 (easy) — `/api/zeroex` is unauthenticated and unthrottled → 0x key exhaustion — **FIXED 2026-09-17**
**STATUS: FIXED.** `frontend/api/zeroex.ts` now enforces a per-IP fixed-window rate limit (KV `INCR`, `ZEROEX_RATE_PER_MIN` default 120) and a chain cap (rejects any `chainId` != `CENSUS_CHAIN_ID` before the upstream call, so the key can't be spent on other chains). Fail-open when KV is absent (a KV outage can't take trading down). Proven by `frontend/api.zeroex.test.cjs` (rate limit → 429+retry-after, independent IPs, chain-cap doesn't hit the key, fail-open, key/endpoint guards). Note: per-IP only — IP rotation is out of scope; the goal is to cap single-source cost. Original finding below.

**WHERE** `frontend/api/zeroex.ts` (whole file — no auth, no rate limit). **WHAT HAPPENS** Anyone can
curl `/api/zeroex?endpoint=quote&...` as fast as they like; each call spends the server's `ZEROX_API_KEY`
against the 0x API. A scripted attacker exhausts the key's rate limit / paid quota, so every real user's
quotes start failing, and/or runs up a 0x bill. `price` has a 5 s CDN cache (`cache-control: max-age=5`)
which blunts *identical* price queries only; `quote` is uncached and varied params bypass it.
**PROOF** DERIVED (read the handler; no token/rate-limit/Origin check). It is correctly NOT an open
proxy (fixed `price|quote` path + `ALLOWED_PARAMS` allowlist), so this is abuse-of-cost, not SSRF.
**BLAST RADIUS** Trading quotes degrade platform-wide; 0x bill/lockout. **FIX** Rate-limit per IP
(KV token bucket, as `upload.ts` already does per wallet), cap `chainId` to Census's chain, and add a
short cache to `quote` misses or a global QPS ceiling. **TEST** A loop of N calls returns 429 after the
budget.

### CX-L2 — S3 (easy) — `/api/metadata` POST costs an RPC read + KV op per attempt, unthrottled — **FIXED 2026-09-17**
**STATUS: FIXED.** `frontend/api/metadata.ts` now applies the same per-IP fixed-window rate limit (`METADATA_RATE_PER_MIN` default 30) to POST, **before** the signature recover + on-chain read, so a scripted caller can't abuse the RPC/function budget. Fail-open (a POST already 503s without KV). Tested in `api.metadata.test.cjs` (6th POST from one IP → 429; a different IP is not throttled). Original finding below.

**WHERE** `frontend/api/metadata.ts:131-145`. **WHAT HAPPENS** A well-formed 130-hex signature recovers
to *some* address (cheap), then the handler always does `getChainId` + `curves()` `readContract` against
`CENSUS_RPC_URL` before the creator check rejects it. No rate limit → an attacker forces one RPC round
trip (and KV GET) per request, abusing the single RPC (track K) and function-invocation cost.
**PROOF** DERIVED. **BLAST RADIUS** RPC/function cost + contention on the one RPC endpoint. **FIX**
per-IP rate limit; optionally a cheap pre-check (KV existence) before the RPC. GET is fine (public,
10 s cache).

### CX-L3 — S3 (cost) — Upload quota is per-wallet with no global cap → sybil fill of Blob — **FIXED 2026-09-17**
**STATUS: FIXED.** `frontend/api/upload.ts` now enforces a global daily byte cap across all wallets (`UPLOAD_DAILY_BYTES` default 500 MB) via a KV `INCRBY` counter, on top of the per-wallet count quota, so a sybil with many free wallets can't slowly fill Blob. Tested in `api.upload.test.cjs` (a second upload that pushes the day's bytes over the cap → 429 "capacity"). Still recommend a Vercel spend alert as the ultimate backstop (G9). Original finding below.

**WHERE** `frontend/api/upload.ts:88-99`. **WHAT HAPPENS** Uploads are gated by signature + a per-wallet
daily KV quota (default 20 × ≤1.5 MB). Wallets are free, so an attacker with N wallets stores
~30·N MB/day; there is **no global cap and no spend alert**. **PROOF** DERIVED. **BLAST RADIUS** Slow,
unbounded Vercel Blob growth + bandwidth bill. **FIX** A global daily byte ceiling in KV; a Vercel spend
alert; consider gating uploads to wallets that have actually launched. (Overlaps track T.)

### CX-L4 — S4 — Upload validates MIME from the data-URL prefix, not the decoded bytes
**WHERE** `frontend/api/upload.ts:70-99`. Arbitrary bytes can be stored as `image/png` etc. SVG is
correctly excluded from the accepted set, and blobs are served cross-origin with an `image/*`
content-type, so this is not an XSS vector — defence-in-depth only. **FIX** Sniff magic bytes; reject
mismatches.

**What's GOOD here (verified):** writes are EIP-191 signature-bound to chain+token/wallet+contentHash+
timestamp with a 10-min TTL and rollback protection; metadata writes verify the signer equals the
on-chain `curves(token).creator` and reject unregistered/predicted addresses (kills description-squatting);
fail-closed to 503; provider errors are logged, never returned (no key/URL leak); the 0x proxy is a
narrow allowlist, not an open proxy.

---

## Track U — secrets & what ships to the browser — **CLEAN**

- PROVEN: built `dist/` and grepped for `ZEROX_API_KEY|BLOB_READ_WRITE_TOKEN|KV_REST_API_*|CENSUS_RPC_URL|PRIVATE_KEY|0x-api-key|-----BEGIN|app_secret|clientSecret` → **no matches**. No server (`api/`) code bundled into `dist/`.
- PROVEN: `.env` is gitignored at root + `frontend/` + `contracts/`; only `*.env.example` templates are tracked; their values are zero-address placeholders + commented public testnet contract addresses; no `.env`/key/pem ever added in git history.
- DERIVED: all client config is `VITE_*` (public by design); no secret is a `VITE_` var; the fee *split* is deliberately not surfaced (only `TRADE_FEE_BPS=200`).
- **CX-U1 — S3 (caution/gate):** `config.ts:5-6` defaults `VITE_CHAIN_ID`→4663 (**mainnet**) and `VITE_RPC_URL`→public mainnet RPC when unset. A build with a missing/empty chain-id silently targets mainnet. And if `VITE_RPC_URL` is ever set to a *keyed* RPC, that key ships in the bundle (currently keyless). **FIX** Fail the build if `VITE_CHAIN_ID` is unset; never put a keyed RPC in a `VITE_` var (proxy it like 0x).

---

## Track P — content / media / UGC — **no stored XSS**

- PROVEN: `grep dangerouslySetInnerHTML|innerHTML|__html` across `frontend/src` → **none**. React escapes all rendered `name`/`thesis`/`description`. The attacker-controlled `image` is only ever rendered as `<img src>` (`census.tsx:60`, `Coin.tsx:408,548`) with an `onError` fallback — `<img>` context neuters SVG/`javascript:` payloads, and upload rejects SVG. No `href={userValue}` / `window.open(userValue)` / CSS `url(${userValue})`.
- **CX-P1 — S3 (privacy):** the creator can set `image` to any off-domain URL (metadata API stores any ≤400-char string; only the *wizard* restricts to hosted URLs). Every visitor then loads it via `<img src>`, leaking their IP/UA to the creator's server, and the creator controls availability. **FIX** Server-side require the `image` host to be the Blob domain, or proxy/re-host it.
- **CX-P2 — S3 (trust) — FIXED 2026-09-17 (dedup + impersonation warnings + confusable stripping; report path still a product decision):** the launch wizard now strips zero-width/bidi/control characters from the name on input (`lib/names.ts stripConfusables`; ticker was already alphanumeric-only), and shows a non-blocking ⚠ warning when the name/ticker duplicates an existing Census coin or matches a real company (anchor menu + stock catalogue) — `coinNameWarning`, wired in `Launch.tsx CompanyStep`, tested in `lib.names.test.cjs` and verified live ("Robinhood"→impersonation, "Curve Test"→duplicate, novel name→none). **Still open (product/ops decision, not code):** a verified badge and a report/takedown path with a named recipient (ties to CX-X2/X5).

---

## Track N — front-end state machine & the trade flow — **robust**

Verified by reading `Coin.tsx:233-329` and live testing:
- PROVEN (live): a malformed address (`#/coin/0xdeadbeef`) shows a clean error ("That's not a coin address … ends in c0de"); no console errors on landing, board, or coin pages.
- DERIVED: `trade()` has a `busy` re-entry guard (`:234`), ordered validation (connected → canTrade → amount → balance → quote), `ensureChain()` before every trade, human-readable status at each await, `friendly(e)` maps user-rejection to "Cancelled in your wallet." (no hex dump), and `finally{ setBusy(false) }` so it can't hang on a spinner. **Success ("Bought ✓") renders only AFTER `waitForTransactionReceipt` — the UI does not fake success.** Button is `disabled={busy || !canTrade}`.
- **CX-A1 (from the A–G pass) — MITIGATED on the curve path, but see CX-H1 for the pool path:** `Coin.tsx:243` sets `minOut = quoteOut·(1−2%)` and passes it as the real `minTokensOut`/`minEthOut` to `buyWithETH`/`sellForETH` (`:258,278`). **Pre-graduation this is solid** — `quoteOut` comes from the deterministic on-chain curve quote (`quoteBuyFor`/`quoteSell`), so the floor is real and the zap's internal `amountOutMinimum:0` is covered. **Post-graduation it is weak** — `quoteOut` there comes from the *manipulable* Uniswap `slot0` spot (`poolSpotOut`), so "2% of a manipulable number" gives little protection on a thin company-coin pool (this is track H's **CX-H1**, an S1). Net: CX-A1 is contract-side defence-in-depth on the curve; the real execution-safety gap is CX-H1 on graduated/non-ETH pools.
- **CX-N1 — S3 — FIXED 2026-09-17:** a well-formed but **unregistered** address used to render a full "Unknown token" coin *shell* a phishing link could pass off as a real launch. `Coin.tsx` now renders an honest "Not a Census coin" page for a confirmed miss, and — crucially — a **separate** "Couldn't reach the chain" retry state for an RPC failure (I fixed `useCoinQuote` to set a distinct `error` flag instead of conflating an RPC throw with "not registered", which also closes part of CX-M4 for the coin page). Live-verified: registered coin → full page; `0x1111…1111` → "Not a Census coin"; `0xdead` → "That's not a coin address". The old 1%/2% fee-label mismatch was on the shell and is now moot.
- **CX-N2 — S4:** the curve buy(non-ETH)/sell paths always send an `approve` tx without checking existing allowance (`:265,275`), unlike the graduated path (`:299`). Wastes a signature+gas on repeat trades. **FIX** Read allowance first, approve only if short.
- **CX-N3 — S3 (see track K):** the UI resolves at 1 soft confirmation (`waitForTransactionReceipt`, default) — on this ~100 ms-block L2 with ~13-min hard finality, a "✓" trade can in principle be reordered/voided before batch posting. Normal for a launchpad, but worth a "pending finality" nuance for large trades.

---

## Track Q — copy & accessibility

- **CX-Q1 — S3 (a11y):** at 375 px the coin page has **11 interactive controls under the 44 px touch-target minimum** (PROVEN via JS: quick-amount chips, buy/sell toggle, icon buttons); board has 3. **FIX** Min 44×44 hit areas on chips/toggles/icon buttons.
- **CX-Q2 — S3 (jargon):** unexplained terms surface in the UI — "graduation", "anchor", "the curve", "reserve", custom-error names via `friendly()` (e.g. a revert could show "Slippage"/"CurveFilled"). **FIX** One-line tooltips; map known custom errors to plain English.
- GOOD: the fee split is never surfaced; "Fee (2%)" and the launch-window explainer are honest; empty states say "appears once the indexer is connected" rather than faking data.
- NOT VERIFIED: full keyboard-only nav, focus-visible, screen-reader labels on icon-only buttons, contrast ratios of muted text / lime accent (needs a contrast measurement pass).

---

## Track R — mobile & cross-browser

- PROVEN (375 px): **0 px horizontal overflow** on board and coin pages; no element wider than the viewport. Good responsive work.
- NOT VERIFIED: real iOS Safari / Android Chrome, in-app browsers (Twitter/Telegram/Discord) where wallet deep-links differ, landscape, keyboard-open reflow. (Needs real devices — see NOT-VERIFIED.)

---

## Track S — performance & bundle

- PROVEN (build): Privy is correctly a **lazy** chunk — `privy-CWkfOeow.js` ≈ **1.97 MB** loads only when `PRIVY_ENABLED`; a wallets-only user never downloads it. But the **eager** entry is heavy: `index-z4iilnIG.js` ≈ **680 KB** + `core-Dbg6inA6.js` ≈ **576 KB** + `index-DGCyke9F.js` ≈ **334 KB** (raw, pre-gzip). **CX-S1 — S3:** heavy first-load JS (~1.5 MB raw eager) → slow TTI on a mid-range phone / 3G. **FIX** Measure gzipped TTI; code-split the board/coin routes; audit what pulls `core` into the entry.
- **CX-S2 — S3 (see CX-K3):** Home scans factory logs **from block 0 on every load** (`useLaunches.ts`) with no indexer — O(chain history) RPC per visit; gets slower forever and hammers the single RPC. **FIX** Ship the indexer (`VITE_INDEXER_URL`) before any real traffic; until then, cache/paginate the scan.
- NOT VERIFIED: gzipped sizes, measured TTI, RPC-call count per load, re-render/interval-leak profiling.

---

## Track O — wallets / connect / auth — **well-engineered**

Read `census.tsx:205-317` (`WalletsAuthProvider`, `useWalletConnect`) and `privy.tsx` (read in full in the A–G pass).
- DERIVED: EIP-6963 discovery lists **one connector per installed extension**, deduped by provider object; with >1 wallet the user **picks** (`pickWallet`) instead of silently getting the `window.ethereum` race winner — this is exactly the fix for the "auto-connected to Trust Wallet" complaint. **No auto-connect.**
- Wallet opens FIRST, then best-effort `switchChainAsync` (decoupled, `:244-245`) so a network hiccup can't block the wallet window; `ensureChain()` runs before every tx with a **Phantom-specific** message (Phantom ships Robinhood Chain off by default and can't add networks, `:303-307`) — thoughtful.
- Clear text for reject / no-provider / mobile (deep-links to wallet apps, `:232-241`); per-call-site error attribution (`errorFrom`) so an error shows by the right button.
- Privy-mode `signOut` handles the "injected wallets can't be disconnected programmatically" problem via the wagmi `.disconnected` shim flag (verified earlier); the 15 s watchdog + modal-close settle prevent the "stuck on Connecting…" hang.
- **CX-O1 — S3 (NOT fully verifiable here):** mobile in-app browsers (Twitter/Telegram/Discord) and iOS Safari / Android Chrome wallet round-trips are not live-tested (no wallets/devices in this pass). Deep-link and popup behaviour differ there and that's where most launchpad traffic originates. Needs a real-device pass.
- **CX-O2 — S4:** `ensureChain`'s catch treats every `switchChain` failure as "declined"; a wallet that *could* add the chain but whose add fails (e.g. the single RPC is down, track K) shows the same message. Minor.

## NOT VERIFIED in this pass
Real-device mobile & in-app browsers; keyboard/AT accessibility & contrast; gzipped bundle + measured TTI; a live rate-limit/DoS test against the deployed endpoints (only reasoned); Privy/WalletConnect live flows (track O — needs wallets); the indexer live (not deployed).
