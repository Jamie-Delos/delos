# RobinPad — Build To-Do

_Living list. Near-term first. Tick as we go._

## Phase 0 — Close & onboard
- [ ] Finalise + sign the one-pager (5% equity · 10% fee on-chain · $2k now + $2k at first launch · scope · IP)
- [ ] Receive first $2k
- [ ] Confirm **your** wallet address for the on-chain 10% fee recipient
- [ ] Get company/entity details so the 5% is recorded on the cap table when it's formed
- [ ] Move code into the company/shared GitHub + set up access (AFTER the $2k lands)

## Research (go-to-market / be iron-clad) — DONE
- [x] Launchpad gotchas & exploits — Pons is open-source (github.com/ponsdotdev/ponsfamily); Pons's early issue = front-end approval bug + immutable fee-recipient (we already dodged it); NOXA died on ops/domain, not contracts; sniper tooling exists → anti-snipe shipped. Defensive checklist captured.
- [x] ICM sector + Belief — Believe collapsed (founder extraction / unkept buybacks); pump.fun's buyback-burn is the model that worked (= our $ROBIN flywheel). Watch securities language.
- [x] Tokenizing-startups thesis — "ICM" = tokenised public equities (real/regulated) vs the deflated meme-meta; permissionless "tokenise companies" is SEC-blocked in the US. Position as a memecoin + stock-dividend pad, not an unlicensed securities issuer.
- [x] **Fee-structure research + recommendation** — `CENSUS_FEE_MODEL.md`. Market converged on **1% fee, 70/30 creator/protocol** (Pons, Long, Bankr); pools.trade is the 0.25% outlier (Uniswap, recycles to LP); launch fees tiny+universal (~$1); the chain (Robinhood) also takes a cut. **Recommendation: move Census from 80/20 to flat 70/30 from block one, V1 and V2; fund the V2 dividend from the creator's 70% (creator-tunable), keep the 30% protocol cut on V2 too (fixes team-earns-£0-on-V2); add a ~0.0005 ETH launch fee.** Needs Jamie/team sign-off before contract changes.

## Design — DIRECTION LOCKED, handed to Claude Design
- [x] **Census brand locked**: chrome + deep hunter-green + one lime accent; ornate chrome/serif LOGO on a minimal SANS system; mono numbers; rounded. (Reversed the old flat/teal/sharp system.)
- [x] **Landing built** (chrome hero, real page): https://claude.ai/code/artifact/7798572f-11c6-45fc-a944-5bba62dd7188
- [x] **Anchors wizard built** (interactive): https://claude.ai/code/artifact/86725cd4-c54b-48ad-b8b6-cfeb4c1f4bf6
- [x] **Handover package**: `design-handover/CENSUS_DESIGN_HANDOVER.md` (+ `prototypes/` + `census-hero.webp`) — tokens, screens built + to-build, assets, copy, mechanics, file map. Continue in Claude Design, one screen at a time.
- [ ] Screens still to design (Claude Design): Company · Economics · Identity (with `0x…c0de` reserved address) · Review · Launch · Explore/feed · Coin/Trade · Portfolio · onboarding · states.
- [ ] Full-motion hero: run `Census_Mercury_Hero_Transparent_4K.png` through Runway/Kling (video loop) or Spline (3D), swap into the landing.
- [ ] Get Coolio's logo **SVG/vector** (crisp small sizes) + a flat single-tone C for favicon.
- [ ] Check ORCL, ASML, SOFI, NU, CRWV, XLK, BE, BB (not in our 51) for V3 liquidity → catalogue parity.

