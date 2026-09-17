# Census — testnet rehearsal runbook

Goal: stand up the whole platform on **Robinhood Chain testnet (chainId 46630)** and run the full lifecycle end to end — launch a **Prima** and a **Maxima** coin, buy, graduate, pay + claim a stock dividend, and trade — all with **free faucet test ETH, no real money.**

**The one gate:** a funded testnet deployer wallet. Everything else is scripted.

---

## 0. Prereqs (once)
```bash
cd contracts && npm install
cd ../frontend && npm install
cd ../bot && npm install
```

## 1. Fund a throwaway deployer wallet
Make a fresh wallet (not your personal/treasury one — it only needs gas). Get its address, then claim test ETH:
- Faucet: **https://faucet.testnet.chain.robinhood.com**

## 2. Put the key in `contracts/.env` (gitignored — never commit, never paste in chat)
```
PRIVATE_KEY=0xyour_throwaway_testnet_key
ROBINHOOD_TESTNET_RPC_URL=https://rpc.testnet.chain.robinhood.com
```

## 3. Deploy everything — one command
The testnet has no chain-wide Uniswap, so this deploys our own Uniswap V3 **and** both Census stacks (Prima + Maxima), then prints the addresses:
```bash
cd contracts && npm run rehearse:robinhoodTestnet
```
It writes `uniswap.robinhoodTestnet.json` + `deployments.robinhoodTestnet.json` and prints a `Paste into frontend/.env` block. Copy it.

## 4. Point the frontend at testnet — `frontend/.env`
Paste the printed addresses, plus the chain + the Uniswap WETH/router from `contracts/uniswap.robinhoodTestnet.json`:
```
VITE_CHAIN_ID=46630
VITE_RPC_URL=https://rpc.testnet.chain.robinhood.com
VITE_FACTORY_ADDRESS=0x…        # printed by step 3
VITE_FACTORY_V2_ADDRESS=0x…     # printed by step 3 (Maxima)
VITE_LOCKER_ADDRESS=0x…         # printed by step 3
VITE_WETH=0x…                   # uniswap.robinhoodTestnet.json -> WETH
VITE_SWAP_ROUTER=0x…            # uniswap.robinhoodTestnet.json -> SwapRouter02
```

## 5. Run the app
```bash
cd frontend && npm run dev
```
Open http://localhost:5173, connect the wallet (fund it with a little faucet ETH too), and:
- **Launch a Prima coin** (`/create`, Prima tab) → confirm → lands on its coin page.
- **Launch a Maxima coin** (Maxima tab, pick 1–4 stocks) → confirm. This calls `LaunchFactoryV2.createLaunch` with the basket + routes.
- **Buy** on the coin page (0x if it has a route, else the pool), push it past ~$60k mcap to **graduate**.
- **Trade** (buy/sell) to generate fees.

## 6. Pay the Maxima dividend (the keeper)
Grab the new vault address from the `LaunchedV2` event (or `deployments`/explorer), then in `bot/.env`:
```
RPC_URL=https://rpc.testnet.chain.robinhood.com
CHAIN_ID=46630
PRIVATE_KEY=0x…        # the creator/operator wallet
VAULT_ADDRESS=0x…      # the Maxima coin's DividendVault
MODE=uniswap           # 0x blocks tokenised stocks; use the Uniswap path on testnet
DRY_RUN=true           # flip to false to execute
```
```bash
cd bot && npm run keeper0x:dry     # shows the plan; then DRY_RUN=false npm run keeper0x:dry to execute
```
Then **claim** on the coin page — the stocks land in the holder's wallet.

> Note: the LIVE Uniswap path wants a `QUOTER_ADDRESS` for slippage. Our testnet Uniswap deploy doesn't include a QuoterV2, so for the rehearsal either deploy one and set `QUOTER_ADDRESS`, or run a one-off `distribute([0,…])` (testnet only — no MEV to worry about).

## 7. Verify the contracts on Blockscout (optional)
```bash
cd contracts && npm run verify:robinhoodTestnet
```

---

### Not needed for the testnet rehearsal
- **0x coin-trading** needs the serverless proxy (`ZEROX_API_KEY` on Vercel, or `vercel dev` locally). On testnet, trading falls back to the pool automatically, so you can skip it.
- **The 2% fee is already in this build** — the curve charges a flat 2% (`CensusCurve.FEE_BPS = 200`), split 25% protocol / 75% creator side, on testnet exactly as on mainnet (plus the buy-only launch tax that decays over 3 s). Nothing to configure; you can watch the protocol cut land in the treasury during the rehearsal. No Uniswap fee tier or token tax is involved — all trading is on the curve, so the fee is un-dodgeable.

### Then mainnet
Same flow with `:robinhood` scripts (`deploy:robinhood`), a **mainnet** deployer wallet with a little real ETH for gas, and the mainnet `frontend/.env`. Do this only **after the audit**.
