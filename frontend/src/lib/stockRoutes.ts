// AUTO-GENERATED from live Robinhood Chain (chainId 4663) Uniswap V3 pool liquidity.
// Each reachable tokenized stock with its swap route from WETH. Pass `path` to
// LaunchFactoryV2.createLaunch(params, basket, weights, paths) for the v2 dividend basket.
// "direct" = WETH->stock single pool; "usdg" = WETH->USDG->stock (stock only has USDG liquidity).
export type StockRoute = { ticker: string; name: string; address: `0x${string}`; mode: "direct" | "usdg"; path: `0x${string}`; wethDepth?: number; usdgDepth?: number };

export const WETH_USDG_BRIDGE_FEE = 100;

// Token addresses (lowercase, no 0x) as they appear inside a packed V3 path, + the fee tiers used to
// re-root a route at HOOD. HOOD has no WETH pool; its only liquidity is HOOD/USDG at the 1% tier.
const WETH_HEX = "0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG_HEX = "5fc5360d0400a0fd4f2af552add042d716f1d168";
const HOOD_HEX = "32ac8c1d7672667d5ebdea22935f7b06fc8d496f";
const FEE_HEX = (tier: number) => tier.toString(16).padStart(6, "0"); // uint24 -> 6 hex
const FEE_HOOD_USDG = FEE_HEX(10000); // HOOD/USDG 1% pool
const FEE_USDG_WETH = FEE_HEX(WETH_USDG_BRIDGE_FEE); // USDG<->WETH 0.01% bridge

// The V3 swap path the DividendVault uses to convert a coin's QUOTE fee asset into `ticker`.
// ETH-quoted coins use the stored WETH route as-is. HOOD-quoted coins receive fees in HOOD, so we
// re-root the route at HOOD: `usdg` stocks become HOOD->USDG->stock; `direct` (WETH-only) stocks become
// HOOD->USDG->WETH->stock. If the stock IS the quote asset, the vault credits it directly ("0x" path).
export function basketPath(quoteAddr: string, ticker: string): `0x${string}` {
  const r = STOCK_ROUTES[ticker];
  if (!r) return "0x";
  const q = quoteAddr.toLowerCase().replace(/^0x/, "");
  if (r.address.toLowerCase().replace(/^0x/, "") === q) return "0x"; // holders earn the quote asset itself
  if (q === WETH_HEX) return r.path;                                  // ETH-quoted: stored WETH route
  if (q === HOOD_HEX) {
    const body = r.path.slice(2); // strip 0x
    if (r.mode === "usdg") {
      // WETH(40) + fee(6) + [USDG + feeStock + stock] -> HOOD + FEE_HOOD_USDG + [USDG + feeStock + stock]
      return ("0x" + HOOD_HEX + FEE_HOOD_USDG + body.slice(40 + 6)) as `0x${string}`;
    }
    // direct: WETH + feeStock + stock -> HOOD + FEE_HOOD_USDG + USDG + FEE_USDG_WETH + [WETH + feeStock + stock]
    return ("0x" + HOOD_HEX + FEE_HOOD_USDG + USDG_HEX + FEE_USDG_WETH + body) as `0x${string}`;
  }
  return r.path; // other anchors (future): fall back to the stored route
}

