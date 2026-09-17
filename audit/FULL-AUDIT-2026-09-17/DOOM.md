# DOOM — economic attacks, MEV, and the five ways Census dies (tracks I + J)

Built on the A–G contract analysis + track K's chain facts. **Key chain nuance (K):** Robinhood Chain
is a single-sequencer Arbitrum Orbit L2 with ~100 ms soft blocks and **no public mempool** and no
priority-gas auction — transactions are ordered first-come-first-served by one Robinhood-run sequencer.
That materially **downgrades classic MEV**: outside actors cannot see pending txs to sandwich or
front-run them, and cannot bid gas to reorder. The residual MEV risk is (a) the sequencer/operator
itself, and (b) anything telegraphed off-chain or reconstructable from soft-block state within ~100 ms.

## Track J — MEV, sandwiching, bots (with the no-mempool discount)

| Vector | On a public-mempool chain | On Robinhood Chain (FCFS, no mempool) |
|---|---|---|
| Sandwich a buy/sell on the graduated Uniswap pool | Standard, profitable | **Hard** — no mempool to front-run; capped anyway by the UI's 2% `minOut` (`Coin.tsx:243`). Residual: the sequencer could self-sandwich. |
| Front-run graduation (`graduate` is permissionless) | Feasible | Hard to front-run; but graduation mints at the **curve price** with no external reference, so the *first* pool trade sets the market — a bot that lands the first post-graduation buy gets the best price. FCFS, not gas-auctioned. |
| Launch front-run (CX-F1) | Feasible | **Was latent even here** (address is telegraphed by the UI preview / off-chain announce). **Now fixed** (salt bound to creator). Cheap insurance regardless of chain. |
| Snipe the first curve tick | Feasible | The 99% launch tax (~30 soft blocks / 3 s) taxes the impatient; a sniper waits 3 s → 2% (CX-C2). Creator + 32 wallets exempt throughout (CX-C1). |
| JIT dividend farming (CX-E1) | Feasible | Needs to hold across the operator's `distribute` tx; no mempool means you must *predict* the distribution, not react to it. Fee drag + prediction requirement make it marginal. |

**Net:** the chain's design is Census's biggest MEV defence. The exposure that remains is the
**operator/sequencer trust** (Robinhood orders txs; the Census keeper chooses distribution `minOut`,
CX-G1) and the **fixed 2% slippage** which is un-adjustable (CX-N/J) — too tight on a fast move → legit
trades revert; it can't be loosened by the user.

## Track I — the five most plausible ways this product dies

### DOOM-1 (non-technical) — The founder soft-rug, told as a headline
A creator launches "$ACME — the on-chain Acme Corp," funds the curve toward graduation from their own
32 exempt wallets at 2% (CX-C1), and holds ~80% of supply before any taxed buyer gets a fair price. The
coin graduates; organic buyers pile into the locked pool believing it's a fair launch. The creator sells
into them, draining the pool's quote side. The buyers are left holding a coin whose "company" was one
person. **Nothing in the contracts prevents this** — the anti-snipe tax explicitly exempts exactly the
actor best placed to do it. The death isn't a hack; it's the third or fourth rug that a journalist
writes up as *"Census's own code exempts the founder's 33 wallets from the tax it charges everyone
else"* (track X, sentence 1). Trust, once gone, doesn't come back to a launchpad.
**Guard:** cap/vest the exempt side (CX-C1); disclose creator allocation in the UI.

### DOOM-2 (technical) — Anchor collapse cascade
Company-coin B is quoted in company-coin A (recursive anchors). A is a hyped coin used as the quote for
a cohort of memes. A rugs (DOOM-1) or its pool is drained. Every coin quoted in A now prices against a
worthless/near-zero reserve. **Track H (CX-H2) verified the display degrades to "—" rather than
NaN/Infinity** (the recursion is depth-capped and drained pools are guarded), so this is a UX/valuation
collapse, not a crash — holders of the cohort can't tell what their coins are worth, and the manipulable
spot (CX-H1) means the *prices and min-outs* on those coins are already soft. There is **no cycle guard**
(A↔B mutual anchors both show "—") and a USD cache keyed without depth causes load-order "—" flicker.
Only graduated company coins are pairable (`isPairableCompanyCoin`), which bounds the blast radius.
**Guard:** add a cycle check + a "quote asset impaired" UI state; move price/mcap off raw `slot0` to a
TWAP (CX-H1).

### DOOM-3 (non-technical) — The securities/impersonation letter
Census markets V2 as *"a coin that pays its holders a dividend in real stocks"* and *"taking companies
public on-chain,"* lets anyone mint "$ROBINHOOD" or "$NVIDIA" with the real logo, on a chain branded
"Robinhood," with no ToS, risk disclosure, or takedown path (track X, CX-X1/2/3/5). The death is a
cease-and-desist from Robinhood or an SEC inquiry into the "dividend" framing, arriving the week Census
gets popular enough to notice. There is no moderation code behind the launch form's "subject to
moderation" checkbox to point to. **Guard:** securities counsel on the dividend framing *before*
mainnet; a real report/takedown path; a name/impersonation blocklist; ToS + risk disclosure.

### DOOM-4 (technical/ops) — The dependency brownout during the one moment that matters
A coin goes viral. Traffic spikes. The single RPC (CX-K2) and the unthrottled `/api/zeroex` (CX-L1) are
hammered — by real load or a competitor's script — the RPC rate-limits, quotes start failing, and the
home page (which scans logs from block 0 every load, CX-S2) times out. To users the whole platform looks
broken at its peak. If instead the *sequencer* stalls (precedent: 4 Sep 2026, CX-K5), trading freezes
outright with **no status page and no non-frontend sell path** — users watch their positions and can't
act. **Guard:** ship the indexer; RPC fallback + rate-limits + spend caps; a status page and a documented
"how to sell without the frontend" path.

### DOOM-5 (non-technical) — The bot-slop equilibrium
Launching is cheap (gas + a small curve seed). With no dedup/impersonation guard (CX-P2) and no
moderation, the board fills with junk and copycat launches faster than real ones. A first-time user
arrives to a wall of dead "$NVIDIA" clones and near-zero coins, sees no signal, and leaves. The launchpad
doesn't get hacked — it gets *boring and untrustworthy*, which for a consumer product is the same death.
**Guard:** curation/ranking that rewards real activity, a verified badge, dedup warnings, and a launch
cost or reputation gate.

## What is NOT a doom (verified reassurance)
- Curve principal cannot be stolen by any privileged role (A–G): no function withdraws `realQuote`.
- No gas-scaling loop bricks trading as holders grow (CX-K6 / my track-F analysis: `eligibleSupply` ≤5 fixed).
- Graduation can't be made to mint at a manipulated price (F01 closed, fail-closed).
- No stored XSS, no secrets in the bundle, connect doesn't auto-grab a wallet.
These are real strengths; the deaths above are economic, legal, and operational — not breaks in the core.
