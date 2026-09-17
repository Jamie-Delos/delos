# TRACK K — Chain-level risk (Robinhood Chain)

Auditor stance: hostile. Code/comments/docs are claims; verified against source and public chain
facts. No source edited. Secrets named, never printed. Web content treated as untrusted data.

Repo root: `C:\Users\johnk\Documents\AJM Pad`. Curve mainnet chainId 4663, testnet 46630.

---

## Ordered finding list (one line each)

1. **CX-K1** — S3 (needs setup, rare): UI reports a trade/launch as succeeded after **1 soft block**; a sequencer failover/reorg or the chain's compliance filter can void it → the UI lies.
2. **CX-K2** — S2 (certain over time): **single RPC, zero fallback** anywhere (app, indexer, keeper); one endpoint down = connect/buy/sell/launch all dead, no plan.
3. **CX-K3** — S3 (certain): RPC URL is a **client-bundled `VITE_` var** with no rate-limit handling, and Home re-scans factory logs **from block 0** every load — a keyed mainnet RPC would ship its key and get hammered.
4. **CX-K4** — S3 (easy): UI reads `latest` (a coin can **appear then vanish** on an L2 reorg); the indexer ingests **`finalized` only** → correct but **~13-min lag**, and the two disagree.
5. **CX-K5** — S3 (easy; real precedent 4 Sep 2026): sequencer downtime halts all trading; funds safe (ops are atomic) but keeper stalls above the 50-gwei fee cap and there is **no status page and no non-frontend sell path**.
6. **CX-K6** — VERIFIED SAFE (DERIVED): no contract loop scales with holders or launches; `DividendVault.eligibleSupply` is bounded at ≤5 iterations. The prompt's gas-limit hypothesis is disproven — recorded so it is not re-opened.

---

## Chain facts (block time / finality / sequencer / reorg / gas / RPC)