## Branding & identity (decided this session)
- [~] **Rename RobinPad → Census** (frontend): `index.html` `<title>`→"Census" ✓, `App.tsx` wordmark→"census" ✓. NEEDS YOU: the ecosystem token `$ROBIN` (`Token.tsx`) — the **Census ecosystem-token name** is a decision (your call — `$CNS`?). MOOT: old `styles.css` (teal/flat/sharp — replaced wholesale by the Census design). (Repo/Vercel rename later.)
- [x] **Vanity token addresses → `…c0de`** — DONE + devnet-proven (v1 tokens `…C0de`/`…c3c0De`, v2 token `…c0dE`; ~60–95k grind tries).
  - [x] Factory change: `LaunchFactory` + `LaunchFactoryV2` deploy the token via **CREATE2** with a `bytes32 salt` param (`new LaunchToken{salt: s}(...)`; `salt == 0` = plain deploy, backward-compat). Address is now deterministic → free "reserved address" preview.
  - [x] Enforced on-chain: `require((uint160(token) & 0xFFFF) == 0xC0DE, "not a census address")`.
  - [x] `scripts/lib/grindSalt.js` helper (keccak `getCreate2Address` loop) + all launch scripts (devnet v1/v2, launch.js) grind and pass the salt; fork test passes `bytes32(0)`.
  - [x] Frontend: grind in-browser during launch — DONE. `frontend/src/lib/c0de.ts` mirrors `grindSalt.js` (CREATE2 math verified: finds a `…c0de` address in ~10k tries, sub-second, UI yields every 2500). Used by both Prima + Maxima launches (also fixes address prediction), reserved `…c0de` shown in the preview, plain-deploy fallback. `factoryAbi` v1 salt param fixed. Bytecode embedded via `scripts/exportTokenBytecode.js` (regenerate from the deploy build, or a grinded launch reverts).

## Phase 1 — Make v2 fully live (the real technical gap)

### ⚠️ Fee-rate reality (checked on-chain 2026-09-07)
- [ ] **2% fee needs Uniswap V4.** RH mainnet Uniswap has only the 0.01/0.05/0.3/1% tiers (no 2%, owner is Uniswap's not us so we can't add one), and a token buy/sell tax breaks Uniswap V3. So **2% / 75-25 requires V4 hooks** (retained-IP, audit-heavy). DECISION PENDING: launch on V3 at **1% (market-standard 70/30, deployable now)** vs hold for **2% via V4**. Rec: ship 1% now, make 2%/V4 the upgrade. The rest of the build is fee-agnostic and proceeding.

