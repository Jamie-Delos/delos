require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();
const fs = require("fs");
const path = require("path");
// Keep the audited V3 artifacts on their original compiler/settings during the V4 migration.
const legacySettings = { optimizer: { enabled: true, runs: 200 }, viaIR: true, debug: { revertStrings: "strip" } };
const legacyOverrides = Object.fromEntries(fs.readdirSync(path.join(__dirname, "contracts"), { recursive: true })
  .map(p => p.replaceAll("\\", "/"))
  .filter(p => p.endsWith(".sol") && !p.startsWith("v4/") && p !== "mocks/V4TestImports.sol")
  .map(p => [`contracts/${p}`, { version: "0.8.24", settings: legacySettings }]));

const { ROBINHOOD_RPC_URL, ROBINHOOD_TESTNET_RPC_URL, ARC_RPC_URL, BASE_SEPOLIA_RPC_URL, PRIVATE_KEY, BASESCAN_API_KEY } = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [{ version: "0.8.24", settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true, // the launch flow has many locals; IR pipeline avoids "stack too deep"
      // Strip require() string messages so LaunchFactoryV2 (which embeds the DividendVault creation
      // code) stays under the 24576-byte EIP-170 limit. Custom errors (revert Foo()) are unaffected and
      // still decode — the router/locker use those for their meaningful failures. (Per-file overrides
      // don't compose with viaIR, so this is applied globally.)
      debug: { revertStrings: "strip" },
    } }, { version: "0.8.26", settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, viaIR: true } }],
    overrides: {
      ...legacyOverrides,
      "contracts/mocks/V4TestImports.sol": {
        version: "0.8.26",
        settings: { evmVersion: "cancun", optimizer: { enabled: true, runs: 200 }, viaIR: true },
      },
    },
  },
  networks: {
    // No static fork here. The legacy Base-mainnet suite (test/integration.fork.test.js, retired
    // 2026-09-22: it targeted the pre-curve LaunchFactory and failed at setup) is replaced by the
    // target-chain suites, which pin their own fork block at runtime (AUDIT_FORK_BLOCK to reproduce):
    //   AUDIT_MAINNET_FORK=1 npx hardhat test test/backend.mainnet-fork.test.js --network hardhat
    //   AUDIT_V4_FORK=1 npx hardhat test test/v4.readiness.test.js --grep "V4 Robinhood fork" --network hardhat
    hardhat: {},
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
