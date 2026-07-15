# Launchpad

A single-sided Uniswap V3 token launchpad — an own-brand, from-scratch rebuild of the NOXA Fun mechanics.

Every token launches **straight into a single-sided Uniswap V3 position** (all token, no quote asset).
The LP NFT is **locked forever** in the `LaunchLocker`; only *fees* can ever be collected, split between
the token creator and the protocol. No bonding curve, no migration step, no token tax.

## Repo layout (monorepo)

```
Launchpad/
  contracts/   Hardhat project — the on-chain engine (Factory, Token, Locker, FeeVault)   <-- built
  frontend/    React/Vite dApp (launch form, token page, trade, claim fees)               <-- next
  bot/         Reward/airdrop worker (claim creator fees -> buy reward token -> airdrop)   <-- next
```

## How a launch works

1. `LaunchFactory.createLaunch(...)` deploys a fixed-supply ERC-20 (`LaunchToken`) and mints the whole
   supply to the factory.
2. The factory creates + initializes the Uniswap V3 pool `TOKEN/WETH` at a chosen starting price.
3. It mints a **single-sided** V3 position: 100% of the token supply, 0 WETH, in a tick range placed
   entirely on the sell side of the starting price. As buyers push the price through the range, the
   position sells TOKEN for WETH — that WETH accrues to the locked position as tradable liquidity.
4. The LP NFT is sent to the `LaunchLocker`, which records the creator. The NFT can never be withdrawn.
5. Anyone can call `LaunchLocker.collectFees(tokenId)` to sweep accumulated V3 swap fees; the vault
   takes a protocol cut and the rest goes to the creator.

## Status / roadmap ("rinse and repeat")

- [x] **Iteration 1 — on-chain engine**: Factory, Token, Locker, FeeVault + Base Sepolia deploy/launch scripts. *(compiles; 4 unit tests pass)*
- [x] **Iteration 2 — tests**: Base-fork integration test of a full launch + buy + fee claim. *(passes: creator 0.00135 / vault 0.00015 WETH on a 0.5 WETH buy)*
- [x] **Iteration 3 — frontend**: `frontend/` Vite + React + wagmi/viem dApp — wallet connect, launch form, explore/buy/claim. *(builds clean)*
- [x] **Iteration 4 — reward bot**: `bot/` claim fees → buy reward token → proportional airdrop, `DRY_RUN=true` by default. *(installs; syntax-clean)*
- [ ] **Iteration 5 — testnet deploy**: needs a funded Base Sepolia key in `contracts/.env`; then deploy + live launch + wire the frontend `.env`.
- [ ] **Iteration 6 — mainnet**: after full testnet validation, deploy to a mainnet with Uniswap V3.

## Run the integration test (no wallet needed)

```bash
cd contracts
BASE_FORK_RPC_URL=https://mainnet.base.org npx hardhat test test/integration.fork.test.js
```

## Run the frontend

```bash
cd frontend && npm install
cp .env.example .env   # fill VITE_FACTORY_ADDRESS / VITE_LOCKER_ADDRESS after deploy
npm run dev
```

## Run the reward bot (dry run)

```bash
cd bot && npm install
cp .env.example .env   # fill in LOCKER_ADDRESS / TOKEN_ID / LAUNCH_TOKEN / REWARD_TOKEN
npm run dry            # simulates everything, moves no funds
```

## Quick start (contracts)

```bash
cd contracts
npm install
cp .env.example .env            # add PRIVATE_KEY + BASE_SEPOLIA_RPC_URL
npx hardhat compile
npx hardhat run scripts/deploy.js --network baseSepolia    # deploy factory + locker + vault
npx hardhat run scripts/launch.js --network baseSepolia    # launch a test token
```
