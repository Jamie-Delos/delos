# Jamie hand-off — 17 September 2026

Branch: `codex/backend-launch-readiness`. Implementation candidate for review; no public deployment or existing-contract upgrade has been performed.

## Changes since `dda7794`

- **PF-style graduation:** 1B real supply, an unminted virtual token offset in the pricing formula, and continuous marginal price into the locked V3 pool. Default economics sell approximately 785.714M tokens through the curve and place 214.286M in liquidity with 4 ETH. No economic surplus is burned or permanently parked; only bounded rounding dust remains. Oversized final buys are partially filled and unused input refunded.
- **Launch window:** no wallet cap, cumulative buy cap or launch-block rejection. Buy fees decay over three seconds: **99%, 8.18%, 2.19%, then 2%**, including the normal 2%. This uses Pons' verified-source fourteen-halving schedule and combined 99% ceiling. Sells stay at 2%. Creator and up to 32 declared bundle wallets are exempt from the extra tax; exemptions cannot be added later. Penalty revenue follows Census' existing platform/creator/holder split.
- **Integration:** buyer-specific curve quotes and displayed fees, updated indexer reserve/price math, additive virtual-token-offset migration, and repeatable lifecycle/fee/parity checks in CI. The launch entrypoint signatures and token creation bytecode remain unchanged.

Review the final branch state: `498e2d5` only removed the 1% cap and was superseded by `d13f3d0`, which removes the remaining restrictions and adds the launch tax. `fc83c8f` contains the PF math; `3c7a65e` records the latest lifecycle results. Earlier backend repairs remain included in this branch; their status is in `REPAIR-STATUS.md`.

## Validation on the launch-tax implementation

- **95 local contract tests passed; 3 opt-in fork tests pending.** Covers native/ERC20/zap buys, sales, launch-second transactions, each decay boundary, exemptions, taxed final-fill refunds, slippage rollback, reserve accounting, holder payouts and graduation recovery.
- **Three full local lifecycles passed:** Prima, Maxima with full holder allocation, and Maxima with a 50/50 creator-side split. Each buys/sells on the curve, graduates, trades both ways through real V3 bytecode, collects fees and reconciles balances; Maxima also pays holder rewards.
- **Indexer parity passed:** 121 standard actual contract trades plus taxed final-fill events from both launch types reproduce reserves and price exactly.
- Frontend TypeScript, token creation-bytecode parity and EIP-170 contract-size checks passed.

The earlier PF-only revision also passed a local mainnet-dependency fork and PostgreSQL recovery/load checks. Those are earlier validation, not a claim that the final launch-tax revision was re-run against production infrastructure. GitHub CI status must be checked separately after the push.

## Review and release requirements

Please review the new reserve math and rounding, the buyer-dependent final-fill cap, tax/exemption policy, and migration/deployment wiring. Creator/bundle exemptions intentionally permit untaxed opening buys; external pools can still bypass Census fee collection. Hostile-pool recovery remains bounded and can fail closed. These changes do not resolve those external-market limitations.

This requires a matching **new curve and both factories**, plus coordinated client/indexer/keeper addresses. Existing immutable deployments retain their original behaviour. Apply `20260917000000_virtual_token_offset` and regenerate Prisma; do not repoint an old indexer cursor/database at a new deployment without a verified ingestion plan. Real issuer assets, live 0x routing, production RPC/keeper/custody, production database restore and the existing-funds inventory remain release gates in `REPAIR-STATUS.md`.

## Read / reproduce

- [PF reserve math and migration](PF-GRADUATION.md)
- [Launch-tax policy, source evidence and integration](EARLY-BUY-POLICY.md)
- [Transaction-by-transaction lifecycle report](BONDING-LIFECYCLE-RESULTS.md)
- [Earlier backend repair status and open release gates](REPAIR-STATUS.md)

From `contracts`, after installing dependencies in `contracts` and `indexer`:

```sh
npm test
node scripts/exportTokenBytecode.js --check
npm run rehearse:bonding
node ../indexer/pf.parity.cjs
node ../indexer/pf.parity.cjs .test-build/launch-tax-events-prima.json
node ../indexer/pf.parity.cjs .test-build/launch-tax-events-maxima.json
```

From `frontend`: `npm run typecheck`. The rehearsal uses only an isolated local Hardhat chain and fake funds.
