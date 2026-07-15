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
  },
  // Robinhood Chain testnet (chainId 46630) — Uniswap V3 addresses NOT yet confirmed here.
  // Fill these in once verified on the testnet; until then, testnet launches can't run.
  robinhoodTestnet: {
    chainId: 46630,
    UniswapV3Factory: "",
    NonfungiblePositionManager: "",
    SwapRouter02: "",
    WETH: "",
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
