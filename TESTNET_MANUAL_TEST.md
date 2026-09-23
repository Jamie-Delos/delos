# Manual test of the V4 product on Robinhood testnet (no official contracts, site or wallets)

Everything below is disposable: a throwaway V4 stack deployed on Robinhood Chain **testnet** (chainId 46630)
by a throwaway deployer, a local copy of the site, and a throwaway wallet funded from the faucet. The
official Census contracts, census site, treasury and team wallets are never involved.

## 1. Wallet
1. Create a fresh wallet in MetaMask (or any injected wallet). Never use a personal or team wallet.
2. Add the network: name `Robinhood Chain Testnet`, RPC `https://rpc.testnet.chain.robinhood.com`, chain id
   `46630`, currency `ETH`, explorer `https://explorer.testnet.chain.robinhood.com`.
3. Claim test ETH: https://faucet.testnet.chain.robinhood.com (0.01 ETH is enough for dozens of trades;
   claim again if it runs low).

## 2. Site (local only)
```
cd frontend
cp .env.testnet.example .env        # the testnet stack addresses (already done on this machine)
npm ci && npm run build && npx vite preview --host 127.0.0.1 --port 4173
```
Open http://127.0.0.1:4173. The site talks only to the testnet RPC and the throwaway stack:

| Contract | Address |
|---|---|
| LaunchFactoryV4 | 0xA313356B20e6920dD3a6724924aFc5F5A4F1d0f2 |
| CensusCurveV4 | 0xCCb59EBa27628382fe9e2FB9dF18586eF86F476D |
| CensusV4Hook | 0x32DA226e5c6bC92653bC80A2D9c963905c94A0Cc |
| CensusV4Router | 0xEe50bE767E81703f7C78C0284E372791b9C2d785 |
| PoolManager (copy; mainnet uses Uniswap's) | 0xcb666eB55b44419283b61fd3daBf39376BA87263 |
| Test stocks (mock ERC20s) | NVDA 0xB09b83386CeEf2Ba9D1725EC2E6DA7b93d6a4570, AAPL 0xb526223FF946b318f0d0E4d0C2f78426eb0EAf35, TSLA 0x8B1Ca43188C09D3555C51d6a29A0B9Dc38d74Fee |

Placeholders on this stack: treasury = a FeeVault owned by the throwaway deployer; keeper = the deployer;
stock swaps go through a mock router that pays 1:1. On mainnet those are the multisig, the keeper key and
real Uniswap routes.

## 3. What to click through
1. **Launch** → pick Prima (meme) or Maxima (company), name it, choose ETH as the pairing asset.
   Economics step: set **holder reflection** Off / 1 / 2 / 3 / 4 % and, when on, build the **reward basket**
   (ETH and/or the listed stocks NVDA, AAPL, TSLA; up to three; weights must total 100 %). Set a small
   graduation target (for example 0.002 ETH) so you can graduate it yourself. The fee card shows
   "2 % base + R % holder reflection". Confirm the wallet transaction.
2. **Coin page** → the fee line shows the live rate: during the first three seconds after launch it shows
   the launch-window penalty, then the standing rate. Buy with ETH; sell; watch the reserve bar fill.
   Try a buy larger than what is left: the curve accepts only the remainder and refunds the rest.
3. **Graduate** → the buy that fills the reserve graduates the coin in the same transaction (no button,
   no manual step; if the pool ever rejects the seeding the keeper retries); the page switches to the canonical
   V4 pool. Buy and sell there: the same 2 % + reflection is charged by the hook, and the page discloses
   that other venues are not charged.
4. **Rewards** → on a reflection coin the rewards panel lists the basket and your claimable amount per
   asset. Rewards accrue to the vault on every trade; they are converted and credited when the keeper (or
   the creator) runs a distribution. For this rehearsal run the keeper yourself:
   ```
   cd contracts
   npx hardhat console --network robinhoodTestnet
   > const v = await ethers.getContractAt("CensusRewardVault", "<vault address from the coin page>")
   > await v.distribute([0, 1, 1])      // one minOut per basket asset: 0 for ETH, 1 for each mock stock
   ```
   (the throwaway deployer in `contracts/.env` is the registered keeper). Then press **Claim** on the coin
   page or in your profile; the assets land in the wallet.
5. **Profile** → lists every reflection coin you hold with claimable rewards and a Claim button.

## 4. Things you should see fail (on purpose)
- Choosing a stock that is not on the on-chain allowlist is impossible in the UI; a direct contract call
  with such a basket reverts `AssetNotAllowed`.
- Reflection outside 1–4 %, four basket assets, or weights that do not sum to 100 % are rejected.
- Trading a graduated coin on the curve reverts; buying with a stale quote past your slippage reverts.

## 5. Automated evidence for the same stack
`audit/TESTNET-STRESS-robinhoodTestnet-2026-09-22.md`: 903 real transactions, 4 launches, 799 curve
trades, 4 graduations, 40 hook trades, distributions and claims, every fee matched to the formula, 17/17
invariants.
