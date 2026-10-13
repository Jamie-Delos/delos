# Delos vanity addresses: `…de105`

Census coins ended in `c0de`. Delos coins end in `de105`. This note records what changed on 2026-10-13 and what still has to happen on-chain.

## What changed in the repo

- `contracts/contracts/LaunchFactoryV4.sol` now enforces `(uint160(token) & VANITY_MASK) == VANITY_SUFFIX` with `VANITY_SUFFIX = 0xDE105` and `VANITY_MASK = 0xFFFFF` (five hex characters, 20 bits) whenever a non-zero salt is passed, and reverts with `not a delos address` otherwise. The zero-salt plain deploy is unchanged. Both constants are public so clients can read them.
- `contracts/scripts/lib/grindSalt.js` reads the factory's constants before grinding and falls back to `c0de` for a factory that has none (the Census-era V1/V2/V4 deployments). Its loop was rewritten to work on byte buffers; a de105 grind is about 1M keccak pairs.
- `frontend/src/lib/c0de.ts` does the same in the browser: `vanityOf(client, factory)` asks the factory, `grindC0de` grinds whatever it answers. The wizard shows the suffix it is grinding for and sizes its progress bar by the expected tries.
- `contracts/test/v4.vanity.test.js` covers the constants, the revert, the plain path and a grinded launch (with a pinned deterministic salt so CI stays fast).

Nothing in this change touches `LaunchToken` bytecode, so predicted addresses for existing factories are unaffected and `scripts/exportTokenBytecode.js --check` still passes.

## What has to happen on-chain

There is a script for it. Anyone with a funded key can run it; it deploys the factory and its vault deployer, binds them, checks the wiring, and prints the one call the curve deployer still has to send (or sends it when the signer is that wallet):

```bash
cd contracts
PRIVATE_KEY=0x... npx hardhat run scripts/deployDe105Factory.js --network robinhood
```

The same flow is rehearsed end to end on a fork of mainnet, including the launch, a capped buy and the graduation into the live pool, by `DE105_FORK=1 npx hardhat test test/v4.de105.fork.test.js --network hardhat`.


The team-test factories on Robinhood Chain (`0x3776FBA3…` and the dev-buy factory `0xc37b600F…`) were deployed from the old source and will keep enforcing `c0de` until they are replaced. To get de105 coins:

1. Deploy a new `LaunchFactoryV4` from this source together with a fresh `CensusRewardVaultDeployer` and bind them (`setLaunchFactory`, owned by whoever deploys the vault deployer; a vault deployer binds once, so the old ones cannot be reused). One factory serves both the plain and the creator-buy paths.
2. Authorise it on the curve (`setFactory`). Only the curve's deployer wallet can do this.
3. Point the frontend at the new address (`VITE_FACTORY_V4_ADDRESS` and `VITE_FACTORY_V4_DEV_BUY`, both the same). The site needs no code change: it reads the suffix from whichever factory it is given.

Until then every launch through the site, including the team-test coins, lands on a `c0de` address. Existing coins keep their addresses forever; the suffix only applies to new launches.

## Cost of the longer suffix

Four hex characters needed about 65k tries. Five need about 1M: roughly 10 seconds in a browser and well under a minute in Node. The wizard starts the grind as soon as the name and ticker are known, so the wait is usually over before the user reaches the review step.