### 0x integration (going 0x-heavy) — decided 7 Sep 2026
- [x] **`DividendVault.distributeVia0x`** — guarded on-chain 0x execution path, built + devnet-proven. Approves/calls ONLY the pinned `allowanceHolder` (0x's stable entry point, never an address the API returns), exact-amount approve then reset to 0, credits the measured stock balance-delta, reverts unless it clears `minOut`. Opaque 0x calldata can grief (revert) but never drain. Operator-gated + `nonReentrant`. Uniswap `distribute()` kept as the fallback. `LaunchFactoryV2` now takes an `allowanceHolder` ctor arg and threads it to each vault. Devnet (`MockZeroEx` standing in for AllowanceHolder+Settler) proves: operator gate, minOut guard, credited basket, approval reset to 0. Option A accounting + adversarial drain test untouched and still green.
- [ ] **Deploy-time**: pass the real 0x AllowanceHolder for Robinhood Chain to `LaunchFactoryV2` (Cancun singleton `0x0000000000001fF3684f28c67538d4D072C22734` if RH Chain is post-Cancun — confirm on the 0x cheat-sheet before deploy).
- [x] **Keeper** (off-chain) — built at `bot/src/keeper0x.js` (DRY_RUN default; `probe` mode; npm `probe0x`/`keeper0x:dry`/`keeper0x`). Fetches a 0x quote per stock (taker=vault), passes `transaction.data` + `minBuyAmount` into `distributeVia0x`. Key in `bot/.env` (gitignored).
- [ ] ⚠️ **BLOCKER found (live probe 2026-09-07): 0x refuses tokenised stocks.** Key + chain work (WETH→USDG quotes fine via Uniswap V4), but every stock (NVDA/TSLA/MSFT) returns 422 *"buy token is not authorized for trade due to legal restrictions"*. So **0x can't buy the V2 basket today** — Uniswap `distribute()` (the kept fallback) remains the stock-swap engine; `distributeVia0x` is ready for if/when it's lifted. **Ask 0x BD** whether the tokenised-equity block is geo/IP, key-allowlist, or hard policy, and whether it can be enabled for Census. Net: go 0x-heavy for coin trading + routing + cross-chain; Uniswap for the stock dividend until then.
- [x] **Front-end trading via 0x** — built. `frontend/api/zeroex.ts` (Vercel serverless key proxy, allowlists price/quote + params, `ZEROX_API_KEY` server-side only, never in the bundle) + `frontend/src/lib/zeroex.ts` (client) + `Coin.tsx` rewired: 0x best-execution as primary for **buy AND sell** (sell was "coming soon"), the quote's `minBuyAmount` as a **real** on-chain slippage floor (was `amountOutMinimum: 0`), the coin's own Uniswap pool as automatic fallback when 0x has no route, and a live "you receive ≈ … via <route>" readout as you type. Typecheck + Vite build clean. Set `ZEROX_API_KEY` in the Vercel env; `vercel dev` for live quotes locally. (Coin trading is not affected by the tokenised-stock restriction — coins are plain ERC20s.)
- [ ] **Cross-chain onboarding**: 0x Cross-Chain API to bring funds onto RH Chain (Ethereum/Base/Arbitrum/Solana → RH).
- [ ] **Audit** the `distributeVia0x` arbitrary-calldata path before real volume (highest-sensitivity surface).
- [ ] Once 0x is primary, `stockRoutes.ts` USDG-hop paths are only needed for the Uniswap fallback (0x does the routing). 0x is live on RH Chain with **RFQ liquidity for tokenised stocks** — the ideal source for the dividend baskets.

- [x] **Studied Pons's open-source contracts** (github.com/ponsdotdev/ponsfamily). (a) Pons's `PonsLaunchFactory` deploys via **CREATE2 with an enforced vanity suffix `0xbbbb`** — validates our `c0de`/CREATE2 design (we grind off-chain + a cheap `require`; Pons grinds *on-chain* up to 1M iters = far more gas). Optional adopt from Pons: also check "no pre-existing code/pool at the predicted address" (belt-and-braces vs salt front-running; low risk for us — a taken salt just reverts and the launcher re-grinds). (b) Our Option A = the canonical magnified-dividend / reward-debt pattern (atomrigs `DividendPayingToken` / MasterChef); the token→vault-tracker split is a standard variant and fits our 4-stock basket + generic v1 token. Conclusion: **on-pattern**; still get an audit before real volume.
- ~~PonsVault (RWA-dividend templates) repo is 404/private now — used the canonical `DividendPayingToken` as the reference instead.~~
- [x] **Wire the Maxima (v2) launch flow in the frontend** — DONE. `Launch.tsx` calls `LaunchFactoryV2.createLaunch(params, basket, weights, paths, salt)`, mapping the stock picker → `stockRoutes.ts` (address + path), even bps weights (sum 10000), salt=0 for now. Tiers relabelled Prima/Maxima; `factoryV2Abi` + `VITE_FACTORY_V2_ADDRESS` added; typecheck green. (c0de in-browser grind = remaining follow-up: needs the LaunchToken initcode embedded + a worker grind.)
- [~] Join picker tickers → `stockRoutes` — launch now validates picks against the route table and errors on any not-yet-tradeable stock; graying them out in the picker UI is the remaining polish.
- [x] Slippage protection on `DividendVault` swaps — DONE (operator-gated `distribute()` takes per-stock `minOut`; `amountOutMinimum` enforced, no longer 0). _(duplicate of the Phase 3 item)_
- [x] Deploy contracts to Robinhood Chain — **DONE on TESTNET (46630, 2026-09-07).** `npm run rehearse:robinhoodTestnet` deployed our own Uniswap V3 + FeeVault + both lockers + Prima (`0xB3Cf…BbEe`) & Maxima (`0x2FDf…839B`) factories. **Prima launched** `0x54c2…306C0de` (c0de ✓, pool + locked LP), **Maxima launched** `0x4e99…C2aC0de` (c0de ✓, vault `0xA235…327A2`). Frontend wired to testnet (`frontend/.env`), indexer live (board shows both real coins, mock gone). Scripts: `launch.js` (Prima) + `launchV2.js` (Maxima). Mainnet flow same via `:robinhood` + `MAINNET_RUNBOOK.md`.
- [ ] Remaining testnet lifecycle: buy → graduate → collect fees (drivable in the app with a wallet, or a script). Maxima `distribute()`+`claim()` needs live stock pools = mainnet (already devnet-proven adversarially in `devnetV2.js`).
- [ ] Wire frontend `.env` to deployed addresses (factory, locker, weth, router, chainId)
- [ ] Verify contracts on Blockscout
- [ ] Full on-chain E2E: launch → buy → graduate → collect fees → v2 `distribute()` + `claim()` with a real USDG-routed stock (e.g. MRVL)

## Phase 2 — First launch (they want this week)
- [ ] Agree the first coin(s) + config (v1 or v2, which basket)
- [ ] Coordinate branding/name with the team (their lane)
- [ ] Dry-run the exact launch on a fork/testnet
- [ ] Launch checklist: deployer funded, gas, params double-checked
- [ ] Go live + monitor

## Phase 3 — Hardening & security (before real money / volume)
- [x] **Anti-snipe (v1/v2)** — DONE. LaunchToken arms an auto-expiring window on launch: same-block buys blocked, 2% max-wallet + 1% cumulative per-wallet buy caps during the window. Devnet-proven (oversized in-window buy rejected). _Defaults tunable in the factories; window is in blocks._
- [x] **v2 dividend-gaming fix (Option A)** — DONE + adversarially devnet-proven. Reward-debt / settle-on-transfer accounting in `DividendVault` (per-stock `accPerShare` / `rewardDebt` / `settled` / `withdrawn`), driven by a failsafe `onTokenTransfer` hook the `LaunchToken` calls on every transfer (v1: `dividendVault == 0` → skipped, no gas). PROVEN on devnet: a buyer who purchases AFTER a distribution earns **0** of it (drain prevented), the excluded pool earns nothing, and that same buyer earns pro-rata of the NEXT distribution (fair going forward); normal pro-rata unchanged. ⚠️ **Still wants a security audit before real volume** — the transfer hook + per-share math are the sensitive surface, and a self-tested implementation isn't an audit.
- [x] **Slippage guard on DividendVault swaps** — DONE. `distribute()` is operator-gated and takes per-stock `minOut` (off-chain fair price), enforced on each swap. Devnet-proven (non-operator call rejected).
- [x] Fee-collection reentrancy — DONE. OZ `ReentrancyGuard` on `LaunchLocker.collectFees` + `DividendVault.distribute`/`claim` (all already checks-effects-interactions); devnet-proven both lifecycles still green. _(fee-on-transfer quote rejection: N/A while quote = WETH; add a balance-delta check only if a non-standard quote is ever introduced.)_
- [x] Rounding/precision — reviewed. All on-chain division floors *against* the user: fee split is exact (dust→creator), anti-snipe caps floor (stricter), dividend per-share floors so the vault is always solvent (dust stays in vault). Added a claim-time **balance cap** so rounding dust can never revert the last claimer (remainder stays owed → next distribution). No custom on-chain curve math (Uniswap V3 core is the AMM) → the Balancer-class invariant-rounding exploit doesn't apply; off-chain `launchParams` precision is covered by unit tests.
- [ ] Ops security — registrar lock + DNSSEC on the domain, exact-amount approvals in the UI (never unlimited), verify spender against an allowlist, publish canonical addresses (NOXA *lost its domain*; Pons had a front-end approval bug)
- [ ] Security review / audit before real money at scale
- [~] Indexer to replace the mock board data — DONE (MVP). `frontend/src/lib/useLaunches.ts` reads real `Launched`/`LaunchedV2` events from both factories, builds the board list (name/symbol/creator/age), and falls back to the mock catalogue in preview. Home + board (Advanced) wired. Follow-up: live price/mcap (needs pool reads) and event pagination for mainnet scale (set `VITE_FROM_BLOCK`).

## Phase 4 — v3 (separate — only if commissioned & paid)
- [ ] V4 hook backend: buy/sell taxes, anti-snipe, dynamic fees (your retained IP)

---
### Notes
- Beyond-scope work (heavy sprints, VC/technical calls, new features) = billed at day rate by prior agreement.
- v3 stays yours unless separately commissioned.