| Fact | Value | Source |
| --- | --- | --- |
| Type | Arbitrum **Orbit** L2, settles to Ethereum via **blobs** | [thirdweb](https://blog.thirdweb.com/robinhood-launches-its-own-l2-blockchain-on-arbitrum-3/), [L2BEAT](https://l2beat.com/layer2s/projects/robinhood) |
| Mainnet / testnet | **4663** (live ~1 Jul 2026) / **46630** | [docs.robinhood.com/chain](https://docs.robinhood.com/chain/) |
| Block time | **~100 ms** soft blocks | [QuickNode](https://www.quicknode.com/guides/robinhood/what-is-robinhood-chain) |
| Finality | two-stage: **soft** (instant, sequencer-ordered) → **hard** when the batch posts to L1 and L1 finalizes, **~13 min**; no L2 reorg once on Ethereum unless Ethereum reorgs | [docs.robinhood.com/chain/transaction-finality](https://docs.robinhood.com/chain/transaction-finality/) |
| Reorg / voiding | L2 reorg **possible before the batch posts**; a soft-confirmed tx (carries a blockHash but no outcome guarantee) can be **reverted, reordered on sequencer failover, or voided by a compliance filter** | [transaction-finality](https://docs.robinhood.com/chain/transaction-finality/), [sequencer-feed decoder](https://github.com/chainstacklabs/robinhood-chain-sequencer-feed) |
| Sequencer | **single, centralized, run by Robinhood**; first-come-first-served | [Eco support](https://eco.com/support/en/articles/15859739-what-is-robinhood-chain-inside-robinhood-s-arbitrum-l2), [dwellir](https://www.dwellir.com/blog/what-is-robinhood-chain) |
| Downtime precedent | **block-production outage on 4 Sep 2026** (≈2 weeks before this audit) | [Gate News](https://www.gate.com/news/detail/ROBINHOODETH/robinhood-chain-suffers-brief-block-production-outage-on-september-4-24014248) |
| Gas token | **ETH**, no native token; gas = L2 exec + L1 blob cost | [Eco support](https://eco.com/support/en/articles/15859739-what-is-robinhood-chain-inside-robinhood-s-arbitrum-l2) |
| RPC in use | `https://rpc.mainnet.chain.robinhood.com` / `https://rpc.testnet.chain.robinhood.com` — public, single endpoint, keyless by default (`frontend/src/config.ts:6`, `contracts/hardhat.config.js:28,33`, `indexer/src/config.ts:7`, `bot/src/keeperd.js:87`) | repo |

Consequences that drive the findings: **soft ≠ final** (a receipt is not proof), the reorg window
is real but short and one-sided (only before the batch lands), and the **single sequencer is a live
single point of failure that has already failed once**.

---

## CX-K1 — Success rendered on 1 soft confirmation; a reorg/void makes the UI lie
- **SEVERITY** S3 · likelihood: needs setup (only during a failover/reorg/compliance-void)
- **WHERE** `frontend/src/pages/Coin.tsx:260,266,270,276,280,292,303,308,315,321,354`; `frontend/src/pages/Launch.tsx:288,293` — all `await publicClient.waitForTransactionReceipt({ hash })` with **no `confirmations` argument** (viem default = **1**).
- **WHAT HAPPENS**
  1. User buys / sells / launches; the sequencer soft-confirms in ~100 ms and returns a receipt.
  2. viem resolves at 1 confirmation; the UI advances to its success state, updates balances, navigates.
  3. Before the batch posts to L1 (the finality docs' explicit window), the sequencer fails over and **reorders or drops** the tx, or the **compliance filter voids** it.
  4. The trade/launch never happened, but the user already saw "done".
- **PROOF** DERIVED. Code shows `confirmations` is unset → viem default 1 (soft block). Chain docs state a soft-confirmed tx "can still revert, be voided by the compliance filter, or be reordered entirely if the sequencer fails over before the batch lands" ([transaction-finality](https://docs.robinhood.com/chain/transaction-finality/)). Not reproduced on-chain (no controlled failover available — see NOT VERIFIED).
- **BLAST RADIUS** Any user during a failover: believes they bought/launched when they did not; a creator's "launched" coin can disappear. Trust damage, support load. No direct fund loss (state simply reverts).
- **WHY** viem's 1-confirmation default is fine on a single-proposer chain but wrong where soft ≠ final and an external compliance layer can void.
- **FIX** For value-moving actions, treat 1 confirmation as *pending* and only show *final* after N confirmations (or a `finalized`-tag re-check), with an explicit "settling" state. Trade-off: adds perceived latency (seconds), so keep it a two-stage UI, not a 13-min block.
- **TEST** viem test against a local node that reorgs a mined block; assert the UI moves success→reverted and never leaves a false "done".

## CX-K2 — Single RPC, no fallback: one endpoint down = whole product down
- **SEVERITY** S2 · likelihood: certain over time (public RPCs have outages)
- **WHERE** `frontend/src/wagmi.ts:18` (`http()` — bare, no fallback); `frontend/src/privy.tsx:14` (`http()`); `frontend/src/config.ts:19` (`rpcUrls.default.http: [RPC_URL]`, one URL); `indexer/src/ingest.ts:15` (`http(cfg.rpcUrl)`); `bot/src/keeperd.js:504` (`new ethers.JsonRpcProvider(cfg.rpcUrl)`).
- **WHAT HAPPENS** No `fallback([...])` transport exists anywhere. When the one RPC is down, rate-limited, or slow: reads throw after viem's 3 retries → `useLaunches`/`useCurveStats` land in loading/empty states (`useLaunches.ts:102-104`), and every write (`buy`/`sell`/`launch`/`claim`) fails. Connect itself needs the chain reachable. The indexer and keeper likewise stall on their single provider.
- **PROOF** PROVEN by grep: the only RPC references are the single-URL sites above; `fallback(` / `webSocket(` appear nowhere in `frontend/src`.
- **BLAST RADIUS** Every user, every journey, for the duration of any RPC incident. This is the definition of an S2 (core journey broken on a live platform) — it just waits on an external trigger.
- **WHY** One public endpoint was wired for testnet convenience and never hardened.
- **FIX** `fallback([http(primary), http(secondary), http(tertiary)])` in `wagmi.ts`, `privy.tsx`, indexer and keeper; provision ≥2 independent RPCs (self-hosted + a vendor) before mainnet. This is a mainnet GATE.
- **TEST** Point the primary at a black-hole URL in a fork/e2e; assert reads and a buy still succeed via the secondary.

## CX-K3 — RPC URL ships in the client bundle; no rate-limit budget; Home scans from block 0
- **SEVERITY** S3 · likelihood: certain
- **WHERE** `frontend/src/config.ts:6` (`VITE_RPC_URL`); `frontend/src/vite-env.d.ts:5`; `frontend/src/lib/useLaunches.ts:21,76,80` (`fromBlock: FROM_BLOCK`, default **0**, no `toBlock`); `useCurveStats.ts` (per-coin `curves()` + `totalSupply` reads, fanning out per coin).
- **WHAT HAPPENS** `VITE_RPC_URL` is inlined into the browser bundle at build (all `VITE_` vars are). Today's default is a **keyless public endpoint** — no secret leaks. But the config's own comments invite setting it per environment; if mainnet points it at a keyed provider (Alchemy/QuickNode/etc.), **that key ships to every browser** and can be lifted and abused. Independently, each Home load calls `getContractEvents` from block 0 to `latest` on both factories, then per-coin metadata/stat reads — RPC calls scale with chain age and coin count, multiplying load on the single endpoint (ties into CX-K2).
- **PROOF** DERIVED from config + Vite semantics; the `.env.example` default (`frontend/.env.example:21`) is the public keyless URL, so no key is exposed *today* (SUSPECTED for a keyed mainnet URL — depends on the deploy value, which I could not see). Log-scan-from-0 is PROVEN in `useLaunches.ts`.
- **BLAST RADIUS** If a keyed RPC is used: quota theft / bill blow-up / rate-limit exhaustion for all users. Even keyless: self-inflicted rate-limit denial as coin count grows.
- **WHY** `VITE_`-prefixed config is browser-visible by design; no one set `FROM_BLOCK` or a paginated read for scale.
- **FIX** Never put a keyed RPC in a `VITE_` var — proxy provider calls through a serverless route (as 0x already is) or use a public/keyless RPC only. Set `VITE_FROM_BLOCK` to the curve deploy block and prefer the indexer for the board.
- **TEST** Build the mainnet bundle and grep for the RPC host + any api-key pattern (this is the track-U step I did not run — see NOT VERIFIED); assert no key present.

## CX-K4 — UI reads `latest`; indexer reads `finalized` only → appear/vanish + ~13-min divergence
- **SEVERITY** S3 · likelihood: easy (any L2 reorg)
- **WHERE** UI: `useLaunches.ts:76,80` and `useCurveStats.ts:43` read at the default (`latest`) tag with a 30 s cache (`useLaunches.ts:39`). Indexer: `indexer/src/ingest.ts:420` reads `client.getBlock({ blockTag: "finalized" })` and only scans up to it; reorg guards at `ingest.ts:297-302,330-336,345-346,364,425`.
- **WHAT HAPPENS**
  - *Frontend during a reorg:* a coin/trade from a soft block shows immediately; if that block is reorged before batching, the next read (≤30 s) **omits it — it vanishes**. It cannot **double** (a single `getContractEvents` returns canonical logs, and lists key by address/event). So: appear-then-vanish, self-healing.
  - *Indexer:* handles reorgs correctly by construction — it trusts **only finalized** blocks, re-checks the cursor's `lastHash` and every event's `blockHash` against canonical each loop, and on a finalized-level reorg **throws and halts** (`"Reorg at indexed checkpoint; stop and rebuild"`) rather than corrupting data. Cost: it lags the head by **~13 min**, so once deployed the board (indexer) and a coin page mid-trade (still partly live) can disagree by that much. Halt-on-reorg also means a rare L1-induced reorg needs a **manual rebuild** (no auto-rewind).
- **PROOF** PROVEN by code read; finality/reorg semantics per [transaction-finality](https://docs.robinhood.com/chain/transaction-finality/). `finalized`-tag lag on Nitro/Orbit follows L1 batch finality (~13 min) — DERIVED.
- **BLAST RADIUS** Confusing UX (a launch that briefly shows then disappears; board numbers trailing the coin page). No fund loss. Indexer halt = stale data until an operator rebuilds.
- **WHY** Two subsystems chose different safety points (UI favours freshness, indexer favours correctness) with no shared "pending vs final" concept.
- **FIX** Give the UI a small confirmation buffer or a "pending" badge for very recent blocks; add an auto-rewind path to the indexer for the rare finalized reorg instead of a hard halt; document the ~13-min indexer lag so it is not read as "broken".
- **TEST** Reorg a fork after the UI has listed a coin; assert graceful vanish. Feed the indexer a reorged finalized checkpoint; assert it halts without writing bad rows and that a documented rebuild recovers.

## CX-K5 — Sequencer downtime: funds safe, but trading halts, keeper stalls, no status/exit
- **SEVERITY** S3 · likelihood: easy (single sequencer; outage already occurred 4 Sep 2026)
- **WHERE** Ops are atomic: `CensusCurve.buy/sell` and `graduate` (`CensusCurve.sol:457-462`, `nonReentrant`, sets `graduated=true` then mints in one tx). Keeper fee logic: `bot/src/keeperd.js:108-111,241-251,267` (`MIN_SIGNER_WEI` 0.05 ETH, `MAX_FEE_GWEI` 50, replace-at-same-nonce). No status page or non-frontend sell path exists in the repo.
- **WHAT HAPPENS** During an outage no tx mines: a pending trade sits unconfirmed; a coin that has reached `graduationQuote` simply is not graduated yet (no half-state — `graduate()` is one atomic tx, so it cannot be caught mid-migration); the keeper holds one tx in flight and resumes cleanly (durable state file, nonce resolution). **Funds are safe.** But: (a) all trading is frozen with no in-app signal; (b) after an outage, if L1 blob fees spike above **50 gwei**, keeper fee-bump replacements are capped and **distributions stall** (alerts fire, no loss); (c) there is **no documented way for a user to sell without the front end** if the site or RPC is also down (cross-ref track T).
- **PROOF** DERIVED (atomicity + keeper caps from code) + PROVEN outage precedent ([Gate News](https://www.gate.com/news/detail/ROBINHOODETH/robinhood-chain-suffers-brief-block-production-outage-on-september-4-24014248)).
- **BLAST RADIUS** No fund loss. Reputational: "the app is frozen and no one is told." Delayed rewards. A holder wanting to exit during a combined site/RPC outage has no self-serve path.
- **WHY** Product assumes an always-on sequencer; no degraded-mode UX; keeper fee cap tuned for calm gas.
- **FIX** Detect stalled head (no new block in N s) and show a chain-status banner; make `MAX_FEE_GWEI` an alertable, raisable knob; publish the contract addresses + a minimal "sell directly on the curve via a block explorer / Etherscan-style write" guide so users can always exit. Incident runbook is a mainnet GATE (track W).
- **TEST** Fork with block production paused; assert no half-graduated coin, keeper resumes without nonce reuse, and (once built) the UI shows a downtime banner.

## CX-K6 — VERIFIED SAFE: no gas loop scales with holders or launches
- **SEVERITY** none (recorded to close the prompt's hypothesis)
- **WHERE** `DividendVault.sol:199-202` (`eligibleSupply` loops `excludedList`); construction at `LaunchFactoryV2.sol:92-95` (`ex = [curve, factory(this), DEAD]`), `DividendVault.init` (`:150-157`, prepends `address(this)`), `excludeAddress` (`:186-192`, census-only, adds the graduated pool once). Other loops: `_settle` over `basket` (`:227`, ≤4), constructor `weights` (`:116-118`, ≤4), `CensusCurve.sol:290-292` `exemptBuyers` (**≤32, enforced**), `LaunchToken.sol:85` `exempt` (launch-time array).
- **WHAT HAPPENS / PROOF** DERIVED, arithmetic: `excludedList` = {curve, factory, DEAD, vault} = 4 at init, +1 graduated pool = **≤5**, fixed. No public/attacker path appends (init is factory-only, excludeAddress is census-only-once). So `eligibleSupply` is **O(5)**, independent of holder count or number of launches. Every other loop is bounded by basket (≤4) or the enforced 32-cap. **No loop trends toward the block gas limit with scale.** The prompt's "eligibleSupply loop / excludedList" gas-exhaustion hypothesis is **disproven**.
- **NOTE (not K)** Every v2 token transfer pays a fixed `_settle` overhead (≤4 basket items) — a constant transfer-cost tax, not a scaling risk; belongs to track F.

---

## NOT VERIFIED (what someone must still do)
- **Live reorg / failover repro** — I have no way to force a Robinhood-Chain sequencer failover or a reorg on demand, so CX-K1/K4 are DERIVED from code + chain docs, not PROVEN on-chain. Close by: replaying the sequencer feed ([decoder](https://github.com/chainstacklabs/robinhood-chain-sequencer-feed)) or a local Nitro devnet with forced reorg.
- **Mainnet bundle secret grep** — I did not build `frontend` and grep the artifact (that is track U). CX-K3's key-leak arm stays SUSPECTED until someone builds the *mainnet* bundle and confirms `VITE_RPC_URL`'s value carries no key.
- **Actual `finalized`-tag lag on 4663** — the ~13-min figure is the chain's stated L1 hard-finality; the exact `getBlock({blockTag:"finalized"})` delay on this Orbit deployment should be measured against the live RPC.
- **RPC rate limits / SLA** — the public endpoint's documented rate limit and uptime SLA were not found; needed to size CX-K2/K3 and the fallback plan.
- **Keeper soft-confirmed-then-voided edge** — SUSPECTED low risk: a distribution mined into a soft block then voided on failover. `distribute()` re-reads `availableQuote()` live each cycle, so it self-heals (re-distributes next cycle) and cannot double-credit; confirm with a reorg test against the keeper's state machine.
