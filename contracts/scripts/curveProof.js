// Live smoke test of the DEPLOYED CensusCurve stack: launch a Prima coin + a small curve buy, on the
// actual network. Reads addresses from deployments.<network>.json.
//   npx hardhat run scripts/curveProof.js --network robinhoodTestnet
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const E = (n) => ethers.parseEther(String(n));
const f = (n) => ethers.formatUnits(n, 18);
const SALT = "0x" + "00".repeat(32);
const WETH_ABI = ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];

async function main() {
  const netName = hre.network.name;
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", `deployments.${netName}.json`), "utf8"));
  const [signer] = await ethers.getSigners();
  const WETH = d.uniswap.WETH;
  console.log(`Live curve proof on ${netName} from ${signer.address}`);

  const factory = await ethers.getContractAt("LaunchFactory", d.LaunchFactory, signer);
  const curve = await ethers.getContractAt("CensusCurve", d.CensusCurve, signer);
  const weth = new ethers.Contract(WETH, WETH_ABI, signer);

  // Launch a Prima coin (ETH-quoted). virtualQuote = 1.5 (start FDV), graduationQuote = 4 ETH.
  const params = ["Curve Test", "CTEST", E(1_000_000_000), 18, 10000, E(1.5), E(4)];
  console.log("launching…");
  const rc = await (await factory["createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32)"](params, SALT)).wait();
  const token = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "Launched").args.token;
  console.log("launched:", token, "| whole supply in curve:", f(await curve.curves(token).then((c) => c.tokenReserve)));

  // A small curve buy; any active launch tax is included by the curve.
  await (await weth.deposit({ value: E(0.0012) })).wait();
  await (await weth.approve(d.CensusCurve, ethers.MaxUint256)).wait();
  const feeVault = d.FeeVault;
  const platBefore = await weth.balanceOf(feeVault);
  const expTokens = await curve.quoteBuy(token, E(0.0008));
  await (await curve.buy(token, E(0.0008), 0)).wait();

  const c = await curve.curves(token);
  console.log("bought 0.0008 WETH ->", f(await ethers.getContractAt("LaunchToken", token, signer).then((t) => t.balanceOf(signer.address))), "CTEST (view predicted", f(expTokens) + ")");
  console.log("curve realQuote:", f(c.realQuote), "(≈0.000784 net of 2%) | platform fee to FeeVault:", f((await weth.balanceOf(feeVault)) - platBefore), "(≈0.000004 = 25% of 2% of 0.0008)");
  console.log("graduation progress bps:", (await curve.graduationProgress(token)).toString());
  console.log("\n=== live curve proof OK ✓ ===");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