export const STOCK_ROUTES: Record<string, StockRoute> = {
  "NVDA": {
    "ticker": "NVDA",
    "name": "NVIDIA",
    "address": "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    "mode": "direct",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad73000bb8d0601ce157db5bdc3162bbac2a2c8af5320d9eec",
    "wethDepth": 112.089
  },
  "AAPL": {
    "ticker": "AAPL",
    "name": "Apple",
    "address": "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
    "mode": "direct",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730001f4af3d76f1834a1d425780943c99ea8a608f8a93f9",
    "wethDepth": 16.998
  },
  "MSFT": {
    "ticker": "MSFT",
    "name": "Microsoft",
    "address": "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb8e93237c50d904957cf27e7b1133b510c669c2e74",
    "usdgDepth": 141477
  },
  "GOOGL": {
    "ticker": "GOOGL",
    "name": "Alphabet",
    "address": "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d1680001f42e0847e8910a9732eb3fb1bb4b70a580adad4fe3",
    "usdgDepth": 407034
  },
  "META": {
    "ticker": "META",
    "name": "Meta",
    "address": "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35",
    "mode": "direct",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad73000bb8c0d6457c16cc70d6790dd43521c899c87ce02f35",
    "wethDepth": 9.497
  },
  "AMZN": {
    "ticker": "AMZN",
    "name": "Amazon",
    "address": "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb812f190a9f9d7d37a250758b26824b97ce941bf54",
    "usdgDepth": 250834
  },
  "TSLA": {
    "ticker": "TSLA",
    "name": "Tesla",
    "address": "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    "mode": "direct",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad73000bb8322f0929c4625ed5bad873c95208d54e1c003b2d",
    "wethDepth": 32.966
  },
  "NFLX": {
    "ticker": "NFLX",
    "name": "Netflix",
    "address": "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb8e0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8",
    "usdgDepth": 56376
  },
  "TSM": {
    "ticker": "TSM",
    "name": "TSMC",
    "address": "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d16800271058ffe4a942d3885baa22d7520691f611ef09e7aa",
    "usdgDepth": 51925
  },
  "MU": {
    "ticker": "MU",
    "name": "Micron",
    "address": "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb8ff080c8ce2e5feadaca0da81314ae59d232d4afd",
    "usdgDepth": 633344
  },
  "AMD": {
    "ticker": "AMD",
    "name": "AMD",
    "address": "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb886923f96303d656e4aa86d9d42d1e57ad2023fdc",
    "usdgDepth": 19510
  },
  "SNDK": {
    "ticker": "SNDK",
    "name": "SanDisk",
    "address": "0xB90A19fF0Af67f7779afF50A882A9CfF42446400",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168002710b90a19ff0af67f7779aff50a882a9cff42446400",
    "usdgDepth": 52612
  },
  "INTC": {
    "ticker": "INTC",
    "name": "Intel",
    "address": "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb8c72b96e0e48ecd4dc75e1e45396e26300bc39681",
    "usdgDepth": 22815
  },
  "QUBT": {
    "ticker": "QUBT",
    "name": "Quantum Computing",
    "address": "0x59818904ab4cE163b3cE4FfB64f2D6Ca02c434B4",
    "mode": "direct",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad7300271059818904ab4ce163b3ce4ffb64f2d6ca02c434b4",
    "wethDepth": 12.629
  },
  "MRVL": {
    "ticker": "MRVL",
    "name": "Marvell",
    "address": "0x62fd0668e10D8B72339BE2DCF7643001688ff13B",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d16800271062fd0668e10d8b72339be2dcf7643001688ff13b",
    "usdgDepth": 65738
  },
  "RDDT": {
    "ticker": "RDDT",
    "name": "Reddit",
    "address": "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C",
    "mode": "direct",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad7300271005b37fb53a299a1b874a619e1c4c404d52c36f4c",
    "wethDepth": 57.807
  },
  "DJT": {
    "ticker": "DJT",
    "name": "Trump Media",
    "address": "0x1D11f0496982706C5e14A514D4E79F2e6BdE4516",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d1680027101d11f0496982706c5e14a514d4e79f2e6bde4516",
    "usdgDepth": 400531
  },
  "GME": {
    "ticker": "GME",
    "name": "GameStop",
    "address": "0x1b0E319c6A659F002271B69dB8A7df2F911c153E",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d1680001f41b0e319c6a659f002271b69db8a7df2f911c153e",
    "usdgDepth": 304613
  },
  "AMC": {
    "ticker": "AMC",
    "name": "AMC",
    "address": "0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb805a3d1cd21d0c88145e82600e62e7e496e0f222b",
    "usdgDepth": 7557
  },
  "RBLX": {
    "ticker": "RBLX",
    "name": "Roblox",
    "address": "0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8",
    "mode": "direct",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad73000bb8f0c4bf4c582cb3836e98394b1d4e7b7281101be8",
    "wethDepth": 15.133
  },
  "SNAP": {
    "ticker": "SNAP",
    "name": "Snap",
    "address": "0xF6589F11Bc40b669e584073F428B05562F568733",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb8f6589f11bc40b669e584073f428b05562f568733",
    "usdgDepth": 113675
  },
  "COIN": {
    "ticker": "COIN",
    "name": "Coinbase",
    "address": "0x6330D8C3178a418788dF01a47479c0ce7CCF450b",
    "mode": "direct",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad73000bb86330d8c3178a418788df01a47479c0ce7ccf450b",
    "wethDepth": 62.415
  },
  "MSTR": {
    "ticker": "MSTR",
    "name": "Strategy",
    "address": "0xec262a75e413fAfD0dF80480274532C79D42da09",
    "mode": "direct",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad73002710ec262a75e413fafd0df80480274532c79d42da09",
    "wethDepth": 237.432
  },
  "PLTR": {
    "ticker": "PLTR",
    "name": "Palantir",
    "address": "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb8894e1ec2d74ffe5aef8dc8a9e84686accb964f2a",
    "usdgDepth": 73490
  },
  "HIMS": {
    "ticker": "HIMS",
    "name": "Hims & Hers",
    "address": "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb8ccee82fe024c36fa15e1005ede3e9e4787e23d09",
    "usdgDepth": 330371
  },
  "RIVN": {
    "ticker": "RIVN",
    "name": "Rivian",
    "address": "0xB1BF26c1D20ff267A4f93550d1E0d06ac40a114B",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168002710b1bf26c1d20ff267a4f93550d1e0d06ac40a114b",
    "usdgDepth": 89234
  },
  "CRCL": {
    "ticker": "CRCL",
    "name": "Circle",
    "address": "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5",
    "mode": "direct",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad73002710df0992e440dd0be65bd8439b609d6d4366bf1cb5",
    "wethDepth": 16.771
  },
  "LULU": {
    "ticker": "LULU",
    "name": "Lululemon",
    "address": "0x4e62068525Ab11FE768e29dfD00ef909B9803016",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb84e62068525ab11fe768e29dfd00ef909b9803016",
    "usdgDepth": 56762
  },
  "QQQ": {
    "ticker": "QQQ",
    "name": "Nasdaq-100 ETF",
    "address": "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
    "mode": "direct",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad73000bb8d5f3879160bc7c32ebb4dc785f8a4f505888de68",
    "wethDepth": 17.036
  },
  "SPY": {
    "ticker": "SPY",
    "name": "S&P 500 ETF",
    "address": "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
    "mode": "direct",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730001f4117cc2133c37b721f49de2a7a74833232b3b4c0c",
    "wethDepth": 263.691
  },
  "GLD": {
    "ticker": "GLD",
    "name": "Gold",
    "address": "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e",
    "mode": "direct",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad73002710c9a981fee1f9dec688bb123ccdecc63d0debfc4e",
    "wethDepth": 49.419
  },
  "SLV": {
    "ticker": "SLV",
    "name": "Silver",
    "address": "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb8411efb0e7f985935daec3d4c3ebaea0d0ad7d89f",
    "usdgDepth": 125699
  },
  "USO": {
    "ticker": "USO",
    "name": "Oil",
    "address": "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb8a30fa36db767ad9ed3f7a60fc79526fb4d56d344",
    "usdgDepth": 345044
  },
  "SGOV": {
    "ticker": "SGOV",
    "name": "T-Bills ETF",
    "address": "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb892fd66527192e3e61d4ddd13322aa222de86f9b5",
    "usdgDepth": 135125
  },
  "LLY": {
    "ticker": "LLY",
    "name": "Eli Lilly",
    "address": "0x8005d266423c7ea827372c9c864491e5786600ea",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d1680001f48005d266423c7ea827372c9c864491e5786600ea",
    "usdgDepth": 194752
  },
  "PFE": {
    "ticker": "PFE",
    "name": "Pfizer",
    "address": "0x7066A64c24e4206CD62E83bf198c1E7EB361F51e",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb87066a64c24e4206cd62e83bf198c1e7eb361f51e",
    "usdgDepth": 41799
  },
  "MRNA": {
    "ticker": "MRNA",
    "name": "Moderna",
    "address": "0x43B07D15cE533bEc5476d70C22a78a1B2B662155",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d16800271043b07d15ce533bec5476d70c22a78a1b2b662155",
    "usdgDepth": 64601
  },
  "JNJ": {
    "ticker": "JNJ",
    "name": "Johnson & Johnson",
    "address": "0x03DfbBE0AC4E7bCDaFd08eD41A400326B77D8c80",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb803dfbbe0ac4e7bcdafd08ed41a400326b77d8c80",
    "usdgDepth": 139203
  },
  "BA": {
    "ticker": "BA",
    "name": "Boeing",
    "address": "0x4D21483a44Bf67a86b77E3dA301411880797D452",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb84d21483a44bf67a86b77e3da301411880797d452",
    "usdgDepth": 34602
  },
  "RCAT": {
    "ticker": "RCAT",
    "name": "Red Cat",
    "address": "0xFDE6b5d9BB419B10C23268c74e369AbFF39C0460",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168002710fde6b5d9bb419b10c23268c74e369abff39c0460",
    "usdgDepth": 26197
  },
  "SPCX": {
    "ticker": "SPCX",
    "name": "SpaceX",
    "address": "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa",
    "mode": "direct",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730001f44a0e65a3eccec6dbe60ae065f2e7bb85fae35eea",
    "wethDepth": 62.583
  },
  "FIG": {
    "ticker": "FIG",
    "name": "Figma",
    "address": "0x41F4267525a8AFf329540eF24fD83d9044758B33",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb841f4267525a8aff329540ef24fd83d9044758b33",
    "usdgDepth": 10150
  },
  "BABA": {
    "ticker": "BABA",
    "name": "Alibaba",
    "address": "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb8ad25ac6c84d497db898fa1e8387bf6af3532a1c4",
    "usdgDepth": 44443
  },
  "NET": {
    "ticker": "NET",
    "name": "Cloudflare",
    "address": "0x116F00968269B7bfbaD4109cE591d6E74c0601d4",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168002710116f00968269b7bfbad4109ce591d6e74c0601d4",
    "usdgDepth": 7176
  },
  "DELL": {
    "ticker": "DELL",
    "name": "Dell",
    "address": "0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168002710941ae714ec6d8130c7b75d67160ca08f1e7d11dd",
    "usdgDepth": 405421
  },
  "IBM": {
    "ticker": "IBM",
    "name": "IBM",
    "address": "0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168002710980dcf6766fa79f5cf0c4aadb3ab477ff15a9619",
    "usdgDepth": 18967
  },
  "COST": {
    "ticker": "COST",
    "name": "Costco",
    "address": "0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb84ea005168d7f09a7a0ba9d1def21a479950e44c2",
    "usdgDepth": 446983
  },
  "TTWO": {
    "ticker": "TTWO",
    "name": "Take-Two",
    "address": "0x5e81213613b6B86EaB4c6c50d718d34359459786",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb85e81213613b6b86eab4c6c50d718d34359459786",
    "usdgDepth": 231752
  },
  "F": {
    "ticker": "F",
    "name": "Ford",
    "address": "0x25C288E6D899b9BC30160965aD9644c67e73bE0C",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d16800271025c288e6d899b9bc30160965ad9644c67e73be0c",
    "usdgDepth": 6435
  },
  "UPS": {
    "ticker": "UPS",
    "name": "UPS",
    "address": "0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168002710f23250dac154d05bb671cb0d0ebef3c635c79ce2",
    "usdgDepth": 54955
  },
  "USAR": {
    "ticker": "USAR",
    "name": "USA Rare Earth",
    "address": "0xd917B029C761D264c6A312BBbcDA868658eF86a6",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d168000bb8d917b029c761d264c6a312bbbcda868658ef86a6",
    "usdgDepth": 25889
  },
  // Robinhood's own stock. Added from live on-chain discovery (block ~57.9M): HOOD has NO WETH pool,
  // only USDG liquidity (its deepest quote pool is HOOD/USDG at the 1% tier, 0x1c1f6e28…151cf913) —
  // which is why the original WETH-first scan missed it. Route is WETH -> USDG(0.01%) -> HOOD(1%).
  // Doubles as the pairing anchor for Lunch.fun-style HOOD-quoted launches (see lib/anchors.ts).
  "HOOD": {
    "ticker": "HOOD",
    "name": "Robinhood",
    "address": "0x32ac8c1d7672667d5ebdea22935f7b06fc8d496f",
    "mode": "usdg",
    "path": "0x0bd7d308f8e1639fab988df18a8011f41eacad730000645fc5360d0400a0fd4f2af552add042d716f1d16800271032ac8c1d7672667d5ebdea22935f7b06fc8d496f"
  }
};

