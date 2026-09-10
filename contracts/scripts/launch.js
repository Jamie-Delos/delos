// Launches one test token through a deployed LaunchFactory.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const ADDR = require("./addresses");
const standardFor = require("./standards");
const { computeLaunchParams, computeGraduationTick } = require("./lib/launchParams");
const { grindSalt } = require("./lib/grindSalt");

const TOKEN = { name: "Test Token", symbol: "TEST", decimals: 18, totalSupplyWhole: 1_000_000_000n };

function loadDeployment(netName) {
  const file = path.join(__dirname, "..", `deployments.${netName}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  if (process.env.FACTORY_ADDRESS) return { LaunchFactory: process.env.FACTORY_ADDRESS, uniswap: ADDR[netName] };
  throw new Error(`No deployment found for ${netName}. Run scripts/deploy.js first.`);
}

function loadUni(netName) {
  const file = path.join(__dirname, "..", `uniswap.${netName}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  return ADDR[netName];
}

async function main() {
  const netName = hre.network.name;
  const dep = loadDeployment(netName);
  const uni = loadUni(netName);
  const [signer] = await hre.ethers.getSigners();

  const factory = await hre.ethers.getContractAt("LaunchFactory", dep.LaunchFactory, signer);

  // Per-network economics (ETH- vs USDC-quoted). uni.quoteDecimals overrides if the address book set it.
  const std = standardFor(netName);
  const quoteDecimals = uni.quoteDecimals ?? std.quoteDecimals;
  console.log(`Launch standard for ${netName}: quoteDecimals=${quoteDecimals} fee=${std.fee}`);

  // Grind a CREATE2 vanity salt so the token deploys to a `…c0de` address (Census signifier);
  // the deterministic address is also used for the tick geometry (ordering vs WETH).
  const { salt, address: predictedToken, tries } = await grindSalt(dep.LaunchFactory, {
    name: TOKEN.name, symbol: TOKEN.symbol,
    totalSupply: TOKEN.totalSupplyWhole * 10n ** BigInt(TOKEN.decimals), decimals: TOKEN.decimals,
  });
  console.log(`Grinded c0de vanity salt in ${tries} tries -> ${predictedToken}`);

  const params = computeLaunchParams({
    token: predictedToken,
    weth: uni.WETH,
    tokenDecimals: TOKEN.decimals,
    quoteDecimals,
    fee: std.fee,
    priceWethPerToken: std.launchPriceWethPerToken,
  });
  const graduationTick = computeGraduationTick({
    token: predictedToken,
    weth: uni.WETH,
    tokenDecimals: TOKEN.decimals,
    quoteDecimals,
    graduationPriceWethPerToken: std.graduationPriceWethPerToken,
  });

  console.log("Predicted token:", predictedToken, "(token0:", params.tokenIsToken0 + ")");
  console.log("sqrtPriceX96:", params.sqrtPriceX96);
  console.log("tick range:  ", params.tickLower, "->", params.tickUpper);
  console.log("graduation tick:", graduationTick);

  const totalSupply = TOKEN.totalSupplyWhole * 10n ** BigInt(TOKEN.decimals);

  const tx = await factory.createLaunch({
    name: TOKEN.name,
    symbol: TOKEN.symbol,
    totalSupply,
    decimals: TOKEN.decimals,
    fee: std.fee,
    sqrtPriceX96: params.sqrtPriceX96,
    tickLower: params.tickLower,
    tickUpper: params.tickUpper,
    graduationTick,
  }, salt);
  console.log("createLaunch tx:", tx.hash);
  const receipt = await tx.wait();

  const ev = receipt.logs
    .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((p) => p && p.name === "Launched");

  if (ev) {
    console.log("\nLaunched!");
    console.log("  token:    ", ev.args.token);
    console.log("  pool:     ", ev.args.pool);
    console.log("  tokenId:  ", ev.args.tokenId.toString());
    console.log("  liquidity:", ev.args.liquidity.toString());
    if (ev.args.token.toLowerCase() !== predictedToken.toLowerCase()) {
      console.warn("  WARNING: actual token != predicted; ordering may differ. Re-run if pool init failed.");
    }
  } else {
    console.log("Launched event not found; check the tx on the explorer.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
