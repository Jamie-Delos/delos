require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { ROBINHOOD_RPC_URL, ROBINHOOD_TESTNET_RPC_URL, BASE_SEPOLIA_RPC_URL, PRIVATE_KEY, BASESCAN_API_KEY } = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true, // the launch flow has many locals; IR pipeline avoids "stack too deep"
    },
  },
  networks: {
    hardhat: {
      // Enable forking only when BASE_FORK_RPC_URL is set (used by integration.fork.test.js).
      forking: process.env.BASE_FORK_RPC_URL
        ? { url: process.env.BASE_FORK_RPC_URL }
        : undefined,
    },
    robinhood: {
      url: ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 4663,
    },
    robinhoodTestnet: {
      url: ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 46630,
    },
    baseSepolia: {
      url: BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 84532,
    },
  },
  etherscan: {
    apiKey: { baseSepolia: BASESCAN_API_KEY || "" },
    customChains: [
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
    ],
  },
};
