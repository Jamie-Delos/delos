# NOT VERIFIED — what this audit could not close, and who must

Everything below is outside what a read-only + local-testnet audit can prove. Each item says why and
exactly what would close it.

## Needs mainnet / a fork RPC
- **Real Robinhood Chain Uniswap deployment** — factory/NPM/router addresses, which fee tiers actually
  exist, and that the WETH→USDG→HOOD zap route has liquidity. Fork tests are skipped (no `BASE_FORK_RPC_URL`).
  *Close it:* a mainnet-fork test or read-only preflight. (G12)
- **Real pool depth** for graduated / company-coin pools — CX-H1's severity (spot manipulation) scales
  with how thin the pools are. *Close it:* measure depth on mainnet once pools exist.
- **The live Vercel bundle** — I built and grepped a *local* `dist/`; I did not fetch the deployed
  bundle. *Close it:* grep the live JS for the same secret patterns after each deploy (belongs in CI).

## Needs real wallets / devices (track O, R)
- Privy + WalletConnect **live flows**: first connect, embedded-wallet creation, export, sign-out,
  Privy-down fallback, popup-blocked, email-tab-closed. *Close it:* Jamie does one real email sign-up
  (already the standing to-do) + a wallet-connect pass.
- **Mobile in-app browsers** (Twitter/Telegram/Discord) and iOS Safari / Android Chrome — deep-link and
  popup behaviour differ there and that's where launchpad traffic comes from. *Close it:* a real-device pass.

## Needs live load / an adversary (tracks L, T, K)
- The rate-limit / cost-exhaustion findings (CX-L1/L2/L3, CX-K2) are **reasoned, not executed** — I did
  not run a DoS against the endpoints. *Close it:* a controlled load test + confirm the 429s after fixes.
- **Reorg / sequencer-failover behaviour** (CX-K1/K4) — not reproduced live. *Close it:* observe a real
  soft-block reorg, or test against a fork that simulates one.
- Measured **finalized-tag lag** and RPC SLA/rate-limit (CX-K3). *Close it:* measure on mainnet.

## Needs measurement (tracks S, Q)
- **Gzipped bundle size + TTI** on a mid-range phone / 3G (I have raw chunk sizes only). *Close it:* a
  Lighthouse/WebPageTest run.
- **Accessibility**: keyboard-only nav, focus-visible, screen-reader labels on icon buttons, and the
  **contrast ratios** of muted text / the lime accent on the dark ground (I flagged sub-44px tap targets
  live but did not measure contrast). *Close it:* an axe/contrast pass.
- **RPC-call count per page load** and re-render/interval-leak profiling (CX-M2/S2 reasoned from code).

## Needs the deployed indexer (track M)
- The indexer is **not deployed**, so its reorg recovery, cold-restart, pagination-at-scale, and the
  $3000/$0 USD placeholder (CX-M1, CX-M3) are analysed from source, not observed. *Close it:* stage the
  indexer and verify USD + reorg handling before flipping `VITE_INDEXER_URL`.

## Needs a lawyer (track X)
- CX-X1 (securities framing) and CX-X2 (trademark/impersonation) are **risk identification, not legal
  advice**. *Close it:* securities + IP counsel before mainnet.
- FMP / TrustWallet logo-hotlinking terms (CX-H4/X6) — not read. *Close it:* check the vendors' ToS.

## Contract behaviours reasoned, not fuzzed
- CX-B1 griefing cost and CX-E1 JIT-dividend profitability are **modelled, not simulated**. *Close it:*
  a parametrised profitability sim.
- No fuzz/invariant testing exists on the contracts beyond the hand-written suite. *Close it:* add
  Foundry invariant tests on the curve conservation law and vault solvency.

## Secrets
Private keys, the 0x key, the Vercel token, Privy/KV/Blob tokens, and any DB URL were **named only,
never printed or read**, per the engagement rules. Their *values* and rotation status are not audited.
