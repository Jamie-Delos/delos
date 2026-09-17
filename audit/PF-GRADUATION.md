# PF-style graduation — 2026-09-17

Implements the team's approved PF-style pricing on top of `dda7794`. Intended for a new deployment;
existing immutable contracts do not change. No public transactions, deployment, or GitHub push.

## Economics

Let `S` be the real minted supply, `V0` the initial virtual quote reserve and `G` the net quote target.
The fixed, unminted token offset is:

```
X = S * V0^2 / (G * (G + 2*V0))
k = (real token reserve + X) * (real quote reserve + V0)
```

At graduation, `G / realTokens = (G + V0) / (realTokens + X)` in exact arithmetic.
The token fraction entering liquidity is `V0 / (G + 2*V0)`; no hardcoded allocation is used.
Solidity computes X using two full-precision divisions, rounding down by less than 1.5 token base units
relative to the rational formula. Trade rounding increases k; tests bound the resulting price difference.

With standard supply 1B, V0=1.5 ETH and G=4 ETH:

| Quantity | Approximate value |
| --- | --- |
| Real minted supply | 1,000,000,000 tokens |
| Unminted pricing offset | 80,357,142.857143 tokens |
| Sold through curve | 785,714,285.714286 tokens |
| Real tokens entering liquidity | 214,285,714.285714 tokens |
| Initial FDV | 1.388429752066 ETH |
| Net quote entering liquidity | 4 ETH |

Supply remains real and unchanged for Prima and Maxima. There is no economic surplus burned or parked
permanently outside circulation. The liquidity NFT remains permanently locked; its underlying tokens
can be purchased from the pool. V3 integer/finite-range rounding can leave tiny recorded, sweepable
dust. Existing hostile-pool recovery can also produce a surplus; its prior accounting and permissions
remain in place. This is PF-style reserve sizing, not a reproduction of another platform's contracts.

## Threshold and refunds

- Buys accept at most the gross input whose net contribution fills G exactly. Fee rounding is included.
- `maxQuoteIn(coin)` exposes that limit; `quoteBuy` quotes the same capped fill.
- Excess direct ERC20 input returns in the quote token. Excess ETH on a WETH curve returns as native ETH.
- For an ETH-to-non-WETH zap, the upstream swap already executed; excess returns in the quote token,
  without another reverse swap. Upstream swap fees are not refunded.
- `Traded.amountIn` and `fee` describe only the accepted input; `BuyRefunded` records returned funds.
- `minTokensOut` still guards the actual partial fill. If it cannot be met, the entire transaction reverts.
- At G, further buys revert `CurveFilled`. Sells remain possible until graduation and reopen capacity.
- Graduation remains permissionless and explicitly triggered; a too-deep hostile pool still fails closed.

## Integration and deployment

- `curves()` retains its 11-field return tuple, preserving keeper and metadata readers.
- New getter: `virtualTokenOffset(coin)`. Spot price is V / (realTokens + X), not V / realTokens.
- `Registered` now includes the offset as its last argument, changing its event topic. The indexer
  recognizes both old and new signatures. Legacy records/events keep offset zero.
- Apply `20260917000000_virtual_token_offset` and regenerate Prisma before running the new indexer.
  It is additive and defaults historical rows to zero. Each database still tracks one curve deployment;
  do not repoint an old cursor/database to a new address without a fresh verified ingestion setup.
- Point clients, indexer, keeper and factories at the verified new deployment together. The application
  pricing readers use the offset and hide their price estimate if it cannot be read; they do not guess.
- Frontend edits only adapt ABI/pricing calculations and comments. No visual redesign is included.
- Fees, keeper authority, deferred payments, recovery limits and dust-sweep custody are unchanged.

## Validation

- Full contracts: 78 passing, 3 opt-in/legacy fork cases pending.
- Explicit mainnet-dependency local fork: 1 passing at block 65,273,142; no public transactions.
- PF regressions cover both factory types, unchanged supply, price continuity, native/ERC20/zap refunds,
  min-out rollback, the final quote wei, sell/rebuy, multiple V0/G configurations and six-decimal quote.
- 120 mixed trades match an independent integer model, followed by a capped final buy. All 121 actual
  contract trade events reproduce exact indexer reserves and offset-aware price. Both event topics decode.
- Existing recovery, fee-backing, dividend, external-market and company-pair tests remain enabled.
- Token bytecode parity and deployment-size checks pass; keeper checks and indexer in-memory checks pass.
- Real PostgreSQL migration/replay/crash/load validation and final typechecks are recorded in REPAIR-STATUS.

The new tests caught and fixed Q192 overflow for a valid reverse-oriented 18/6-decimal pair. High ratios
now use Q128 followed by a 32-bit shift of the square root; normal ratios retain Q192 precision.

Jamie must review this economic/contract diff before deployment. Real issuer behavior, live 0x execution,
production feeds/RPC/custody, production restore rehearsal and the existing-funds inventory remain the
separate release gates listed in REPAIR-STATUS. A local green test suite does not close those gates.
