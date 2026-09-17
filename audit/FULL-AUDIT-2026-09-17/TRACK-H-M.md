# Census full audit — Track H (external integrations) & Track M (indexer & data truth)

Auditor stance: hostile, read-only. Everything in code/comments/docs treated as a claim.
Nothing was run on a fork or against the live chain in this pass — every price/oracle finding is
tagged DERIVED (traced through the code end to end) unless marked otherwise. No product source was
modified. Addresses below are masked to the first/last few hex chars where they are not already
public constants in the repo.

Evidence tags: PROVEN (ran/traced with output) · DERIVED (forced by the code) · SUSPECTED (reason, no proof).
Severity: S0 funds · S1 wrong economics/data-as-fact · S2 core journey broken · S3 trust erosion · S4 polish.

---

## Findings (ordered by severity, then likelihood)

### CX-H1 — Every post-graduation / non-ETH-anchor price, market cap AND the on-chain trade min-out come from a one-block-manipulable Uniswap spot read (no TWAP)
- **SEVERITY** S1 (data-as-fact) with an **S0-adjacent** edge on the trade min-out for thin pools · likelihood: display-wrongness *easy*, value-extraction *needs setup* (capital + a shallow pool)
- **WHERE** (one root cause — `slot0().sqrtPriceX96` spot — surfacing in seven sites):
  - `frontend/src/lib/pool.ts:34-40` — `poolSpotOut` reads `slot0()[0]` and returns a spot out; comment at `:27-29` admits "Price impact is ignored".
  - `frontend/src/lib/anchors.ts:82` — `poolUsdPrice` (anchor→USDG spot for HOOD and mainnet ETH).
  - `frontend/src/lib/anchors.ts:102-104` — `coinUsdPrice` graduated branch (`poolSpotOut` → `1/(out/1e18)`).
  - `frontend/src/lib/useCurveStats.ts:63` — graduated coin `priceUsd`/`mcapUsd` (via `cachedQuoteUsd`→`poolSpotOut`).
  - `frontend/src/pages/Coin.tsx:96-98` + `:82-84` — coin page `poolPrice`, `priceUsd`, `mcapUsd`; labelled **"Live from the pool"** at `:91`.
  - `frontend/src/pages/Coin.tsx:227` → `:246` → `:319` — quote-out from `poolSpotOut` becomes `minOut = quoteOut*(10000-200)/10000`, submitted as `exactInputSingle.amountOutMinimum`. **This is an on-chain decision derived from a spot read.**
  - `frontend/src/lib/anchors.ts:169-172` — `curveLaunchParams` sets `virtualQuote`/`graduationQuote` at launch from live `ethUsd`/`quoteUsd` spot (HOOD/company-coin anchors only; ETH is identity).
