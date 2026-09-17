# Census Core Repo: production-readiness audit

**Repository:** `adminofcensus/Census-Core-Repo` (private)  
**Reviewed commit:** `a2ffb81a27c183e94401dabce9f7adc7161a0c3e` (`main`)  
**Review date:** 17 September 2026  
**Scope:** contracts, deployment, frontend trading paths, indexer, keeper, APIs, operational readiness, product disclosures, and external-liquidity behaviour.

## Verdict

**Do not deploy with public, real funds yet.** The core curve and graduation design is substantially more mature than a prototype, and the current commit's CI is green. The remaining issues are chiefly production controls, accuracy, and fairness. Several can be closed quickly, but they require explicit team decisions and a staged deployment rather than another round of cosmetic work.

There is no production deployment artifact in the repository. That is good: the issues below can be closed before addresses and custody become irreversible.

## Evidence verified

* GitHub Actions' [`backend` run](https://github.com/adminofcensus/Census-Core-Repo/actions/runs/35275544211) passed on the reviewed commit. It compiled and tested contracts, exercised the bonding lifecycle rehearsal, checked token bytecode/client parity, checked indexer parity from contract events, ran indexer type/unit/PostgreSQL recovery tests, ran keeper tests, and type-checked and tested metadata/upload APIs.
* The latest two security fixes are present and covered by tests:

  * CREATE2 vanity salts are bound to the creator address, preventing a mempool watcher from stealing another launcher's intended `…c0de` address.
  * Graduated-pool display pricing is TWAP-first, graduation increases the Uniswap oracle observation capacity, and the trade UI blocks a direct-pool trade when spot differs from the TWAP by more than 10%.
* The contract model matches the intended Pump.fun-style supply treatment: 1 billion real tokens, a virtual token reserve used only by curve math, no dead/burned surplus at graduation, and a continuous graduation price.
* Curve buys and sells use the on-chain 2% curve fee. The 99% launch tax exists for non-exempt buyers at launch and decays rapidly over the three-second window. The graduated Uniswap V3 pool uses the 1% fee tier.

Local `npm ci` reruns were not treated as evidence because Windows/OneDrive file locks interrupted dependency installation. The clean Linux CI run above is the reliable automated-test evidence for this commit.

## Release blockers

|Priority|Finding|Why it matters|Required resolution|
|-|-|-|-|
|P0|**Mainnet treasury can silently be a deployer-controlled `FeeVault`.** `contracts/scripts/deploy.js` only uses an immutable `FeeSplitter` when optional `FEE\_SPLIT\_A` and `FEE\_SPLIT\_B` environment values are set.|A production deployment could permanently route all protocol fees through one EOA.|Change the deployment script to fail on mainnet unless the treasury is an approved multisig or immutable splitter. Record beneficiaries and bps in the deployment artifact; deploy from secured multisig custody.|
|P0|**Keeper has protocol-wide price-bound authority.** The keeper can call dividend conversion/distribution across Maxima vaults and supplies `minOut` values. The contracts pin the spender and reset allowances, which is good, but a compromised keeper can choose poor bounds and expose pending dividends to MEV.|One operational key can harm every active holder-reward vault.|Use a dedicated hardware-backed key or multisig process, set a strict quoting/TWAP policy, alert on every keeper action, and rehearse revoke/rotation before launch. Do not run the legacy `bot/src/index.js` or `bot/src/buyback.js`: both use `amountOutMinimum: 0`.|
|P0|**Holder economics and insider launch fairness need a decision.** The creator and up to 32 declared bundle wallets are exempt from the launch tax and have no size cap; public buyers begin at a 99% total fee. The frontend submits an empty bundle today, but the contract makes the privileged allocation available.|This can be perceived as an undisclosed insider allocation and undermines the anti-snipe story.|Before deployment, choose one: remove/cap exemptions, vest exempt allocations, or disclose the exact creator/bundle allocation and exempt addresses prominently for every launch. Publish the real fee schedule: roughly 99%, 8.18%, 2.19%, then 2% across the three seconds, rather than saying simply "99% for three seconds."|
|P0|**Legal, risk, privacy, and impersonation controls are absent.** There are no Terms, Privacy, risk disclosure, or practical report/removal path. The product language around company-linked tokens, stocks, dividends, and “launching companies” needs legal review; Privy introduces personal-data handling.|This is a launch blocker for a retail-facing, company-linked financial product.|Obtain written counsel review; implement terms/privacy/risk pages, consent and deletion procedures, a clear non-affiliation/market-risk disclosure, and impersonation reporting/blocklist operations.|
|P0|**No incident response path exists for immutable contracts.** There is no pause or kill switch, so an exploit cannot be halted on chain.|The response must be prepared before value is locked.|Create reserve/solvency, pool-price, keeper-action, RPC, and API-spend alerts; publish a status page; document owner keys, escalation contacts, and an independent way users can sell/trade if the frontend fails.|
|P0|**Production indexer cannot yet be enabled safely.** It prices WETH with a fixed ETH/USD value and assigns non-WETH anchors, including HOOD, a USD value of zero. Without `VITE\_INDEXER\_URL`, the client scans events from block zero.|Enabling it makes displayed USD prices/market caps wrong; leaving it off will become slow and expensive as launches grow.|Deploy/stage the indexer, replace placeholder pricing with live reliable feeds/on-chain pricing, set a real start block and exact CORS origin, verify reorg/restart behaviour, then set `VITE\_INDEXER\_URL`.|
|P0|**Public API cost-abuse controls are missing.** `/api/zeroex` and metadata writes are unauthenticated/unthrottled; uploads only have a per-wallet quota, which is easy to sybil.|Attackers can exhaust the 0x key, RPC allowance, KV/Blob storage, or Vercel budget.|Add per-IP and per-wallet rate limits, request size/cost limits, a WAF/spend alert, an exact production CORS policy, and a second RPC provider. Keep private RPC/API keys out of `VITE\_` variables.|
|P0|**Mainnet dependencies are configured, not proven.** Graduation and the non-WETH zap rely on chain-specific V3 factory/NPM/router addresses, fee tiers, and the WETH→USDG→HOOD route.|A wrong address, inactive tier, or shallow route breaks graduation or trades with real funds.|Run a mainnet-fork lifecycle test or read-only preflight against the actual Robinhood Chain RPC, then a capped canary launch. Verify all contract source code on the explorer before opening launches.|

