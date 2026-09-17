# Census audit — tracks V, W, Z (build/release/bus-factor · observability/incident · handover/docs/team)

Auditor stance: hostile, read-only, no source edits, no secrets printed. Every doc/comment is a **claim**
verified against code/config. Evidence tags PROVEN / DERIVED / SUSPECTED. Cross-refs to the master
`FINDINGS.md` (tracks A–G) and to the 11 Sep 2026 `AUDIT.md` where a finding is corroborated or already owned.

New IDs here: **CX-V2…V6, CX-W1…W2, CX-Z1…Z4** (CX-V1 = stale CLI scripts already exists; not renumbered).

---

## Track V — build, release & bus factor

### Answers (floor questions)
- **Reproducible from a commit?** No. Build command exists and deps are pinned (`frontend/package.json` build =
  `tsc -b && vite build`; `vercel.json` buildCommand=`npm run build`; `package-lock.json` present, `npm ci` used).
  But every `VITE_*` value (chain, RPC, curve/factory/locker addresses) is **baked at build time from
  `frontend/.env`, which is gitignored**. The only in-repo copy of the live addresses is a **commented-out**
  block in `frontend/.env.example`; the *active* lines there are all `0x0000…0000`. A clean checkout +
  `cp .env.example .env && npm run build` produces a **zero-address bundle**, not the live one. → CX-V2.
- **CI on push?** Yes for backend — `.github/workflows/backend.yml` runs contracts (compile, bytecode parity,
  `hardhat test`, `rehearse:bonding`, indexer parity), indexer (typecheck, `test`, `test:pg`), bot (`npm test`),
  and metadata (frontend `tsc --noEmit` + `api/metadata` + `api/upload` node tests). **But it never builds the
  frontend** (`vite build`) and runs **no** frontend unit/component/e2e test, no lint, no contract-coverage gate.
  The actual deployed artifact is never produced in CI. → CX-V3. (AUDIT.md 11 Sep said "no committed CI"; CI was
  added since — this is the residual gap.)
- **Rollback / staging?** No separate staging; the public `census-weld-chi.vercel.app` is the only deployed env
  (devnet is a *local* `--mode devnet` on :5174, not deployed). `MAINNET_RUNBOOK.md` "Rollback/safety" only says
  deploys are "additive"; no documented, tested frontend rollback; contracts are immutable. → CX-V5.
- **Addresses recorded & match?** `contracts/deployments.robinhoodTestnet.json` exists and matches
  `frontend/.env` **exactly** (curve `0xedc8…65e40`, factory `0xf450…10f6`, V2 `0x0B3c…72d2`, locker `0x50D1…D6A7`)
  and the commented `.env.example` block — internally consistent. **But `deployments.*.json` is gitignored**
  (root `.gitignore:27`), so the authoritative record is **not in the repo**. On-chain liveness of these
  addresses was **not** independently verified (no RPC read performed) — see `NOT-VERIFIED`. → CX-V4.
- **Bus factor (laptop/one .env/CLI deploy out for a week):** severe — see CX-V4.

---

### CX-V2 — S2 (certain) — The live bundle cannot be rebuilt from the repo; addresses come only from a gitignored `.env`
**WHERE** `frontend/.env` (gitignored, `frontend/.gitignore:8` `.env*`); `frontend/.env.example` (active lines
all zero-address, real addresses commented); `frontend/vite.config.ts`; `frontend/dist/assets/index-*.js`.
**WHAT HAPPENS** Whoever rebuilds from a clean checkout copies `.env.example`→`.env` (all `VITE_*_ADDRESS`
= `0x0000…0000`), builds, and ships a bundle pointed at zero addresses — every read/trade/launch fails. The
correct addresses survive only in a hand-maintained comment block and on the builder's disk.
**PROOF** `grep '^VITE_.*ADDRESS' frontend/.env.example` → all zeros; the live values appear only as `#`-commented
lines. `git ls-files --error-unmatch frontend/.env` → ignored. `grep -rl edc8e7286dC3D7C785dCED080d8366ABDbA65e40
frontend/dist` → `dist/assets/index-z4iilnIG.js` (i.e. the shipped bundle bakes the value that lives only in the
untracked `.env`). PROVEN.
**BLAST RADIUS** Any rebuild by a second person, or on a fresh machine, silently produces a broken or
wrong-network site. No commit/version stamp in the bundle to tell which build is live (compounds F04).
**WHY** VITE inlines env at build; the repo tracks only a template, and its live-address block is commented, so
"reproducible build" depends on an out-of-band file.
**FIX** Commit a per-network manifest (non-secret addresses are public) and read it in `config.ts`, or set the
`VITE_*` in Vercel project env and document that as the source of truth; stamp `VITE_COMMIT`/build hash into the
UI. Trade-off: addresses move from `.env` to a tracked file (fine — they are already public on-chain).
**TEST** CI job: fresh checkout → `npm ci && npm run build` with only tracked files → assert the bundle contains
the intended chainId/curve address (not `0x0000…`).

