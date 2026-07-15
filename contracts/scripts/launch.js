// Launches one test token through a deployed LaunchFactory.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const ADDR = require("./addresses");
const { computeLaunchParams, computeGraduationTick } = require("./lib/launchParams");

// ---- Protocol-fixed launch standard (pump.fun v1 style, one-click) --------
// Every token is identical: buyers push price UP the single-sided range as they buy. The token
// "graduates" (fees flip 100% creator -> 80/20) once price reaches ~14x the launch price, which
// corresponds to roughly the pump.fun ~$70k-mcap band after ~3 ETH of buys.
const LAUNCH = {
  name: "Test Token",
  symbol: "TEST",
  decimals: 18,
  totalSupplyWhole: 1_000_000_000n, // 1B tokens
  fee: 10000, // 1% tier — the market anchor
  priceWethPerToken: 1.2e-9, // launch price ~1.2 ETH mcap
  graduationPriceWethPerToken: 2.0e-8, // ~20 ETH mcap, ~3.7 ETH bought to graduate
};
// --------------------------------------------------------------------------

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

  // Predict the token's CREATE address so tick geometry matches the deployed ordering.
  const factoryNonce = await hre.ethers.provider.getTransactionCount(dep.LaunchFactory);
  const predictedToken = hre.ethers.getCreateAddress({ from: dep.LaunchFactory, nonce: factoryNonce });

  const params = computeLaunchParams({
    token: predictedToken,
    weth: uni.WETH,
    tokenDecimals: LAUNCH.decimals,
    fee: LAUNCH.fee,
    priceWethPerToken: LAUNCH.priceWethPerToken,
  });
  const graduationTick = computeGraduationTick({
    token: predictedToken,
    weth: uni.WETH,
    tokenDecimals: LAUNCH.decimals,
    graduationPriceWethPerToken: LAUNCH.graduationPriceWethPerToken,
  });

  console.log("Predicted token:", predictedToken, "(token0:", params.tokenIsToken0 + ")");
  console.log("sqrtPriceX96:", params.sqrtPriceX96);
  console.log("tick range:  ", params.tickLower, "->", params.tickUpper);
  console.log("graduation tick:", graduationTick);

  const totalSupply = LAUNCH.totalSupplyWhole * 10n ** BigInt(LAUNCH.decimals);

  const tx = await factory.createLaunch({
    name: LAUNCH.name,
    symbol: LAUNCH.symbol,
    totalSupply,
    decimals: LAUNCH.decimals,
    fee: LAUNCH.fee,
    sqrtPriceX96: params.sqrtPriceX96,
    tickLower: params.tickLower,
    tickUpper: params.tickUpper,
    graduationTick,
  });
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