## Important fixes before public traffic

### Direct post-graduation swaps use an output estimate that ignores price impact

`frontend/src/lib/pool.ts` calculates direct-pool output from the current spot price and pool fee, then deliberately ignores price impact. `Coin.tsx` applies a fixed 2% minimum-output buffer. In a newly graduated, shallow full-range pool, a normal 0.1 ETH or larger trade can exceed 2% price impact and revert even when liquidity is healthy. The TWAP deviation guard helps against manipulation; it does not solve ordinary price impact.

**Fix:** quote the actual route with a Quoter/0x simulation, apply a visible user-selected slippage tolerance to that exact quote, and add integration tests for the UI presets (`0.01`, `0.1`, `0.5`, `1`) immediately after graduation. Treat a quote failure as a clear UI state, never as a zero-impact estimate.

### The code and public explanation still disagree about fees

The curve has a 2% fee, split 25% protocol / 75% creator-side. A graduated pool is a separate Uniswap V3 1% pool fee, where the locked LP position earns its share; external LPs can share that V3 fee. Some launch-flow copy and testnet documentation say every trade pays 2%, while older documentation contains 1% and older model language.

**Fix:** approve one written economics specification and update the website, whitepaper, testnet/mainnet runbooks, and creator materials from it. The trade page should distinguish curve fees, graduated-pool fees, holder reward eligibility, and all launch tax effects.

### External liquidity cannot be forced to pay Census fees

Because launch tokens are transferable, anyone can create another liquidity pool. After graduation, aggregators may choose any external pool with better execution. Those trades do not pay the curve fee or the canonical locked LP's fee, and external liquidity also dilutes fee share if added to the same canonical V3 pool. This is a market-structure fact, not an implementation bug that can be fully patched without making the token non-transferable or otherwise restricting it.

**Required product decision:** describe the canonical pool in the UI, preferentially route through it where appropriate, show execution venue, monitor alternate pools, and never promise that every trade funds creator/holder rewards. Do not portray external-pool activity as missing accounting that can necessarily be recovered.

### Configuration and build integrity need a production check

The frontend defaults to mainnet chain settings but accepts zero contract addresses when environment variables are missing. CI type-checks the frontend but does not run `vite build` with a production configuration. The root README and portions of the runbooks describe superseded architecture or fee behavior.

**Fix:** add a build-time production configuration assertion, make CI run `vite build` and lint, commit a non-secret deployment manifest or derive it from a verified artifact, and bring README/runbooks/whitepaper in line with the deployed system. Have a second person reproduce the release build from scratch.

## Residual risks to accept explicitly

* Fresh pools use spot fallback while their TWAP history warms. This is a short initial manipulation window. Measure real liquidity and tune the 30/120-second TWAP windows and 10% guard after the canary.
* The contracts are immutable and owner controls remain with the deployer for factory authorization, keeper setting, quote allowlisting, zap paths, and migration-dust sweep. Secure, documented multisig custody and a backup recovery procedure are mandatory.
* A malicious third party can use confusing names/tickers or host an off-platform image URL. Add duplicate-name warnings, image-host restrictions/proxying where practical, reporting, and moderation procedures.
* The frontend has untested Privy, WalletConnect, iOS Safari, and social in-app-browser flows. Run an actual-wallet/device matrix before marketing traffic.
* There is strong scripted test coverage, but no evidence of a completed independent external smart-contract audit or fuzz/invariant campaign. For meaningful TVL, commission one and add invariant tests for curve conservation and dividend-vault solvency.

## Recommended launch sequence

1. **Today:** decide treasury beneficiaries/bps, keeper custody, creator/bundle policy, fee specification, allowed quotes, zap routes, and launch limits. Assign one named owner and due time to each P0 item.
2. **Before deployment:** enforce the mainnet treasury guard in code; add API limits; fix indexer pricing; fix exact post-graduation quoting; update all docs/copy; complete legal and privacy work.
3. **Staging:** run mainnet-fork preflight, deploy indexer and frontend staging with production-like configuration, test wallet/device matrix, load-test APIs, and rehearse keeper/incident/key-rotation procedures.
4. **Canary:** deploy verified contracts from multisig custody, launch one low-cap test asset with a pre-announced risk statement, monitor curve/graduation/trades/indexer/alerts through the first full lifecycle.
5. **Open launchpad:** only after the canary and release checklist produce evidence for every P0 gate.

## Bottom-line assessment

The core contract work is in a credible position for a controlled staging and canary. It is **not** ready for broad public mainnet launches until custody, fairness, fee communication, live infrastructure, external-liquidity disclosure, and the direct-pool execution path are resolved and tested in the real target environment.