### CX-V3 — S2 (certain) — CI type-checks the frontend but never builds it or tests it; the deployed artifact is unverified
**WHERE** `.github/workflows/backend.yml` (job `metadata`: `npx tsc --noEmit` only); `frontend/package.json`
(`build`=`tsc -b && vite build`, `test` script absent).
**WHAT HAPPENS** A change that type-checks but breaks the Vite build (bad dynamic import, asset path, env
reference, plugin/Rollup error) passes CI green and only fails at deploy time on the one laptop — or ships if the
operator doesn't notice. `tsc --noEmit` (root tsconfig) is also not the same invocation as the build's `tsc -b`
(project-reference build mode), so type coverage differs too.
**PROOF** Full `backend.yml` read end-to-end: no `vite build` / `npm run build` in any job; no Playwright/vitest/
jest step; no lint. PROVEN.
**BLAST RADIUS** The single artifact users load is the one thing CI doesn't build; every S2/S3 frontend defect
in `FINDINGS.md` (e.g. F05/F12 zero-slippage, false success) ships without a build/e2e gate.
**WHY** CI was bolted on for backend suites (contracts/indexer/bot/api) after the 11 Sep audit; the frontend app
build was never added.
**FIX** Add a `frontend` CI job: `npm ci && npm run build` (fails the PR on a broken build) + a smoke e2e
(Playwright: load home, connect a mock wallet, open a coin). Trade-off: ~2–4 min CI time.
**TEST** The job itself is the test; assert non-empty `dist/` and a mounted root in a headless load.

