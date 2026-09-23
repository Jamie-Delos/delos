// Uniswap V3 deployment addresses per chain (verified against Uniswap official docs).
// https://docs.uniswap.org/contracts/v3/reference/deployments/base-deployments
module.exports = {
  // === TARGET: Robinhood Chain mainnet (chainId 4663) — Arbitrum Orbit L2, ETH gas ===
  // Uniswap V3 shipped on Robinhood Chain from day one. Addresses read/verified on-chain:
  //   Factory via SwapRouter02.factory(); NPM = the "Uniswap V3 Positions NFT-V1" ERC-721
  //   (NPM.factory() confirmed == the factory below). WETH/Router from NOXA's own config.
  robinhood: {
    chainId: 4663,
    UniswapV3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    NonfungiblePositionManager: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
    SwapRouter02: "0xCaf681a66D020601342297493863E78C959E5cb2",
    WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    // Uniswap V4 (official deployment list: https://developers.uniswap.org/docs/protocols/v4/deployments;
    // code presence verified on-chain 2026-09-21 at block 69078172).
    v4: {
      PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
      Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
      StateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    },
  },
  // === Arc testnet (chainId 5042002) — Circle's L1, USDC gas (18-dec native) ===
  // DEX = UNITFLOW V3 (a Uniswap V3 fork). Quote asset = WUSDC (wrapped native USDC, 18 decimals,
  // verified on-chain). NPM.factory() and Router.factory() both == the factory below.
  // Native gas is USDC; fund the deployer via faucet.circle.com. SwapRouter is v1-style (has deadline).
  arc: {
    chainId: 5042002,
    quoteDecimals: 18,
    quoteSymbol: "USDC",
    UniswapV3Factory: "0xAb6A8AAb7d490007634ef59d424b5d89688a1971",
    NonfungiblePositionManager: "0x77c39eB310BE31e60068CE29855F83359bf85fc4",
    SwapRouter02: "0x509cF58CdA08C7aee83a2BdBb4A1Eac907343D01", // UNITFLOW SwapRouter (v1 exactInputSingle w/ deadline)
    WETH: "0x911b4000D3422F482F4062a913885f7b035382Df", // WUSDC = the quote asset
  },
  // Robinhood Chain testnet (chainId 46630) — confirmed and in use by the live testnet frontend
  // (these match uniswap.robinhoodTestnet.json and frontend/.env.example). uniswap.robinhoodTestnet.json
  // is the authoritative source (deploy.js loadUni reads it first); this entry mirrors it as a fallback.
  robinhoodTestnet: {
    chainId: 46630,
    UniswapV3Factory: "0x1e572f531c74f16B760e308DA684895B94A9D8E1",
    NonfungiblePositionManager: "0x434ffD7eEbD28c0c7535532bcBb68dd092cA3eb5",
    SwapRouter02: "0x0F134877161c8C3Ab9A87e9B4c0e0280BF0D1D82",
    WETH: "0x823F4ef19CCE787C7D10483896eE0102F48A88eb",
  },

  // Base Sepolia (chainId 84532) — only used as a fork target for automated engine tests.
  baseSepolia: {
    chainId: 84532,
    UniswapV3Factory: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    NonfungiblePositionManager: "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2",
    SwapRouter02: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
    WETH: "0x4200000000000000000000000000000000000006",
    QuoterV2: "0xC5290058841028F1614F3A6F0F5816cAd0df5E27",
  },
  // Base Mainnet (chainId 8453) — for the eventual iteration-5 mainnet deploy.
  base: {
    chainId: 8453,
    UniswapV3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    NonfungiblePositionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
    SwapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
    WETH: "0x4200000000000000000000000000000000000006",
    QuoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  },
};
