// Launches one Maxima (stock-dividend) token through the deployed LaunchFactoryV2.
// On testnet the real tokenised-stock pools don't exist, so this proves the LAUNCH (token + vault + pool
// + c0de address); the dividend distribution is proven on devnet (scripts/devnetV2.js) and runs on mainnet
// where the stock pools are live.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { computeLaunchParams, computeGraduationTick } = require("./lib/launchParams");
const { grindSalt } = require("./lib/grindSalt");
const standardFor = require("./standards");

const TOKEN = { name: "Iron Man", symbol: "IRON", decimals: 18, totalSupplyWhole: 1_000_000_000n };
const BASKET = ["0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", "0x322F0929c4625eD5bAd873c95208D54E1c003b2d"]; // NVDA, TSLA (mainnet addrs; stored, not swapped on testnet)
const WEIGHTS = [5000, 5000]; // 50/50, sums to 10000 bps
const PATHS = ["0x", "0x"];   // empty = single-hop; irrelevant on testnet (no stock pools)

async function main() {
  const netName = hre.network.name;
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", `deployments.${netName}.json`), "utf8"));
  const uni = JSON.parse(fs.readFileSync(path.join(__dirname, "..", `uniswap.${netName}.json`), "utf8"));
  const [signer] = await hre.ethers.getSigners();
  const factory = await hre.ethers.getContractAt("LaunchFactoryV2", dep.LaunchFactoryV2, signer);
  const std = standardFor(netName);
  const totalSupply = TOKEN.totalSupplyWhole * 10n ** BigInt(TOKEN.decimals);

  const { salt, address: predicted, tries } = await grindSalt(dep.LaunchFactoryV2, {
    name: TOKEN.name, symbol: TOKEN.symbol, totalSupply, decimals: TOKEN.decimals,
  }, signer.address);
  console.log(`Grinded c0de salt in ${tries} tries -> ${predicted}`);

  const p = computeLaunchParams({ token: predicted, weth: uni.WETH, tokenDecimals: TOKEN.decimals, quoteDecimals: std.quoteDecimals, fee: std.fee, priceWethPerToken: std.launchPriceWethPerToken });
  const graduationTick = computeGraduationTick({ token: predicted, weth: uni.WETH, tokenDecimals: TOKEN.decimals, quoteDecimals: std.quoteDecimals, graduationPriceWethPerToken: std.graduationPriceWethPerToken });

  const tx = await factory.createLaunch(
    { name: TOKEN.name, symbol: TOKEN.symbol, totalSupply, decimals: TOKEN.decimals, fee: std.fee, sqrtPriceX96: p.sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, graduationTick },
    BASKET, WEIGHTS, PATHS, salt,
  );
  console.log("createLaunch tx:", tx.hash);
  const rc = await tx.wait();
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "LaunchedV2");
  if (ev) {
    console.log("\nLaunched Maxima!");
    console.log("  token:  ", ev.args.token);
    console.log("  pool:   ", ev.args.pool);
    console.log("  vault:  ", ev.args.vault);
    console.log("  tokenId:", ev.args.tokenId.toString());
  } else {
    console.log("LaunchedV2 event not found; check the tx on the explorer.");
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