### CX-V4 — S2 (certain if the one machine/key is lost) — One laptop, one gitignored `.env`, one immutable deployer key, gitignored deploy records
**WHERE** `contracts/.env` `PRIVATE_KEY` (deployer `0xEAd2f7477e5c629920f1E337FEb738ff0330e7a9`, per
`MAINNET_RUNBOOK.md §1`); `contracts/deployments.robinhoodTestnet.json` (gitignored); Vercel prebuilt CLI upload
from local `.env` (`MAINNET_RUNBOOK.md §6`). Key model: CX-G3 (`CensusCurve.sol:81` `address public immutable deployer`).
**WHAT HAPPENS** If the builder is out for a week or the disk dies: (a) no frontend redeploy (needs the Vercel
token + the untracked `.env` — CX-V2); (b) no deployer-only action possible (`setKeeper`, `setQuoteAllowed`,
`setRecoveryMaxSpendBps`, `sweepMigrationDust`, `setZapPath`) unless the key is backed up **elsewhere**; and
because `deployer` is `immutable` with no transfer path (CX-G3), a lost key can **never** be replaced — the
platform is permanently un-administrable (can't register HOOD, rotate a compromised keeper, or widen a griefed
graduation's recovery). (c) The canonical address map (`deployments.*.json`) is gitignored, so it too lives only
on that disk; only the `.env.example` comment survives in git.
**PROOF** `git check-ignore` → `contracts/.env`, `bot/.env`, `frontend/.env`, `deployments.*.json` all ignored;
`CensusCurve.sol` setters all gated `if (msg.sender != deployer) revert NotDeployer()` with `deployer` immutable
(lines 154–246). DERIVED (continuity), PROVEN (immutability/ignore rules).
**BLAST RADIUS** Total loss of administrability + address records on a single-point failure; on mainnet this is
"we can never touch the platform again," not merely downtime.
**WHY** Solo CLI ops with no documented key-custody, backup, or DR; records regenerated by scripts rather than
committed.
**FIX** (1) Deployer = multisig / `Ownable2Step` + timelock (already CX-G3's fix — do it before mainnet).
(2) Back up the deployer + keeper keys in shared custody (hardware/HSM/secret manager), documented. (3) Commit
`deployments.<net>.json` (addresses are public) or publish a canonical-addresses page (TODO's "publish canonical
addresses" is still open). (4) Write a one-page DR runbook: who has which key, where the Vercel token lives.
**TEST** Tabletop DR drill: a second person, from a clean machine with only repo + shared-vault access, redeploys
the frontend and executes one deployer-only tx on testnet.

### CX-V5 — S3 (certain) — No staging and no tested rollback; prod is the only environment and the contracts are immutable
**WHERE** `MAINNET_RUNBOOK.md "Rollback / safety"`; `.claude/launch.json` (devnet is local only); no second Vercel
project referenced.
**WHAT HAPPENS** A bad frontend deploy has no documented one-command revert (Vercel keeps prior deployments and
can re-alias instantly, but this is neither documented nor shown to have been tested); a bad contract deploy can't
be rolled back at all (immutable) — the runbook's answer is "re-run deploy.js and re-point the site," which strands
any coins already launched on the previous set.
**PROOF** Runbook text: "Deploys are additive… Re-run deploy.js to get a fresh set." No `vercel rollback`/alias
procedure; no staging URL anywhere. PROVEN (doc read).
**BLAST RADIUS** Every release goes straight to the public URL; the first place a regression is seen is by users.
**WHY** Single-env, deploy-from-laptop model.
**FIX** Add a staging Vercel project (or preview deployments gated on the CI build from CX-V3); document
`vercel rollback`/alias-repoint and rehearse it once. Trade-off: one more env to keep configured.
**TEST** Deliberately ship a visibly-broken preview, roll it back by the documented step, time it.

### CX-V6 — S3 (ops) — `verifyAll.js` skips the core contracts; the runbook's manual verify args are wrong (corroborates AUDIT F11)
**WHERE** `contracts/scripts/verifyAll.js:41–55` (verifies only FeeVault, LaunchLocker, LaunchFactory, WETH9);
`MAINNET_RUNBOOK.md §5` CensusCurve line; `deployments.*.json.verify` (records all six).
**WHAT HAPPENS** `npm run verify:robinhood[Testnet]` leaves **CensusCurve** (the trading venue), **LaunchFactoryV2**,
**FeeSplitter**, and **DividendVaultDeployer** unverified on Blockscout — the contracts users most need to read.
The runbook's manual fallback for CensusCurve, `verify … <NPM> <FeeVault> <LaunchLocker> <SwapRouter02>`, passes
**4 args in the wrong slots and omits `weth_`** (constructor is `(npm_, platform_, locker_, weth_, swapRouter_)`),
so it fails outright.
**PROOF** `verifyAll.js` calls `verify(...)` only for the three + WETH9; deploy.js writes a 6-entry `verify` block.
`CensusCurve.sol:154` constructor arity = 5; runbook supplies 4. PROVEN. (AUDIT.md F11 records the same.)
**BLAST RADIUS** Unverified core contracts erode trust and slow incident triage (no source on the explorer at 3am).
**WHY** Verify script and runbook weren't updated when the curve/V2/splitter were added.
**FIX** Generate verify calls from `deployments.*.json.verify` (all entries) in `verifyAll.js`; fix/remove the
manual runbook block. **TEST** CI/dry: assert `verifyAll` enumerates every key present in the `verify` manifest.

---

## Track W — observability, incident response & the kill switch

### Answers (floor questions)
- **Monitored today:** effectively **nothing** on the live testnet. There is no on-chain event monitor, no
  solvency/reserve watch, no graduation watch, no alerting on the trading contracts, no status page, no uptime
  check on the Vercel functions/RPC. The **only** alerting that exists is inside the reward keeper
  (`bot/src/keeperd.js`): an optional `ALERT_WEBHOOK_URL` that POSTs on low signer balance, tx reverts, stuck txs,
  pipeline failures and cycle crashes (`keeperd.js:112,163–177,540–547`). It watches **its own distribution duties
  only**, `ALERT_WEBHOOK_URL` is **blank** in `bot/.env.example`, and the keeper is **not even registered** on the
  live testnet (`deployments.robinhoodTestnet.json` `"keeper": null`) — nor is there evidence keeperd runs anywhere.
- **Who can pause what, in how many minutes, with which key:** nobody can pause anything — **there is no pause**.
- **Is there a pause in the contracts?** No (grep below). The honest response to a live drain is "watch it happen."

### CX-W1 — S2 (certain; converts any S0 into a completed loss) — No kill switch anywhere; trading and graduation cannot be halted
**WHERE** all of `contracts/contracts/*.sol`. `CensusCurve.sol` buy/sell/`graduate` have `nonReentrant` but **no**
pause guard; the only privileged key (immutable `deployer`, CX-G3) has setters that **do not stop trading**.
**WHAT HAPPENS** If a bug (or a leaked key) starts draining a coin at 3am, there is no function to stop buys, sells,
or graduation for one coin or all coins. The deployer's fastest levers are `setFactory(f,false)` /
`setQuoteAllowed(q,false)` — these gate **new launches only** ("Existing curves keep working; this gates
registration only", `CensusCurve.sol:174–176`) — or pulling the Vercel site, which does nothing to the
permissionless contracts (anyone can still call the curve directly). No lever reduces the bleed rate.
**PROOF** `grep -riE "pause|whenNotPaused|Pausable|halt|freeze|emergency|circuit" contracts/contracts/` → only
comments, one of which states the design intent: *"Trading never halts on a blocked fee recipient"*
(`CensusCurve.sol:65–66`). Sole access modifier across all contracts is `onlyOwner` ×2 in `FeeVault.sol`; the curve
uses inline `NotDeployer` reverts. No pausable state anywhere. PROVEN.
**BLAST RADIUS** Whatever an S0 can take, it takes in full — MTTR to stop the bleed is unbounded because the
capability doesn't exist. Worst realistic case: every coin's reserves during the window an exploit is live.
**WHY** Deliberate "immutable/permissionless, never halts" design chosen for censorship-resistance, with no
counterbalancing emergency control.
**FIX** Add a scoped, time-boxed guardian pause (per-coin and global) that blocks buy/graduate but **always leaves
sell/withdraw open** so it can't trap funds; hold it under a multisig/guardian, not the immutable deployer. Trade-off:
adds trust surface and code to audit — but "no brakes" is not shippable for real money. **TEST** Fork test: trigger
pause, assert buys/graduation revert while sells succeed; time the pause tx.

### CX-W2 — S2 (certain) — The only monitoring covers reward distribution, is unconfigured, and isn't wired to the live deployment
**WHERE** `bot/src/keeperd.js:112,163–177,540–547`; `bot/.env.example` (`ALERT_WEBHOOK_URL=` blank);
`deployments.robinhoodTestnet.json` `"keeper": null`; no monitor of `CensusCurve`/`LaunchLocker`/FeeVault anywhere.
**WHAT HAPPENS** No system observes curve reserves, graduation correctness, fee flows, or site/RPC health. Even the
keeper's webhook (a) only fires on distribution-pipeline problems, (b) is off by default (no URL), and (c) is
inactive because the keeper address is `null` on-chain, so `convertLaunchFees`/`distribute` are skipped for every
vault (the daemon logs this once and moves on). A reserve-loss or insolvent-vault event (see AUDIT F01/F02/F03)
produces **no alert to anyone**.
**PROOF** `deployments…json` keeper `null`; `bot/.env.example` `ALERT_WEBHOOK_URL` empty; keeperd alert call-sites
only in the distribute/collect/cycle paths. PROVEN.
**BLAST RADIUS** Detection latency for a 3am incident ≈ "when a user complains on Twitter." Combined with CX-W1
(no pause), that is the whole incident-response story.
**WHY** Observability was scoped to keeper self-health, not platform integrity; ops wiring (keeper registration,
webhook) is an unfinished TODO.
**FIX** Stand up a lightweight watcher (can reuse the indexer's viem log stream) that alerts on: reserve
decreases without a matching sell, graduations, vault owed-vs-held drift, FeeVault balance jumps, and RPC/site
5xx; set `ALERT_WEBHOOK_URL`; register the keeper (`curve.setKeeper`). **TEST** Simulate a reserve drop on a fork,
assert an alert is emitted.

### Drafted incident-response runbook skeleton (does not exist today — W deliverable)
This is the minimum runbook to write **before mainnet**. Every value in `< >` is currently unassigned.

1. **Detection.** Source of truth = `<on-chain watcher / webhook>` (build per CX-W2) → pages `<on-call name>` via
   `<PagerDuty/Telegram>`. Today: none — detection is inbound user reports.
2. **Triage (target ≤ 5 min).** Confirm on Blockscout: which coin(s), which function, reserve delta. Classify:
   (a) single-coin logic bug, (b) systemic curve/locker bug, (c) leaked deployer/keeper key (see CX-G1/G3),
   (d) frontend/serverless only.
3. **Contain (target ≤ 15 min) — with what actually exists today:**
   - New-launch containment: deployer runs `curve.setFactory(<factory>, false)` and/or
     `curve.setQuoteAllowed(<quote>, false)` — stops *new* launches, **not** trading of live coins.
   - Site containment: pull/revert the Vercel deployment (`<documented rollback — see CX-V5>`) so no *new* users
     interact — contracts remain live and permissionless.
   - Key compromise: `curve.setKeeper(<safe addr>)` to evict a rogue keeper (deployer-only; useless if the
     deployer key itself leaked and it's a single EOA — CX-G3).
   - **There is no lever that stops an in-progress drain of a live coin (CX-W1).** Add a guardian pause first.
4. **Communicate.** Post to `<status page — does not exist>` + `<official X/Discord>`; pin canonical addresses
   (TODO item still open). Tell users plainly whether they can still sell.
5. **Recover / refund.** No refund path exists. `curve.withdrawDeferredFee` (permissionless) only pushes *deferred
   fees*; `curve.sweepMigrationDust` (deployer) only moves post-graduation dust. A user refund would have to be
   computed off-chain from indexer/`Trade` events and paid manually from `<treasury>` — untested, undefined.
6. **Post-mortem.** Immutable contracts ⇒ fix = redeploy + re-point (CX-V5) + migrate/compensate; write it down.

**Owners/keys/machines to fill in before mainnet:** deployer key custody + backup (CX-V4); keeper key custody
(CX-G1); Vercel token holder; on-call rota; status-page URL; treasury signer for refunds.

---

## Track Z — handover, docs & the team

### Answers (floor questions)
- **README describes the system that exists?** No — it describes the **superseded** direct-to-Uniswap design
  ("No bonding curve, no migration step, no token tax"). → CX-Z1 (AUDIT.md already flagged this; still unfixed).
- **Runbooks work if followed literally?** No — multiple steps fail or are wrong. → CX-Z3.
- **TODO / fee-model / AUDIT consistent with code?** No — the fee is contradictory across code and four docs, and
  TODO is a different (RobinPad) project state. → CX-Z2, CX-Z4.
- **Every open decision assigned to a named owner + deadline?** No — TODO has "DECISION PENDING", "needs Jamie/team
  sign-off", "Ask 0x BD", none with dates. → CX-Z4.
- **Stale CLI launch scripts?** Confirmed — `demoLaunch.js:18`/`devnetLaunch.js:74`/`devnetV2.js:108` call
  `createLaunch({… fee, sqrtPriceX96, tickLower, tickUpper, graduationTick}, salt)` (pre-curve ABI) and construct
  `LaunchFactory(npm, WETH, locker)` (old 3-arg ctor; current is `(WETH, curve)`). This is **CX-V1 / AUDIT F11** —
  not renumbered. CI never runs them (it runs `rehearse:bonding`), which is why they rot silently.

### CX-Z1 — S3 (certain) — README documents the old single-sided-Uniswap product, not the bonding curve that shipped
**WHERE** `README.md` (whole file, last modified 15 Jul; title "# Launchpad").
**WHAT HAPPENS** A new engineer/auditor/partner reading the repo's front door is told the exact opposite of the
truth: "Every token launches **straight into a single-sided Uniswap V3 position** … **No bonding curve, no
migration step, no token tax**," a "Base Sepolia" quick-start, and `scripts/deploy.js`+`launch.js` on `baseSepolia`.
The shipped system is a shared **bonding curve** with a **2% trade fee**, a **3-second launch tax**, and
**graduation** into V3.
**PROOF** README lines 4–7 and Quick-start block, versus `CensusCurve.sol:44` `FEE_BPS=200`, `:45` snipe tax, and
`deploy.js` (curve stack). AUDIT.md: "The root README still describes the former direct-to-Uniswap design and
should not be used as the system specification." PROVEN; corroborated; **still unfixed**.
**BLAST RADIUS** Onboarding and any external reviewer start from a false mental model; wrong deploy commands invite
mistakes. `package.json` "name"/"description" fields ("launchpad-*", "Single-sided Uniswap V3 launchpad") reinforce
the wrong story.
**WHY** README predates the curve migration and was never rewritten.
**FIX** Rewrite README to the curve/graduation/2%/launch-tax system with correct networks (Robinhood 46630/4663)
and current scripts; fix the package `description` fields. **TEST** Doc-lint/PR checklist: README must reference
`CensusCurve` and must not say "no bonding curve".

### CX-Z2 — S2 (certain) — The fee is 2% in code but 1%/70-30 across the docs; an un-signed-off 2% is hard-coded and asserted as fact
**WHERE** Code: `CensusCurve.sol:44` `FEE_BPS = 200` (2%), `:47` `PROTOCOL_BPS = 2500` (25/75), `deploy.js:11`
`PROTOCOL_FEE_BPS=2500`. Docs: `TESTNET_RUNBOOK.md` ("The 2% fee isn't in this build — testnet runs the current 1%
model"); `TODO.md` ("2% fee needs Uniswap V4 … DECISION PENDING: launch on V3 at 1% … Rec: ship 1% now");
`CENSUS_FEE_MODEL.md` ("Census — today … 1% trade fee … 100% pre-grad / 80% post-grad", recommends **1% / 70-30**);
`deploy.js:5` comment ("un-dodgeable 2% fee") and `MAINNET_RUNBOOK.md §7` ("confirm … curve trading + **2% fee**").
**WHAT HAPPENS** Four human-facing documents say or imply **1%** (with a "needs V4" blocker and a 70/30 rec that the
code doesn't implement), while the live testnet curve **charges 2% flat, split 75/25**, from block one. The megaprompt
§1 states the 2%/75-25 rate is **"proposed, not signed off, and must not be surfaced in the UI until it is"** — yet
it is baked as a `constant` and asserted as fact in the deploy comment and the mainnet runbook's UI check.
`CENSUS_FEE_MODEL.md`'s "today" description is two generations stale (1% + a fee-flip that no longer exists).
**PROOF** Direct quotes above vs `FEE_BPS=200`/`PROTOCOL_BPS=2500`. DERIVED (from source constants) + PROVEN
(doc text). AUDIT.md notes "pre-graduation fee split differs from several historical descriptions in TODO.md".
**BLAST RADIUS** Nobody can trust any fee number in the repo; a governance rate that "must not be surfaced" is
effectively live and documented as shippable; the mainnet runbook would have the operator *confirm* the unsanctioned
2% in the UI. Ties directly to track D's fee-surfacing risk.
**WHY** The curve was moved to 2%/75-25 in code without reconciling the runbooks, TODO, or the fee-model doc, and
without a recorded sign-off.
**FIX** One source of truth: get the rate signed off, encode the decision (and whether it's surfaced) in **one**
doc, and make every other doc + the `deploy.js` comment reference it; if 2% is not signed off, that it's a hard-coded
`constant` is itself the finding. **TEST** A repo check asserting the fee stated in docs == `FEE_BPS`/`PROTOCOL_BPS`
in `CensusCurve.sol`.

### CX-Z3 — S2 (needs setup) — The runbooks fail if followed literally by someone not in the room
**WHERE** `MAINNET_RUNBOOK.md` §3, §5, §7; `TESTNET_RUNBOOK.md` §3–§7.
**WHAT HAPPENS** Line-by-line failures for a fresh operator:
- **MAINNET §3** preflight references `node ../.../scratchpad/verifyMainnetUni.mjs` — a literal `...` placeholder
  path that does not resolve (tribal knowledge; the script isn't in the repo).
- **MAINNET §5** `npx hardhat verify … <CensusCurve> <NPM> <FeeVault> <LaunchLocker> <SwapRouter02>` omits `weth_`
  and mis-orders args (5-arg constructor) → verify fails (same root as CX-V6/F11).
- **MAINNET §7** smoke test runs `scripts/launch.js` + `scripts/curveProof.js`; `launch.js` is the **stale pre-curve
  script** (CX-V1) → reverts against the deployed curve factory.
- **TESTNET §3** relies on `npm run rehearse:robinhoodTestnet` (OK), but **§5–§6** drive launches via `launch.js`/
  `launchV2.js` (stale, CX-V1) and the dividend step needs a `QUOTER_ADDRESS` the testnet Uniswap deploy doesn't
  provide (the runbook itself admits this in a footnote) and a keeper that is **not registered** (`keeper: null`).
- **TESTNET** also states "The 2% fee isn't in this build — testnet runs the current 1% model" — **false** (CX-Z2).
**PROOF** Doc lines vs `demoLaunch.js:18`/`devnetLaunch.js:74` (old ABI), `CensusCurve.sol:154` (5-arg ctor),
`deployments…json` keeper null. PROVEN.
**BLAST RADIUS** A stand-in operator (the whole point of a runbook — CX-V4 bus factor) cannot complete a deploy or
a smoke test by following it; they will improvise on mainnet.
**WHY** Runbooks were written against the earlier scripts/economics and partially updated.
**FIX** Walk both runbooks on a fresh devnet, fix every failing line, replace stale-script steps with the current
lifecycle (`rehearse:*`, the frontend, or new curve-aware scripts), and delete the `...` placeholder. **TEST** A
"runbook rehearsal" checklist run by someone who has never deployed it, on testnet, before mainnet.

### CX-Z4 — S3 (certain) — TODO.md is a different project's plan (RobinPad), lists superseded addresses, and assigns no dated owners
**WHERE** `TODO.md` (title "# RobinPad — Build To-Do"; Phase 0; the 2026-09-07 deploy block; Phase-1 fee note).
**WHAT HAPPENS** The living task list is titled **RobinPad** and encodes a commercial deal Jamie is exiting
(memory: "RobinPad team exit") — "5% equity · 10% fee · $2k now + $2k at first launch", "Move code into the
company/shared GitHub (AFTER the $2k lands)" — although the repo already lives at `adminofcensus/Census-Core-Repo`.
It records **superseded testnet addresses** (Prima `0x54c2…306C0de`, Maxima `0x4e99…C2aC0de`, factories
`0xB3Cf…BbEe`/`0x2FDf…839B` from 2026-09-07) as the deployment, whereas the live set is the 2026-09-17
`deployments…json` (factory `0xf450…10f6`, V2 `0x0B3c…72d2`). It claims "indexer live (board shows both real coins)"
though the indexer is not deployed (UI reads events directly). Open decisions ("DECISION PENDING", "needs Jamie/team
sign-off", "Ask 0x BD") carry **no owner + date**.
**PROOF** `TODO.md` text vs git remote `adminofcensus/Census-Core-Repo`, vs `deployments.robinhoodTestnet.json`
(2026-09-17), vs `VITE_INDEXER_URL` absent from `.env`. PROVEN.
**BLAST RADIUS** Anyone using TODO as the handover truth inherits a stale project identity, wrong live addresses,
and unowned decisions — exactly the doc a covering teammate would trust.
**WHY** TODO was carried over from the RobinPad phase and appended to, never reconciled after the rename, the
GitHub move, the 09-17 redeploy, and the team change.
**FIX** Retitle to Census; strip/relocate the RobinPad deal terms; point address references at the tracked
manifest (CX-V2/V4); give each open item an owner + date; state the indexer's real status. **TEST** none (doc
hygiene) — add to the pre-mainnet doc-consolidation checklist alongside CX-Z1/Z2.

---

## Method / scope notes
- Read in full: `README.md`, `MAINNET_RUNBOOK.md`, `TESTNET_RUNBOOK.md`, `TODO.md`, `AUDIT.md`,
  `CENSUS_FEE_MODEL.md`, `.github/workflows/backend.yml`, `.claude/launch.json`, `deploy.js`, `verifyAll.js`,
  `preflight.js`, all four `package.json`, `vercel.json`, `vite.config.ts`, `bot/src/config.js`, `bot/.env.example`,
  `deployments.robinhoodTestnet.json`, `uniswap.robinhood*.json`, `frontend/.env.example`. Skimmed: `keeperd.js`
  (alert/auth surface), the stale `launch/launchV2/demoLaunch/devnetLaunch/devnetV2` scripts (ABI confirm only),
  `CensusCurve.sol` (constants + access-control + pause grep, not the curve maths — that is tracks A/B/D).
- **NOT independently verified (see `NOT-VERIFIED.md`):** on-chain liveness/bytecode match of the recorded testnet
  addresses (no RPC read performed); that the *live* Vercel bundle equals local `dist/` (would need to fetch the
  site); whether `ALERT_WEBHOOK_URL`/keeper are configured on any running host (none observed in-repo). Secrets were
  named only, never printed; no source modified; read-only throughout.
