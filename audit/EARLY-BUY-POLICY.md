# Early purchase policy — 17 September 2026

The 1% cumulative early purchase cap is disabled for new Prima and Maxima launches (`ANTISNIPE_MAX_BUY_BPS = 0`). The token already supports zero as unlimited, so its bytecode and public interfaces do not change. Existing deployed factories and tokens retain their original settings; deploying the updated factories is required to apply this policy to future launches.

The separate 2% wallet balance check, launch-block guard, creator/bundle exemptions and 100-block window remain. The balance check only applies when receiving tokens from the curve. It does not restrict ordinary transfers or graduated-pool trades. With the default 1B supply, 1.5 ETH virtual quote and 4 ETH graduation reserve, an initial 0.1 ETH buy still exceeds the 20M wallet balance threshold during that window. Removing the cumulative cap alone does not make that purchase eligible.

## Pons comparison

Reviewed public source commit `162310fbd1217717e2f5e4cde794d6a11322b469`:

- [Pons V1 token](https://github.com/ponsdotdev/ponsfamily/blob/162310fbd1217717e2f5e4cde794d6a11322b469/contractsV1/src/PonsLauncherToken.sol): early block, wallet and cumulative purchase restrictions.
- [Pons V2 token](https://github.com/ponsdotdev/ponsfamily/blob/162310fbd1217717e2f5e4cde794d6a11322b469/contractsV2/src/v2/PonsV2LauncherToken.sol): no such early restrictions; deployer attribution does not grant token privileges.
- [Pons V2 curve](https://github.com/ponsdotdev/ponsfamily/blob/162310fbd1217717e2f5e4cde794d6a11322b469/contractsV2/src/v2/PonsV2BondingCurve.sol): price impact and reserved liquidity allocation constrain buys; excess input is refunded on a partial final fill. These economic constraints do not exclude bots or guarantee equal launch access. This comparison is of repository source, not verification of deployed bytecode.

Census retains its approved PF-style virtual token reserve math. Matching Pons V2's unrestricted early trading would additionally mean removing the wallet and launch-block restrictions, a separate policy choice.

## Regression coverage

`contracts/test/earlyBuys.test.js` exercises both factories: a purchase exceeding 1% within the window; cumulative buy/sell/buy volume exceeding 2% without a purchase allowance; and the remaining wallet limit, creator exemption and expiry. Existing bonding/graduation tests cover pricing, partial fills, fee allocation and pool trading.

Validation: full local Hardhat suite 84 passing, 3 pending (opt-in fork cases); creation-bytecode parity and EIP-170 size checks passed. No public transactions or deployments performed.
