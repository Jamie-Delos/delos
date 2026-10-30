# Addresses

Machine-readable copy: [`addresses.json`](addresses.json). Read `current` to know which Delos block is live.

## Chain

| | |
| --- | --- |
| Network | Robinhood Chain mainnet, chain id `4663` (`eip155:4663`), gas in ETH |
| RPC | `https://rpc.mainnet.chain.robinhood.com` (one `eth_getLogs` call spans at most 10,000,000 blocks) |
| Explorer | https://robinhoodchain.blockscout.com |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| Uniswap V4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` (official deployment) |
| Uniswap V4 StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| Uniswap V4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| Uniswap V3 SwapRouter02 / factory | `0xCaf681a66D020601342297493863E78C959E5cb2` / `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` (stock routes and zaps only) |
| HOOD (anchor) | `0x32ac8c1d7672667d5ebdea22935f7b06fc8d496f`, priced from the HOOD/USDG 1% V3 pool `0x1c1f6e283a72a68c15c816324363c794151cf913` |

## Delos, team-test stack (live, temporary)

Deployed from the same contracts, with a temporary treasury and keeper. Coins launched here keep trading here after the final cutover; the site may stop listing them.

| Contract | Address |
| --- | --- |
| CensusCurveV4 (the curve) | `0xD1300ccE1Ed4c778791cF713b6bA47FE32B217C3` |
| LaunchFactoryV4 | `0x3776FBA3b9a7C47fAd1d66a5223c73590d07278b` |
| LaunchFactoryV4, creator-buy build | `0xc37b600F1079B88C7c077f607Fad7aee095Cb653` |
| CensusV4Graduator | `0x275802F2145f03e3685C48Beaaab5bc100F69D4f` |
| CensusV4Hook | `0xCaA6477f3116126ebD4A7f03B2B7631c70cF20cC` |
| CensusV4Router | `0xb087d45099D9e275c67693eD1a215c66B4907BA6` |
| Treasury (protocol fee recipient) | `0x952594c08c027e8d401A8c462467a94cf8AE48E7` |
| Vanity suffix | `c0de` (`VANITY_SUFFIX` is not exposed by these older factories) |
| Index from block | `69,000,000` |

## Delos, final stack

**Pending.** Same contracts, new addresses, `de105` suffix, exposed as `VANITY_SUFFIX()` / `VANITY_MASK()` on the factory. The fields in `addresses.json → delos.final` are filled when it ships, and `current` flips to `final`.

## Data API

**Pending a public host.** `addresses.json → indexer.baseUrl` and `websocket` are `null` until then. The API itself is documented in [DATA-API.md](DATA-API.md).
