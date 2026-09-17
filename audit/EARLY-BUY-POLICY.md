# Three-second launch tax — 17 September 2026

This supersedes the earlier removal of only the 1% purchase cap. New Prima and Maxima launches have no wallet balance cap, cumulative buy cap, or launch-block buy restriction. Factories no longer arm the legacy restrictions in LaunchToken. The existing token bytecode and constructor are unchanged, preserving client vanity-address compatibility.

## Behaviour

The curve records the launch timestamp once at registration. Non-exempt curve buys follow Pons' fourteen integer halvings across a three-second window. The raw extra rate is `9900 >> floor(elapsedSeconds * 14 / 3)`, cut off at three seconds. The combined base fee plus penalty is capped at 99%, leaving at least 1% of accepted input to buy tokens.

| Seconds since launch (chain timestamp) | Extra launch tax | Normal curve fee | Total buy fee |
| --- | ---: | ---: | ---: |
| 0 | 97% (capped) | 2% | 99% |
| 1 | 6.18% | 2% | 8.18% |
| 2 | 0.19% | 2% | 2.19% |
| 3 or later | 0% | 2% | 2% |

This is a decay, not a flat 99% fee for three seconds. Inclusion time determines the rate. Timestamp resolution is whole seconds, regardless of how many blocks the chain produces within a second. Sells always retain the normal 2% curve fee. Graduation and subsequent V3 pool fees do not change.

The creator and up to 32 creator-declared bundle addresses are exempt from the extra launch tax, but still pay 2%. Exemptions are frozen atomically at initial registration; no post-launch exemption setter exists. Both factories keep the existing launch entrypoint signatures, with the exemption array now applying to the curve tax. The website passes no extra bundle addresses.

All collected fees, including the penalty, follow the existing Census split: 25% platform, 75% creator side, with the configured holder share taken from that creator side. The penalty is deducted from accepted quote input before pricing. Only net input enters real/virtual curve reserves. Final fills calculate the cap using the buyer's current rate, refund excess input, and charge no fee on the refund. Census rounds the combined fee once; this avoids a one-unit mismatch when grossing up the final fill. Pons floors its individual fee components separately.

## Source correction

My earlier statement that Pons V2 had no launch tax was incorrect. The public repository at commit `162310fbd1217717e2f5e4cde794d6a11322b469` contains mismatched versions: its factory exposes tax settings and calls methods absent from its checked-in curve. The README's comparison is also incomplete.

The implementation was checked against the `PonsV2BondingCurve.sol` included in the verified factory's additional sources, retrieved from [Blockscout's verified-source API](https://robinhoodchain.blockscout.com/api/v2/smart-contracts/0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e). That source establishes fourteen right-shift halvings, the combined 99% ceiling, buy-only application, and allocation through the regular fee bucket. [Pons factory source](https://github.com/ponsdotdev/ponsfamily/blob/162310fbd1217717e2f5e4cde794d6a11322b469/contractsV2/src/v2/PonsV2LaunchFactory.sol) also confirms creator/bundle exemptions. The public factory's initial duration is 15 seconds and is configurable; Census uses the requested fixed three seconds. This review did not independently read Pons' current live duration.

## Integration and deployment

- The approved PF virtual-token curve math and 1B supply are unchanged.
- `buyFeeBps`, `currentSnipeTaxBps`, `launchedAt`, `quoteBuyFor` and `maxQuoteInFor` expose the buyer-specific state. Legacy quote/max-input views use `msg.sender`; callers should supply the buyer address or use explicit buyer views.
- `Traded.fee` remains the total fee. Existing indexer accounting subtracts that event value, so taxed trades retain exact reserves without a database migration. Additional launch/exemption/tax events provide an audit trail.
- The client uses the connected buyer for quotes, refreshes the displayed launch fee every second, and refreshes the quote before submission. A missing quote no longer silently submits a curve trade with zero minimum output.
- These are changes for newly deployed curve/factory contracts. Existing deployments and tokens retain their original rules; no proxy upgrade is implied. Deploy the matching curve and both factories, and update configured addresses together.
- This is an economic deterrent, not bot exclusion. Creator/bundle exemptions, multiple wallets, and external-pool fee bypass remain relevant. No claim of universal anti-MEV protection is made.

## Validation

Regression coverage includes both launch types; timestamp boundaries; actual launch-block buys by a non-creator; native and ERC20 buys; a non-native quote zap; base-fee-only sells; exact platform/creator/holder allocation; taxed partial fills at 99% and 8.18%; slippage rollback; immutable exemptions; contract/indexer event parity; and complete graduation/pool lifecycles.

Validation: full local Hardhat suite **95 passing, 3 pending** (opt-in fork cases); frontend TypeScript check passed; bytecode parity and EIP-170 size checks passed; indexer parity passed for 121 standard trades plus taxed final fills from both launch types. All three complete bonding/graduation/pool-trading rehearsals also passed against implementation `d13f3d0`; see `BONDING-LIFECYCLE-RESULTS.md`. No public transactions, pushes or deployments performed.
