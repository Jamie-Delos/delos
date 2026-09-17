# Money map — every wei of a trade to its resting place

Constants (verified in source): trade fee **2%** (`FEE_BPS=200`), protocol share of the fee **25%**
(`PROTOCOL_BPS=2500`), creator side **75%**, split to holders by per-coin `holdersBps`. Post-graduation
LP fee protocol share **25%** (`PROTOCOL_FEE_BPS=2500`, deploy). Launch tax replaces the 2% with up to
99% for ~3 s but follows the *same* split. `platform` and the locker's `feeVault` are both the deploy
`treasury` (FeeSplitter on mainnet, else FeeVault).

## 1. Pre-graduation BUY of `quoteIn` on a V2 coin (holdersBps = H)

```
quoteIn
├─ refund           = max(0, quoteIn − maxBuy)                → back to buyer (native if WETH buy)
└─ accepted (Q)
   ├─ fee   = Q · feeBps/10000            (feeBps = 200, or up to 9900 in the launch window)
   │  ├─ 25%    = protocol                → platform (treasury)                 [_distributeFee:301,305]
   │  └─ 75%    = creator side
   │     ├─ ·H/10000     = holders        → DividendVault (quote asset)         [:303,306]
   │     └─ remainder    = creator        → creator EOA                         [:304,307]
   └─ netIn = Q − fee                      → stays in curve as realQuote (backs the curve)
                                              and seeds the graduation LP later
```
Sum of the fee legs = fee exactly (creator leg absorbs rounding). If a recipient can't receive
(quote blacklist/pause) its leg is held in `deferredFee` and pushed later — trading never halts
(`_payFee:312-317`). **Prima (V1):** identical but `holdersBps=0`, so the whole 75% → creator.

## 2. Pre-graduation SELL of `tokensIn`

```
quoteGross = curve payout (≤ realQuote)
├─ fee 2%  → split 25/75/H exactly as above         [_sell:442-443]
└─ quoteOut = quoteGross − fee                        → seller
```
Fee here is always 2% (no launch tax on sells). `realQuote`/`virtualQuote` both decrease by
`quoteGross`, preserving `virtualQuote − realQuote = V0`.

## 3. AT graduation (permissionless `graduate`)

```
curve holds:  tokenReserve (T)  +  realQuote (R = graduationQuote)
│
├─ (if pool pre-mispriced) bounded recovery swap ≤10% of one leg, at the griefer's expense
│     proceeds/leftover → migrationTokenDust / migrationQuoteDust  (per coin)
├─ mint full-range V3 position at the curve price → NFT to LaunchLocker (locked forever)
│     amount0/amount1 consumed ≈ T and R (both fully, up to rounding)
└─ leftovers → migrationTokenDust/migrationQuoteDust → sweepMigrationDust → platform ONLY
      creator receives 0 at graduation (asserted: audit.repro "creator weth delta == 0")
```
No party can inflate the leftover into a refund; the pool is always minted at the curve price or
graduation fails closed (F01 closed).

## 4. Post-graduation LP swap fees (Uniswap V3, collected via `LaunchLocker.collectFees`, permissionless)

For a curve-graduated position (`curvePosition=true`, `graduated` latched true), per fee asset amount `a`:
```
a
├─ protocol   = a · 2500/10000              → feeVault (treasury)      [LaunchLocker:150,164]
└─ creator side = a · 7500/10000
   ├─ holders = creatorSide · holdersBps/10000 → DividendVault (lock.feeRecipient) [:156-162]
   └─ creator = remainder                       → creator EOA          [:166-167]
```
This reproduces the curve-era split (25 protocol / 75 creator-side, split by `holdersBps`) **because
`PROTOCOL_FEE_BPS == PROTOCOL_BPS == 2500`.** With `holdersBps=10000`: 25 protocol / 75 holders / 0
creator (asserted, holders = 3× platform). The launch-token side of LP fees reaching the vault is
sold to quote by the operator (`convertLaunchFees`) to fund the next distribution.

## 5. DividendVault → holders (operator/keeper calls `distribute` / `distributeVia0x`, then anyone `claim`s)

```
availableQuote (unreserved WETH/quote)
└─ per basket stock i:  portion = available · weights[i]/10000
   ├─ if stock == quote:  credited straight (anchor-paid), reserved[quote] += portion
   └─ else: swap quote→stock (minOut supplied by operator), reserved[stock] += got
   accPerShare[stock] += got·1e18 / eligibleSupply     → pro-rata to holders held-during-distribution
claim(): pays each holder settled+accrued − withdrawn, reserved[stock] -= amt; a frozen stock defers
          only its own leg (ClaimDeferred), never bricks the basket.
```
Reserved value can never fund another distribution (`availableQuote` excludes it) — F02 closed.
`eligibleSupply = totalSupply − Σ excluded {vault, curve, factory, dead, graduated pool}`.

## Where value can leave the system to a *privileged* party (the trust surface)

| Party | Gets | Bounded by | Can reach curve principal? |
|-------|------|-----------|----------------------------|
| platform/treasury | 25% of fees + 25% of LP fees + swept dust | immutable split | no |
| creator | ≤75% of fees + LP creator share + own trades | `holdersBps` | no (only via own buys/sells) |
| keeper (operator) | nothing directly; **chooses `minOut`** on distributions | trust / off-chain | no — only MEV on *pending* dividends (CX-G1) |
| deployer | `sweepMigrationDust`→platform; admin setters | immutable `platform`; no withdraw fn | **no** (verified: no path to `realQuote`) |

The single most important structural fact: **there is no function anywhere that lets any privileged
role withdraw a curve's `realQuote`.** Curve principal only moves via the buy/sell/graduate maths.
