// Deploys the launchpad: FeeVault -> LaunchLocker -> LaunchFactory, then wires them together.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const ADDR = require("./addresses");

const PROTOCOL_FEE_BPS = 2000; // 20% of POST-graduation fees -> vault (for $TOKEN buyback & burn)

function loadUni(netName) {
  // Prefer a freshly-deployed Uniswap stack (uniswap.<net>.json) over the hardcoded book.
  const file = path.join(__dirname, "..", `uniswap.${netName}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  return ADDR[netName];
}

async function main() {
  const netName = hre.network.name;
  const uni = loadUni(netName);
  if (!uni || !uni.NonfungiblePositionManager) {
    throw new Error(`No Uniswap addresses for "${netName}". For a testnet, run deployUniswapV3.js first.`);
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deploying on ${netName} (chainId ${uni.chainId}) from ${deployer.address}`);

  const FeeVault = await hre.ethers.getContractFactory("FeeVault");
  const feeVault = await FeeVault.deploy(deployer.address);
  await feeVault.waitForDeployment();
  const feeVaultAddr = await feeVault.getAddress();
  console.log("FeeVault:      ", feeVaultAddr);

  const LaunchLocker = await hre.ethers.getContractFactory("LaunchLocker");
  const locker = await LaunchLocker.deploy(uni.NonfungiblePositionManager, feeVaultAddr, PROTOCOL_FEE_BPS);
  await locker.waitForDeployment();
  const lockerAddr = await locker.getAddress();
  console.log("LaunchLocker:  ", lockerAddr);

  const LaunchFactory = await hre.ethers.getContractFactory("LaunchFactory");
  const factory = await LaunchFactory.deploy(uni.NonfungiblePositionManager, uni.WETH, lockerAddr);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("LaunchFactory: ", factoryAddr);

  const tx = await locker.initFactory(factoryAddr);
  await tx.wait();
  console.log("Locker wired to factory.");

  const out = {
    network: netName,
    chainId: uni.chainId,
    deployedAt: new Date().toISOString(),
    FeeVault: feeVaultAddr,
    LaunchLocker: lockerAddr,
    LaunchFactory: factoryAddr,
    uniswap: uni,
    // Constructor args, recorded so scripts/verifyAll.js can verify on Blockscout unattended.
    verify: {
      FeeVault: [deployer.address],
      LaunchLocker: [uni.NonfungiblePositionManager, feeVaultAddr, PROTOCOL_FEE_BPS],
      LaunchFactory: [uni.NonfungiblePositionManager, uni.WETH, lockerAddr],
    },
  };
  const file = path.join(__dirname, "..", `deployments.${netName}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nSaved ${file}`);
  console.log("Add to .env:\n" +
    `FACTORY_ADDRESS=${factoryAddr}\nLOCKER_ADDRESS=${lockerAddr}\nFEE_VAULT_ADDRESS=${feeVaultAddr}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
