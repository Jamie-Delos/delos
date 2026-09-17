// Verifies the deployed launchpad contracts on Blockscout, unattended, using the constructor args
// recorded in deployments.<network>.json by deploy.js.
//
//   npx hardhat run scripts/verifyAll.js --network robinhoodTestnet
//
// Every launched token (LaunchToken) shares identical creation bytecode, so Blockscout auto-marks
// each new one as verified once ANY LaunchToken is verified — no per-token step needed. If you want
// belt-and-suspenders, verify one LaunchToken address once and the rest propagate.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function verify(name, address, args) {
  if (!address) { console.log(`  - ${name}: no address recorded, skipped`); return; }
  try {
    await hre.run("verify:verify", { address, constructorArguments: args || [] });
    console.log(`  ✓ ${name} ${address}`);
  } catch (e) {
    const msg = (e.message || "").toLowerCase();
    if (msg.includes("already verified") || msg.includes("already been verified")) {
      console.log(`  • ${name} ${address} (already verified)`);
    } else {
      console.log(`  ✗ ${name} ${address}: ${e.message.split("\n")[0]}`);
    }
  }
}

async function main() {
  const netName = hre.network.name;
  const depFile = path.join(__dirname, "..", `deployments.${netName}.json`);
  if (!fs.existsSync(depFile)) throw new Error(`No deployments.${netName}.json — run deploy.js first.`);
  const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));
  const v = dep.verify || {};

  const names = Object.keys(v);
  console.log(`Verifying ${names.length} launchpad contract(s) on ${netName} (Blockscout)…`);
  // Iterate EVERY entry deploy.js recorded in the `verify` map so none are skipped — this now
  // covers CensusCurve, LaunchFactoryV2, FeeSplitter and DividendVaultDeployer too (CX-V6). The
  // address is the same-named top-level field; the args are the recorded constructor-args array.
  for (const [name, args] of Object.entries(v)) {
    await verify(name, dep[name], args);
  }

  // WETH9 (only exists when we deployed our own Uniswap stack, e.g. testnet).
  const uniFile = path.join(__dirname, "..", `uniswap.${netName}.json`);
  if (fs.existsSync(uniFile)) {
    const uni = JSON.parse(fs.readFileSync(uniFile, "utf8"));
    await verify("WETH9", uni.WETH, []);
  }
  console.log("Done. New launch tokens verify automatically via bytecode match.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
