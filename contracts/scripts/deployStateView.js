// Deploys CensusStateView for a PoolManager on networks without the official Uniswap StateView (testnets).
//   POOL_MANAGER_ADDRESS=0x... npx hardhat run scripts/deployStateView.js --network robinhoodTestnet
const hre = require("hardhat");
async function main() {
  if (hre.network.name === "robinhood") throw new Error("mainnet uses the official Uniswap StateView; do not deploy this there");
  const manager = process.env.POOL_MANAGER_ADDRESS;
  if (!manager || (await hre.ethers.provider.getCode(manager)) === "0x") throw new Error("POOL_MANAGER_ADDRESS missing or has no code");
  const [deployer] = await hre.ethers.getSigners();
  const view = await (await hre.ethers.getContractFactory("CensusStateView")).deploy(manager);
  await view.waitForDeployment();
  console.log(`CensusStateView: ${await view.getAddress()} (PoolManager ${manager}, deployer ${deployer.address})`);
  console.log(`VITE_STATE_VIEW=${await view.getAddress()}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
