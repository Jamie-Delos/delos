# Census

A token launchpad built on a shared **bonding curve** that graduates filled coins into
**permanently-locked Uniswap V3 liquidity**. Own-brand rebuild of the NOXA Fun mechanics.

Every coin launches its **whole fixed supply straight onto the shared `CensusCurve`** — there is no
DEX pool at launch, so *all* early trading happens on the curve (which is why the fee is
un-dodgeable). When a coin fills its graduation reserve, the curve migrates the tokens plus the
raised quote into a Uniswap V3 pool whose LP NFT is **locked forever** in the `LaunchLocker`; only
*fees* can ever be collected after that. Every Census token address ends in `…c0de` (a CREATE2
vanity salt bound to the creator).

## Fee model

- **2% trade fee** (`CensusCurve.FEE_BPS = 200`) on every curve buy and sell.
- Split **25% protocol / 75% creator side** (`PROTOCOL_BPS = 2500`). On Maxima the creator side is
  further split between the creator and holders by the coin's `holdersBps`; on Prima `holdersBps = 0`,
  so the whole 75% goes to the creator.
- A **buy-only launch penalty** (anti-snipe) starts near 99% and **decays to 0 over 3 seconds**
  (`SNIPE_TAX_SECONDS = 3`), following the same split. The creator and any declared bundle wallets
  are exempt.
- Post-graduation Uniswap V3 LP fees are collected through the `LaunchLocker` on the *same*
  25/75 split (`PROTOCOL_FEE_BPS = 2500`).

## Two flavours

- **Prima** = `LaunchFactory` — a plain coin. The creator side of every fee goes to the creator.
- **Maxima** = `LaunchFactoryV2` — the same curve launch, but each coin also gets its own
  `DividendVault`. The holders' share of the fees buys a weighted basket of **tokenised stocks** and
  pays it out **pro-rata to holders** (an operator/keeper calls `distribute`; anyone can then
  `claim`). Prima and Maxima share one curve, one locker and one treasury.

## Chain

**Robinhood Chain** — an Arbitrum Orbit L2 with ETH gas. Mainnet `chainId 4663`, testnet
`chainId 46630`. Uniswap V3 (for the graduated pools) is live on-chain; testnet stands up its own
Uniswap V3 as part of the rehearsal.

## Repo layout (monorepo)

```
Census/
  contracts/   Hardhat — CensusCurve, LaunchFactory (Prima), LaunchFactoryV2 (Maxima),
               DividendVault, LaunchLocker, FeeVault/FeeSplitter, LaunchToken; deploy.js wires them
  frontend/    React/Vite dApp — launch wizard (/create), board, coin page (curve trade / graduated
               pool), portfolio
  bot/         Keeper — converts curve/LP fees and distributes the Maxima stock-dividend baskets
  indexer/     Postgres/Prisma + viem event indexer for the board (optional; the board reads the
               chain directly until VITE_INDEXER_URL is set)
  audit/       FULL-AUDIT-2026-09-17 — findings, money map, and the mainnet go/no-go GATES
```

## How a launch works

1. `LaunchFactory.createLaunch(params, salt)` (or `LaunchFactoryV2.createLaunch(params, basket,
   weights, paths, salt)`) deploys a fixed-supply `LaunchToken` at a `…c0de` CREATE2 address and mints
   the whole supply to the factory.
2. The factory transfers the entire supply to the `CensusCurve` and registers the coin (with its
   `virtualQuote`, `graduationQuote`, pool fee tier, and — on Maxima — its `DividendVault` and basket).
   The 3-second launch tax window arms on registration.
3. Buyers trade on the curve (2% fee, split 25/75). The net quote accumulates as the curve's real
   reserve, which backs the price and seeds the future pool.
4. Once `realQuote` reaches `graduationQuote`, anyone can call `CensusCurve.graduate(coin)`: it mints a
   full-range Uniswap V3 position at the curve price and sends the **LP NFT to the `LaunchLocker`,
   locked forever**.
5. `LaunchLocker.collectFees(tokenId)` (permissionless) sweeps the graduated pool's swap fees on the
   25/75 split. On Maxima the keeper converts the holders' share and the vault pays the stock basket.

## Deploy

Everything is deployed and wired by one script — `contracts/scripts/deploy.js` (FeeVault/FeeSplitter →
LaunchLocker → CensusCurve → LaunchFactory + LaunchFactoryV2):

```bash
cd contracts
npm install
cp .env.example .env            # add PRIVATE_KEY + the target network's RPC URL
npx hardhat compile
npx hardhat run scripts/deploy.js --network robinhoodTestnet   # or robinhood (mainnet)
```

- **Testnet, end to end:** see [`TESTNET_RUNBOOK.md`](TESTNET_RUNBOOK.md) (stands up Uniswap V3 + both
  stacks, launches a Prima and a Maxima coin, buys, graduates, pays + claims a stock dividend — all on
  free faucet ETH).
- **Mainnet:** see [`MAINNET_RUNBOOK.md`](MAINNET_RUNBOOK.md), and clear the go/no-go gates in
  [`audit/FULL-AUDIT-2026-09-17/GATES.md`](audit/FULL-AUDIT-2026-09-17/GATES.md) first.

## Launch a coin

- **Frontend wizard** (the working path users take): `cd frontend && npm run dev`, then open `/create`
  and pick Prima or Maxima.
- **Scripted demo:** `npx hardhat run scripts/demoLaunch.js --network <net>` populates the board with a
  few Prima coins (current curve ABI, `…c0de` addresses, one small buy so the first coin shows a price).
- **Curve smoke test:** `npx hardhat run scripts/curveProof.js --network <net>` launches a Prima coin
  and does a small curve buy, confirming the 2% fee (25% of it) lands in the treasury.