- **WHAT HAPPENS** For a graduated HOOD- or company-coin-anchored coin, 0x won't route it (`Coin.tsx:287` comment), so the trade always takes the pool path. The "you receive ~" figure and the submitted `amountOutMinimum` are both computed from `slot0` at quote time with a flat 2% tolerance (`SLIPPAGE_BPS=200`). An attacker who moves the pool one block before the read (or sandwiches the pending tx) sets the reference the victim's own min-out is measured against; a full-range locked position seeded by a small graduation (~4 ETH) is shallow enough that a few-hundred-dollar swap moves spot well past 2%. The same spot also feeds displayed price/mcap, which the UI presents as an exact "$" with the caption "Live from the pool".
- **PROOF** DERIVED. ABI confirms `slot0()` returns `sqrtPriceX96` first (`frontend/src/abis.ts:66`); `poolSpotOut` uses `slot0[0]` and ignores impact; `Coin.tsx:246` is literally `(quoteOut * BigInt(10000 - SLIPPAGE_BPS)) / 10000n` where `quoteOut` was assigned from `poolSpotOut` at `:227`. No `observe()`/TWAP call exists anywhere in `frontend/src/lib`.
- **BLAST RADIUS** Every graduated coin's price/mcap is manipulable for the 60 s cache window; every HOOD/company-coin graduated trade routes through the spot-derived min-out. On a thin pool the loss is bounded only by 2% *below a number the attacker chose* — i.e. effectively unbounded on the display and materially extractable on the trade.
- **WHY** Convenience: `slot0` is one call; TWAP needs `observe()` and a pool whose `observationCardinality` was grown at creation (V3 pools start at cardinality 1). The code chose spot and papered over it with a fixed 2% floor.
- **FIX** Price display from a short TWAP (`observe()`), and require cardinality growth at graduation; derive the trade `minOut` from an independent expected-out (TWAP or the user's explicit limit), not from the same spot; let the user set slippage. Trade-off: TWAP unavailable on brand-new pools (fall back to "—" / block trading until cardinality warms).
- **TEST** Fork test: graduate a coin, push `slot0` with a swap, assert (a) displayed USD moves and (b) a victim `exactInputSingle` with the client-computed `minOut` fills at the manipulated price. A unit test asserting `poolSpotOut` is never the sole source of an `amountOutMinimum`.

### CX-M1 — The indexer prices USD as a constant and a zero: ETH coins frozen at $3000, every non-ETH-anchored coin at $0 — and `fmtUsd(0)` renders that as **"new"**, `fmtPrice(0)` as **"$0.00"**
- **SEVERITY** S1 · likelihood: *needs setup* now (indexer not deployed), *certain* the moment `VITE_INDEXER_URL` is set and any numeric field is surfaced
- **WHERE**
  - `indexer/src/config.ts:18` — `ethUsd: Number(process.env.ETH_USD ?? 3000)` (static).
  - `indexer/src/ingest.ts:83-86` — `derive()`: `quoteUsd = lc(quote) === cfg.weth ? cfg.ethUsd : 0` → `priceUsd`, `marketCapUsd` = 0 for HOOD/company-coin anchors; comment at `:83` says "HOOD/other: needs its own feed (TODO)".
  - `indexer/src/ingest.ts:242-244` — `onPoolSwap` repeats the same `quoteUsd = weth ? ethUsd : 0`.
  - Served through `/coins`, `/coins/:address`, `/coins/:address/chart`, `/stats` (`indexer/src/api.ts:44-106`) as `priceUsd`/`marketCapUsd`/`volumeUsd`.
  - Render: `frontend/src/census.tsx:29` `fmtUsd(0) => "new"`; `:34` `fmtPrice(0) => "$" + (0).toPrecision(3)` = `"$0.00"`.
- **WHAT HAPPENS** Today the frontend recomputes price/mcap **live** (`useCurveStats`/`useCoinQuote`) and consumes the indexer **only** for the coin list (`useLaunches`→`indexerToCoin`, address/name/symbol/creator/age — `frontend/src/lib/useLaunches.ts:31-34`). So no wrong number reaches the UI yet. The instant the indexer is deployed and its numeric fields are wired (charts, `/stats`, or a future board that trusts served `marketCapUsd`), an established HOOD coin with real volume shows market cap **"new"** and price **"$0.00"**, and ETH coins freeze at a hand-set $3000. This is strictly worse than the on-chain path, which returns `null`→"—" when it can't price honestly.
- **PROOF** DERIVED. The literal `? cfg.ethUsd : 0` in `derive()`; the `fmtUsd`/`fmtPrice` branches; and the fact that no page reads `IndexerCoin.priceUsd`/`.marketCapUsd` (grep of `frontend/src/pages` shows only `s?.mcapUsd`/`s?.priceUsd` from `useCurveStats`, never the indexer struct).
- **BLAST RADIUS** Every HOOD- and company-coin-anchored coin (the flagship "stock-anchored" meta) reads as worthless/brand-new; every ETH coin's USD is off by the drift of a static $3000. A one-line env flip (`VITE_INDEXER_URL`) is all that stands between "honest —" and "confident wrong number".
- **WHY** USD conversion for non-ETH anchors was deferred (the TODO), but `0` was chosen as the placeholder instead of `null`, and `fmtUsd` maps `0`→"new".
- **FIX** Make the indexer read anchor USD the way the frontend already does (per-anchor USDG pool, company-coin recursion), or serve `null` (not `0`) for unpriceable anchors and keep ETH on a live feed, not `ETH_USD`. Never let a stale/absent feed present as an exact figure.
- **TEST** Indexer unit test: register a HOOD-anchored coin, assert served `priceUsd`/`marketCapUsd` are `null` (or live), never `0`. Frontend test: `fmtUsd(0)` must not be reachable from a real, traded coin.

### CX-M2 — Unbounded per-coin RPC fan-out on the live (indexer-off) path; and no offset/cursor pagination anywhere — the home page does not scale
- **SEVERITY** S2 at real volume · likelihood: *needs setup* (coin count)
- **WHERE**
  - `frontend/src/lib/useLaunches.ts:76,80` — `getContractEvents(...fromBlock: FROM_BLOCK)` for both factories with **no block-range chunking** (`FROM_BLOCK=0` unless `VITE_FROM_BLOCK` set; not set in `frontend/.env`).
  - `useLaunches.ts:86` one `getBlock` per unique block; `:90-100` `name`+`symbol` per coin, all in one `Promise.all` — no cap.
  - `frontend/src/pages/Home.tsx:14` — `useCurveStats(coins.map(c => c.address))` passes **all** coins.
  - `frontend/src/lib/useCurveStats.ts:39-80` — per coin: `curves()` + `quoteInfo` + `cachedQuoteUsd` + `totalSupply`, all concurrent, no cap.
  - Single RPC: `frontend/src/config.ts:5-6`.
  - Indexer API pagination: `indexer/src/api.ts:44-56` `/coins` takes `limit` (default 50, **max 200**) with **no `skip`/cursor** and orders by one sort key.
- **WHAT HAPPENS** With the indexer off (today's live config — `VITE_INDEXER_URL` unset), loading Home at 10,000 coins fires one full-range `eth_getLogs` (many RPCs reject the range outright), then ~2 reads/coin for names + 1 `getBlock`/block, then `useCurveStats` adds ~3-4 reads/coin — tens of thousands of concurrent calls at a single RPC endpoint → rate-limit, timeouts, blank/half board. With the indexer on, `useLaunches` caps at `fetchCoins("new",100)` but `Home` **still** calls `useCurveStats` live on those 100, and any coin outside the top-200 for a chosen sort is unreachable (no "load more"/cursor exists).
- **PROOF** DERIVED from the fan-out sites above; the API cap/absence-of-cursor is explicit in `limitOf(...,50,200)` and the single `take: limit` query with no `skip`.
- **BLAST RADIUS** The board — the product's front door — degrades from "slow" to "broken" as launches grow, exactly the moment a launchpad is succeeding. The indexer that would fix it is not deployed, and even deployed it can only surface the top 200 per sort.
- **WHY** The on-chain path was written for testnet/low volume ("Cheap at low coin counts" — `useCurveStats.ts:2`) and the indexer's API was never given pagination.
- **FIX** Chunk `eth_getLogs` by block range with backoff; batch coin reads via multicall; cap and paginate the board (indexer `?cursor=`/`?before=`); when the indexer is on, trust its list+numbers instead of re-reading every coin live.
- **TEST** Load a 5,000-coin fixture and assert bounded RPC call count and a working "next page"; an integration test that `getContractEvents` is issued in ranges, not one call from block 0.

### CX-H3 — Testnet vs mainnet Uniswap wiring contradicts itself across three files, and `config.ts` fallbacks aren't chain-gated (silent mainnet-address-on-testnet footgun)
- **SEVERITY** S3 (config/doc truth; testnet-only today; no funds at risk) · likelihood: *easy* for whoever next wires testnet graduation
- **WHERE**
  - `contracts/uniswap.robinhoodTestnet.json` — has concrete testnet Factory `0x1e57…D8E1`, NPM, Router `0x0F13…1D82`, WETH `0x823F…88eb`.
  - `contracts/scripts/addresses.js:30-36` — `robinhoodTestnet` all `""` with comment: *"Uniswap V3 addresses NOT yet confirmed here… until then, testnet launches can't run."* **Directly contradicts the JSON.**
  - `frontend/src/config.ts:34-35` — `weth` and `swapRouter` fall back to **mainnet** addresses with **no `IS_MAINNET` guard**; `:36-37` `v3Factory`/`ethPricePool` correctly gate to `zeroAddress` off-mainnet.
  - `frontend/.env` sets testnet `VITE_WETH`/`VITE_SWAP_ROUTER` explicitly (masks the bleed today) but **omits `VITE_V3_FACTORY`** → on the live testnet build `v3Factory = zeroAddress` → `poolFor` returns null (`pool.ts:12`) → graduated-pool pricing is dead on testnet even though a testnet factory exists and is documented in the JSON.
- **WHAT HAPPENS** Three sources disagree on whether testnet Uniswap exists and at what addresses. A teammate building a testnet bundle who follows `.env.example` (where `VITE_WETH`/`VITE_SWAP_ROUTER` are commented *optional*) silently gets **mainnet** WETH/router on testnet with no error (`addr()` just returns the fallback), while `v3Factory` is zero — a half-mainnet/half-testnet config that fails confusingly.
- **PROOF** DERIVED by direct comparison of the three files; mainnet addresses **are** internally consistent across `config.ts` / `uniswap.robinhood.json` / `addresses.js` (Factory `0x1f7d…2EfA`, Router `0xCaf6…5cb2`, WETH `0x0Bd7…AD73`, NPM `0x7399…E0D3` all match) — the contradiction is testnet-only.
- **BLAST RADIUS** Testnet graduation/pool pricing silently disabled; next deployer gets three answers; a mis-set testnet build points token/router logic at foreign contracts.
- **WHY** Testnet Uniswap was filled into the JSON after `addresses.js`'s "can't run yet" comment was written; nobody reconciled them, and `config.ts` gated the two mainnet-only reads but not WETH/router.
- **FIX** One source of truth per chain; chain-gate **all** Uniswap fallbacks (or drop fallbacks and fail loudly on a missing var); reconcile `addresses.js` with the testnet JSON.
- **TEST** A build-time assertion that every Uniswap address resolves to a contract on the configured chain id, failing the build otherwise.

### CX-H2 — Company-coin anchor pricing: depth-capped but with no cycle set, and the USD cache keys on address-without-depth, so a priceable coin can be cached as "—" by load order; A↔B anchors both go unpriceable
- **SEVERITY** S3 · likelihood: *easy* to observe, benign failure mode
- **WHERE** `frontend/src/lib/anchors.ts:92-111` (`coinUsdPrice`, guard `depth > 3` at `:93`, recursion via `quoteUsdDepth` at `:97`); `:118-127` (`quoteUsdDepth`, cache key `quote.toLowerCase()` **without depth**, 60 s TTL at `:122`).
- **WHAT HAPPENS** (1) There is **no infinite recursion / gas / stack blowup** — the depth cap terminates at 4 coin levels and returns `null` (good; state it). There is **no visited/cycle set**, but the depth cap makes an A↔B mutual anchor terminate → both resolve to `null` → both show "—" for the cache window. (2) The USD cache stores the *promise computed at whatever depth the address was first requested*. A coin first evaluated deep in some other coin's chain (throws "unpriceable anchor") is cached `null` and then shows "—" even though it is directly priceable at depth 0 — a flickery, load-order-dependent price truth. (3) A drained/empty anchor pool → `poolSpotOut` returns `null` → `coinUsdPrice` throws → `.catch(()=>null)` → "—" (no NaN/Infinity reaches the display; `curveSpot` also guards `tokenReserve+offset <= 0n` at `curveOffset.ts:29`, and `poolUsdPrice` throws on non-finite at `anchors.ts:86`). So the collapse case is **safe** (shows "—"), which is the intended honest behavior.
- **PROOF** DERIVED. Trace: `coinUsdPrice(…,0)` → `quoteUsdDepth(…,1)` → `coinUsdPrice(…,1)` → … → `coinUsdPrice(…,4)` hits `depth > 3` and throws; cache `priceCache.set(key,…)` uses only `quote.toLowerCase()`.
- **BLAST RADIUS** A legitimately priceable company coin intermittently shows "—" instead of its dollar value; deep or mutually-referencing chains are silently unpriceable. Trust erosion, not loss.
- **WHY** Cache was added for board performance without keying on the recursion depth, and cycles are handled implicitly by the depth cap rather than a visited set.
- **FIX** Key the cache on `(address, depth)` or cache only successful results; add an explicit visited set so a cycle returns a clear "circular anchor" state; keep the depth cap.
- **TEST** Unit test: price coin X standalone (depth 0) and inside a 4-deep chain; assert the standalone value is not poisoned by the deep evaluation. Test A↔B returns a defined "circular" state, not a stuck null.

### CX-M3 — When deployed, the indexer reconstructs curve reserves from events and freezes `virtualTokenOffset`, risking price drift; reorg recovery is manual-halt and rests on the L2 `finalized` tag being truly final (also imposes a head-lag)
- **SEVERITY** S3 · likelihood: SUSPECTED (indexer not deployed; cannot be PROVEN here)
- **WHERE**
  - `indexer/src/ingest.ts:157-167` — `onTraded` mutates `virtualQuote`/`tokenReserve`/`realQuote` from event `amountIn`/`amountOut`/`fee` rather than re-reading `curves()`.
  - `:118` — `virtualTokenOffset` written once at `Registered`, **never updated**, while `derive()` at `:79` uses `tokenReserve + virtualTokenOffset`.
  - `:300-301`, `:425` — reorg at the checkpoint → throw "rebuild required" (manual). `:420` — indexes only `blockTag: "finalized"`.
- **WHAT HAPPENS** If the PF curve's unminted offset changes as real tokens leave (needs `CensusCurve.sol` to confirm — see NOT VERIFIED), the indexer's `priceQuote` drifts from the live curve because it holds the offset constant while mutating `tokenReserve` every trade → the board (indexer) and the coin page's execution quote (`useCoinQuote`, live `curves()`) can disagree, i.e. the UI shows one price and trades at another. Reorg handling is detect-and-stop: any reorg at/after the checkpoint halts ingestion until a human rebuilds. Because only `finalized` blocks are indexed, the served data lags chain head by the finality delay; the live on-chain fallback reads `latest`, so the two data sources have different recency.
- **PROOF** SUSPECTED for the drift (depends on the contract's offset semantics); DERIVED for the manual-halt reorg policy and the head-lag. **Verified-good and worth stating:** duplicate events are deduped by unique `(chainId,txHash,logIndex)` with `skipDuplicates` (`:365`) plus a trade-level existence check (`:149`); gaps are impossible (strict `cursor.lastBlock+1 === from`, `:359`); checkpoint identity + canonical hash are re-checked before building and inside the transaction (`:300`,`:346`,`:364`); RPC range limits are absorbed by adaptive page halving (`:392-398`); cold restart resumes from the durable cursor (`:286-288`); all network I/O happens before the serializable transaction opens (`:45-56`,`:295-348`).
- **BLAST RADIUS** Board price/mcap subtly wrong vs the trade venue once the indexer is authoritative; ingestion can stall on a reorg and needs a human; "live" board is stale by the finality window.
- **WHY** Deliberate simplicity — reconstruct-from-events avoids per-trade `curves()` reads; halt-on-reorg avoids rollback complexity; finalized-only avoids indexing soft blocks. All defensible, all untested against this chain's real finality.
- **FIX** Periodically reconcile a coin's reconstructed reserves against a live `curves()` read (and re-read `virtualTokenOffset`); implement bounded automatic rollback on a shallow reorg; document the head-lag as an explicit staleness SLA in the UI.
- **TEST** Replay a trade sequence and assert reconstructed `priceQuote` equals a live `curves()`-derived price within tolerance; inject a 1-block reorg and assert the indexer rolls back rather than halting.

### CX-H4 — Stock/HOOD/ETH logos hotlink unlicensed third parties with no key; ticker-based lookup is a latent impersonation lever; 404 handling is correct
- **SEVERITY** S3 (dependency/licence) + S4 (404 handled well) · likelihood: *easy* (any FMP block/rate-limit)
- **WHERE** `frontend/src/components/StockLogo.tsx:38` and `frontend/src/census.tsx:19-21` (`assetLogoSrc` → `https://financialmodelingprep.com/image-stock/${ticker}.png` for any non-ETH ticker); `frontend/src/lib/anchors.ts:50` (HOOD → FMP); ETH → `raw.githubusercontent.com/trustwallet/...` (`census.tsx:18`, `anchors.ts:42`).
- **WHAT HAPPENS** Logos are hotlinked from financialmodelingprep.com (a paid data provider) with **no API key and no documented licence/attribution in the repo**; FMP can rate-limit or block by referer/IP at any time, at which point every stock/HOOD logo falls back to a coloured initials badge (`AssetLogo`/`CxAvatar` `onError` → lettermark — graceful, `StockLogo.tsx:31`, `census.tsx:60,71`). Stock **prices** are NOT from FMP — they are on-chain, pool-derived (`stockRoutes.ts` + `pool.ts`); FMP supplies **logos only**. `assetLogoSrc(symbol)` returns a real company's logo for **any** symbol matching a real ticker, so a coin/anchor named "NVDA" would borrow NVIDIA's mark — an impersonation lever (company-coin anchors currently pass `logo:""` and render lettermarks, `anchors.ts:63`, limiting it today; defer the phishing angle to Track P).
- **PROOF** DERIVED from the URL construction and the `onError` fallbacks.
- **BLAST RADIUS** All third-party logos can vanish to lettermarks on an FMP policy change (cosmetic); a licence/ToS exposure exists for a production, monetised product; latent brand-impersonation via ticker collision.
- **WHY** Convenience CDN; no self-hosted logo pipeline.
- **FIX** Self-host a vetted logo set (or licence FMP properly) and pin it; never derive a logo purely from a user-controlled symbol without a trust check.
- **TEST** A test that a coin whose symbol equals a real ticker does not render that company's logo unless it is a verified anchor.

### CX-H5 — 0x failure modes are handled, but swaps carry no client deadline and the pool fallback inherits the CX-H1 spot-derived min-out
- **SEVERITY** S3 · likelihood: *easy*
- **WHERE** `frontend/src/pages/Coin.tsx:224-236` (price effect: `zeroExPrice` in try/catch → falls to `poolSpotOut`), `:313-316` (`zeroExQuote(...).catch(()=>undefined)` + `liquidityAvailable !== false` gate → falls to pool), `:319` (`exactInputSingle` args have **no deadline** — SwapRouter02 struct); `frontend/src/lib/zeroex.ts:21-34` (proxy call, error thrown on non-OK).
- **WHAT HAPPENS** 0x down / rate-limited / empty-liquidity route all degrade to the pool path cleanly (good). But: the pool fallback's `amountOutMinimum` is the spot-derived `minOut` (CX-H1); and neither the 0x calldata submission nor the SwapRouter02 call includes a client-set deadline, so a delayed/stuck swap can execute at a much later block protected only by that spot-derived floor (0x's server-side `minBuyAmount` still bounds the 0x path; the pure-pool path has only `minOut`). 0x quote staleness/replay is bounded by 0x's own quote expiry, which was **not** verified (server-side, `api/zeroex.ts` out of this track).
- **PROOF** DERIVED. The `exactInputSingle` argument tuple at `:319` has no deadline field; the 0x calls are wrapped and fall through.
- **BLAST RADIUS** A trade that sits in the mempool through a volatile move can fill late; combined with CX-H1 the protection is weak on thin pools.
- **WHY** SwapRouter02 dropped the deadline param and the app never added its own.
- **FIX** Add a client deadline (wrap in a `multicall`/router that enforces one, or use a router variant with a deadline); base `minOut` on an independent quote (see CX-H1).
- **TEST** Submit a pool swap, mine it N blocks later after a price move, assert it reverts rather than filling at a stale min-out.

### CX-M4 — Mixed locale/format conventions on one screen; RPC-error empty state is indistinguishable from a genuinely empty chain
- **SEVERITY** S4 (locale) + S3 (error masquerading as empty) · likelihood: *easy*
- **WHERE** `frontend/src/census.tsx:28-36` — `fmtUsd`/`fmtPrice`/`fmtPct` hardcode `$` and `.` (en-US) via `toFixed`/`toPrecision`, while `fmtAmount` uses `toLocaleString(undefined,…)` (browser locale). `frontend/src/lib/useLaunches.ts:22-29` `ago()` (relative ages only); `:102-104` RPC error → `setLoading(false)` with empty coins; `frontend/src/pages/Home.tsx:78` shows the same `EmptyPanel` ("Nothing counted yet").
- **WHAT HAPPENS** A German-locale user sees amounts as "1.234,5" next to prices as "$1,234.50" — inconsistent separators in one row. No absolute timestamps are rendered today (only relative ages), so timezone is a non-issue **now**, but the indexer serves ISO `ts` and the moment the trade tape/chart land they must be localized. On an RPC hiccup the board shows "Nothing counted yet", identical to a real empty chain — the comment at `useLaunches.ts:103` claims "honest empty state, never placeholder coins" but it cannot distinguish an outage from emptiness.
- **PROOF** DERIVED from the formatter definitions and the error branch.
- **BLAST RADIUS** Minor mis-rendering for non-English users; a transient RPC failure reads as "this launchpad has no coins".
- **WHY** Formatters were written for en-US; the empty and error states were collapsed into one panel.
- **FIX** Route all currency/number rendering through one `Intl.NumberFormat`; localize timestamps when they ship; give the RPC-error case its own "couldn't reach the chain — retry" state distinct from empty.
- **TEST** Snapshot `fmtUsd`/`fmtAmount` under `de-DE`; a Home test that a rejected RPC shows a retry state, not EmptyPanel.

---

## Track M Q1 — every user-facing number, and its source of truth (today, indexer OFF)

| Number (where) | Source | Tag |
| --- | --- | --- |
| Coin price / mcap, pre-graduation (`Coin.tsx:79-84`, `useCurveStats.ts:51-58`) | live `curves()` reserves via `curveSpot` × anchor USD | on-chain live (anchor USD is spot — CX-H1) |
| Coin price / mcap, post-graduation (`Coin.tsx:96-98`, `useCurveStats.ts:63`) | pool `slot0` spot × supply | on-chain live but **spot-manipulable** (CX-H1) |
| ETH USD (all `$` on ETH coins, testnet) (`anchors.ts:20,71`) | `ETH_USD_FALLBACK = 3000` | **placeholder** shown as `$` (marked "≈" only in the Launch estimate) |
| ETH USD (mainnet) (`config.ts:37`, `anchors.ts:82`) | WETH/USDG pool `slot0` spot | on-chain live, spot |
| Graduation % (`Coin.tsx:76`, `useCurveStats.ts:72`) | live `graduationProgress()` / `realQuote·10000/graduationQuote` | on-chain live |
| Reserve raised / target (`Coin.tsx:107-108`) | live `curves().realQuote`/`graduationQuote` | on-chain live |
| Buy fee % during launch window (`Coin.tsx:174`) | live `buyFeeBps(coin,buyer)` | on-chain live (honest) |
| Trade fee "2%" label (`config.ts:53`, `Coin.tsx:564,570,595,607`) | hardcoded `TRADE_FEE_BPS = 200` mirror | **hardcoded**, not read from chain; and §1 says the fee **rate is not signed off for UI** — it is surfaced |
| Holders' share "% of creator rewards" (`Coin.tsx:608`) | live `curves().holdersBps` | on-chain live |
| "≈ $X mcap at graduation" (`Launch.tsx:699`) | `graduationFdvEth(t.eth) × ethUsd` | estimate (marked "≈"; $3000 placeholder on testnet) |
| Coin age "2h" (`useLaunches.ts:22`) | block timestamp, relative | on-chain live (client-clock dependent) |
| change24h, holders, holder distribution, price history/chart, fees earned, holdings, thread, replies, trade tape (`census.tsx:24 PENDING`) | none yet | **placeholder — labelled "once the indexer is connected"** |
| Basket weights % (`Launch.tsx:112-124`) | user input, largest-remainder to exactly 100 | user input (honest) |

Pending slots (Track M Q1 "are they honest?"): **yes.** `isPending`/`PENDING` drives the UI so pending fields can't be faked (`census.tsx:23-25`), and each renders a labelled `PendingPanel` ("Price history appears once the indexer is connected", note "Price and market cap above are live." — `Coin.tsx:443`; "Distribution appears once the indexer is connected." — `:475`; "Replies appear once the indexer is connected" — `Home.tsx:82`). The only nit: **"indexer" is unexplained jargon** a first-timer may read as "unfinished" (S4; defer to Track Q).

---

## NOT VERIFIED (and how to close it)

1. **Uniswap 1% fee tier existence + tick spacing on Robinhood Chain mainnet (4663).** `DEFAULT_FEE = 10000` (`config.ts:40`) is assumed enabled; `addresses.js` claims the factory was verified but says nothing about which tiers are *enabled*. No fork/RPC run here. Close: on a fork, `factory.feeAmountTickSpacing(10000)` ≠ 0 and `getPool(WETH, coin, 10000)` behaves. (Overlaps Track B.)
2. **`finalized` block-tag semantics on this Orbit L2** — whether it can reorg and how far it lags head. Determines CX-M3 severity and the indexed-board staleness. Close: query the chain/sequencer docs and observe `finalized` vs `latest` lag over an hour.
3. **Whether `CensusCurve.virtualTokenOffset` is constant post-registration.** Determines whether CX-M3's price-drift is real. Close: read `CensusCurve.sol` (out of this track's file list) and check if the offset mutates on buy/sell.
4. **Live 0x proxy behavior** (`frontend/api/zeroex.ts`) — quote expiry/replay window, key handling, whether it is an open proxy. Track L; not opened here. No network calls were made.
5. **FMP / trustwallet actual HTTP responses, rate limits and ToS.** No outbound requests issued. Close: hit the logo URLs from a build and read FMP's terms.
6. **Real graduated-pool depth on mainnet** — cannot quantify the CX-H1 min-out loss in dollars without a live/forked pool. Close: fork a graduated coin and measure slippage of a $500 swap vs the 2% floor.
7. **Runtime UI states** — this was static analysis; the dev server/browser was not driven, so element-level loading/empty/error transitions were reasoned from JSX, not observed.
