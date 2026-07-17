require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const { ROBINHOOD_RPC_URL, ROBINHOOD_TESTNET_RPC_URL, ARC_RPC_URL, BASE_SEPOLIA_RPC_URL, PRIVATE_KEY, BASESCAN_API_KEY } = process.env;

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
    arc: {
      // Circle's Arc testnet. Gas paid in USDC — fund the deployer via faucet.circle.com.
      url: ARC_RPC_URL || "https://rpc.drpc.testnet.arc.network",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 5042002,
    },
    baseSepolia: {
      url: BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 84532,
    },
  },
  // Robinhood Chain uses Blockscout, which accepts the Etherscan-compatible verify API. Blockscout
  // ignores the API key but hardhat requires a value, so any non-empty string works.
  etherscan: {
    apiKey: {
      robinhood: "blockscout",
      robinhoodTestnet: "blockscout",
      arc: "arcscan",
      baseSepolia: BASESCAN_API_KEY || "",
    },
    customChains: [
      {
        network: "robinhood",
        chainId: 4663,
        urls: {
          apiURL: "https://robinhoodchain.blockscout.com/api",
          browserURL: "https://robinhoodchain.blockscout.com",
        },
      },
      {
        network: "robinhoodTestnet",
        chainId: 46630,
        urls: {
          apiURL: "https://explorer.testnet.chain.robinhood.com/api",
          browserURL: "https://explorer.testnet.chain.robinhood.com",
        },
      },
      {
        network: "arc",
        chainId: 5042002,
        urls: {
          apiURL: "https://testnet.arcscan.app/api",
          browserURL: "https://testnet.arcscan.app",
        },
      },
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