export const REACHABLE_TICKERS = ["NVDA","AAPL","MSFT","GOOGL","META","AMZN","TSLA","NFLX","TSM","MU","AMD","SNDK","INTC","QUBT","MRVL","RDDT","DJT","GME","AMC","RBLX","SNAP","COIN","MSTR","PLTR","HIMS","RIVN","CRCL","LULU","QQQ","SPY","GLD","SLV","USO","SGOV","LLY","PFE","MRNA","JNJ","BA","RCAT","SPCX","FIG","BABA","NET","DELL","IBM","COST","TTWO","F","UPS","USAR","HOOD"];

// Testnet rehearsals: the mainnet catalogue above does not exist off mainnet, so a NON-mainnet build can
// name test stock contracts via VITE_TEST_STOCKS="NVDA:0x...,AAPL:0x...". They are routed with an empty
// path (a direct hop at the factory's stock fee tier through whatever router the testnet stack uses) and
// only appear in the wizard if the curve's on-chain reward allowlist includes them. Ignored on mainnet.
import { IS_MAINNET } from "../config";
const TEST_STOCKS = (import.meta.env.VITE_TEST_STOCKS ?? "").trim();
if (!IS_MAINNET && TEST_STOCKS) {
  for (const entry of TEST_STOCKS.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [ticker, address] = entry.split(":").map((s) => s.trim());
    if (!ticker || !/^0x[0-9a-fA-F]{40}$/.test(address ?? "")) continue;
    const known = STOCK_ROUTES[ticker];
    STOCK_ROUTES[ticker] = { ticker, name: known?.name ?? ticker, address: address as `0x${string}`, mode: "direct", path: "0x" };
  }
}
