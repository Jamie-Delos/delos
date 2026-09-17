# Census — full audit (A–Z). 2026-09-17

**The contracts are sound; the product is not mainnet-ready. No way to steal, burn, or freeze curve
principal was found anywhere, and the three prior P1s are fixed and re-verified against real Uniswap
V3. What blocks mainnet is not a core exploit — it is economics, law, and operations: a founder-
exempt "fair" launch, a manipulable price feed, no kill switch, no monitoring, a securities-shaped
pitch with no terms, and a build only one laptop can reproduce.** Testnet is fine to keep running.

One thing was fixed during the audit: **CX-F1 (launch front-running) — committed `c57156f`, repro passing.**

Scope: every Solidity contract + deploy wiring (A–G, read line-by-line, suite run, maths re-derived);
the serverless API, frontend, wallets, bundle, chain, indexer, integrations, build/ops, legal, and
economics (H–Z, by direct testing + four recon agents, all findings verified against the code). Detail
lives in the track files listed at the bottom; this page is the verdict.

## No S0. The S1s (fix before real funds)

| ID | Track | The defect |
|----|-------|-----------|
| CX-C1 | C | Creator + 32-wallet bundle are **tax-exempt and uncapped** on the curve — every launch is structurally an insider position; the "fair launch" story is false. |
| CX-H1 | H | Price, market cap **and** the on-chain trade `minOut` all come from a manipulable Uniswap `slot0` spot (no TWAP), on every graduated / non-ETH coin. Thin company-coin pools → fake mcaps + real execution loss. |
| CX-M1 | M | The indexer hardcodes ETH = **$3000** and other anchors = **$0**; the day it's switched on, every USD price is wrong. |
| CX-X1 | X | Securities-shaped pitch — "taking companies public on-chain", "a coin that pays a **dividend in real stocks**" — with no terms, disclosure, or counsel. Existential legal risk. |

## The S2s (core-journey / operational blockers)

Kill switch: **none exists** — no `pause` in any contract, so a live incident can't be halted (CX-W1).
No monitoring of reserves/solvency; a 3am drain pages nobody (CX-W2). `/api/zeroex` is unauthenticated
and unthrottled → 0x-key exhaustion (CX-L1). One RPC, no fallback, and the home page rescans from block
0 every load (CX-K2, CX-M2). The live bundle isn't reproducible from the repo and CI never builds the
frontend (CX-V2, CX-V3). The fee (2% 75/25) is hard-coded and asserted as fact but the docs say 1% /
"pending" and it isn't signed off (CX-Z2). No ToS / privacy / GDPR-deletion for the emails Privy collects
(CX-X3, CX-X4). Graduation is griefable by a deep mispriced pre-pool (CX-B1). One keeper key over all
vaults; treasury a single EOA unless `FEE_SPLIT` is set (CX-G1, CX-G2). Bus factor: one laptop, one
immutable deployer key, gitignored config (CX-V4). Runbooks fail if followed literally (CX-Z3).

Full list with evidence, blast radius and fixes: **[GATES.md](GATES.md)** (12 blocking gates, 6 should-fix).

## What is genuinely strong (verified, not assumed)

- **No privileged path to curve principal.** No function withdraws a curve's `realQuote`; a deployer-key
  leak costs pending dividends + new-launch griefing, never the reserves. (A–G, MONEY-MAP.md)
- Prior **F01/F02/F03 fixed** and re-verified against real Uniswap V3 bytecode (95 → 96 tests pass).
- **No secrets in the bundle; no server code shipped; no secret is a `VITE_` var.** (U — built + grepped)
- **No stored XSS** — React escaping, image only as `<img src>`, SVG rejected, no `dangerouslySetInnerHTML`. (P)
- **Connect doesn't auto-grab a wallet** (EIP-6963 picker) — fixes the Trust complaint; trade flow can't
  double-submit and doesn't fake success before the receipt. (N, O)
- **No gas-scaling DoS** as holders grow (`eligibleSupply` is ≤5 fixed). (F, K6)
- The chain has **no public mempool**, which largely neutralises classic sandwiching/front-running. (K, J)
- Responsive at 375px; honest "pending indexer" empty states. (R, N)

## The ranked work (harm-avoided per hour — for Monday morning)

1. **Legal read on the securities/dividend framing (CX-X1) + basic ToS/privacy/risk disclosure (CX-X3/4).** Days of lawyer time, but it's the one that ends the company. Start it now; it runs in parallel with everything else.
2. **Decide CX-C1 (creator/bundle exemption): cap, vest, or disclose.** Hours to disclose, days to cap+vest. Biggest trust/reputation exposure and it's a decision, not research.
3. **Move price/mcap/min-out off raw `slot0` to a TWAP or indexer feed (CX-H1); fix the indexer's $3000/$0 USD before switching it on (CX-M1).** ~1–2 days. Stops fake numbers and weak execution on the coins the product is *about* (company coins).
4. **Rate-limit the public endpoints + a Vercel spend cap + a second RPC (CX-L1/L2/L3, CX-K2).** ~1 day. Cheap insurance against a trivial brownout at your first viral moment.
5. **Monitoring + incident plan + status page (CX-W1/W2).** ~1–2 days. You can't add a pause without redeploying immutable contracts, so detection + a documented response is the whole defence.
6. **Reproducible build: commit prod config / `deployments.json`, make CI run `vite build` (CX-V2/V3); back up the deploy key + `.env` (CX-V4).** ~half a day. Removes the "one laptop dies" single point of failure.
7. **Mainnet deploy gates: `FEE_SPLIT`→splitter/multisig (CX-G2), keeper custody (CX-G1), verify real Uniswap addresses/tiers (CX-H2/G12), reconcile the fee docs (CX-Z2).** ~1 day, all at deploy time.
8. **Ship the indexer before real traffic (CX-M2/S2)**; then the should-fix polish (runbooks, README, a11y, dedup/impersonation, unregistered-address shell).

Everything is critical only if you refuse to order it. The order above is the advice.

## Deliverables in this folder
- **[FINDINGS.md](FINDINGS.md)** — A–G contract findings in full, + "argue against the premise" + the A–G ranked list.
- **[MONEY-MAP.md](MONEY-MAP.md)** — every wei of a trade to its resting place, all five lifecycle states.
- **[GATES.md](GATES.md)** — the mainnet go/no-go, by owner, with proof-of-closure.
- **[DOOM.md](DOOM.md)** — MEV (tracks I/J) + the five ways it dies.
- **[COVERAGE.md](COVERAGE.md)** — the honesty ledger: every file opened, every track's method, what's not verified.
- **Track files:** [TRACK-L-N-P-Q-R-S-U.md](TRACK-L-N-P-Q-R-S-U.md) (my hands-on), [TRACK-H-M.md](TRACK-H-M.md), [TRACK-K.md](TRACK-K.md), [TRACK-V-W-Z.md](TRACK-V-W-Z.md), [TRACK-X.md](TRACK-X.md).
- Repro: `contracts/test/audit.frontrun.test.js` (CX-F1, passing).

*A–G were read and run by me directly. H–Z were done by direct testing (build, bundle grep, live dev-server) plus four recon agents whose findings I verified against the code before recording; the few things neither method could reach are listed in COVERAGE.md / each track's NOT-VERIFIED.*
