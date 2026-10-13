# Token and logo visibility on Robinhood Chain (checked 13 Oct 2026)

Question: once a Delos coin graduates into its Uniswap V4 pool, where does it show up, and how does its logo get there?

Short answer: every major tracker indexes Robinhood Chain and its hooked V4 pools automatically once a pool has traded. Logos do not travel automatically. The only free, automated logo route is a GeckoTerminal launchpad integration. DexScreener logos are paid per token. GMGN follows DexScreener profiles and integrated launchpads.

## Per tracker

| Tracker | Chain / V4 pools | How a logo gets there |
| --- | --- | --- |
| DexScreener | Yes, hooked pools appear after the first trade (keyed by poolId) | Paid "Enhanced Token Info", about $299 per token, no submit API. Pons V2 automates this payment within a minute of pool creation. |
| GeckoTerminal / CoinGecko | Yes (`uniswap-v4-robinhood`, plus per-launchpad DEX ids) | Launchpads registered as their own DEX get logos within minutes (Pons, pools.trade, Clanker, Bankr). Plain V4 pools: none. Manual form otherwise; Fast Pass $199. DEX listing is free, 5 to 10 working days, and needs 4 Integration API endpoints we can serve from the indexer. |
| DEXTools | Live since July 2026 | Per-token update from a connected wallet, paid in DEXT. Launchpad requests via their GitHub. |
| GMGN | Live, Trenches uses an allow-list of launchpads | Logo from integrated launchpads or DexScreener profiles. Integration is a partnership request. |
| Birdeye | Listed but not actually indexing the chain as of early October | Not useful yet. |
| Uniswap interface | Logos from CoinGecko only (about 48 h lag) | Hooked pools using ReturnsDelta or dynamic fees are not auto-routed; they need the hook allow-list form with verified source. Our hook uses those flags. |
| Blockscout | Explorer logos come from CoinGecko or an owner submission from the deployer wallet; factory-deployed tokens go through email | Not automatable. 99 USDC expedited, 1 to 7 days. |

## On-chain metadata

Uniswap's UERC20 pattern (pools.trade) stores `{description, website, image}` on the token and emits `TokenCreated(address, metadata)`; Pons and Clanker keep an image URL on the token too. Only GeckoTerminal honours this, and only for launchpads it has integrated. No tracker documents generic ERC-7572 support. Worth emitting anyway when the LaunchToken is next changed, since it is what integrations read.

## What this means for Delos

1. Register Delos as a DEX on GeckoTerminal (free form) and serve the four Integration API endpoints from the indexer (latest block, asset, pair, events) for the curve phase; ask for image ingestion as Pons and pools.trade have. This is the one free path and it feeds ScanHood-style trackers.
2. Decide per launch whether to buy the DexScreener profile (about $299). GMGN picks it up from there.
3. File the Uniswap hook allow-list form for the graduation hook, or the Uniswap app will not route our pools.
4. For flagship coins only: CoinGecko listing (propagates to Blockscout, Uniswap, Birdeye) and the Blockscout owner submission.

Research notes with every source URL are in the session transcript; the hooked-pool check script that confirmed DexScreener and GeckoTerminal coverage is reproducible from a PoolManager `Initialize` scan.
