// Pre-deploy check: print the deployer address + balance (never the key). Safe/read-only.
const hre = require("hardhat");
async function main() {
  const [d] = await hre.ethers.getSigners();
  if (!d) { console.log("NO SIGNER — PRIVATE_KEY not set in contracts/.env"); return; }
  const bal = await hre.ethers.provider.getBalance(d.address);
  console.log("network :", hre.network.name);
  console.log("deployer:", d.address);
  console.log("balance :", hre.ethers.formatEther(bal), "ETH");
}
main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
