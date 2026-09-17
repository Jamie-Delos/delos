// Launch a few demo coins on the deployed CensusCurve so the shared site has a populated board.
// c0de-vanity addresses (grinded salt), one small buy so the first coin shows a price.
//   npx hardhat run scripts/demoLaunch.js --network robinhoodTestnet
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const { grindSalt } = require("./lib/grindSalt");
const E = (n) => ethers.parseEther(String(n));
const f = (n) => ethers.formatUnits(n, 18);

const COINS = [
  { name: "Gigachad", symbol: "GIGA" },
  { name: "Space Doge", symbol: "SDOGE" },
  { name: "Diamond Hands", symbol: "DIAM" },
];
const SUPPLY = E(1_000_000_000), DEC = 18, POOLFEE = 10000, VQ = E(1.5), GQ = E(4);
const CREATE_SIG = "createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32)";
const WETH_ABI = ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];

async function main() {
  const net = hre.network.name;
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", `deployments.${net}.json`), "utf8"));
  const [signer] = await ethers.getSigners();
  console.log(`demo launch on ${net} from ${signer.address} | balance ${f(await ethers.provider.getBalance(signer.address))} ETH\n`);

  const factory = await ethers.getContractAt("LaunchFactory", d.LaunchFactory, signer);
  const curve = await ethers.getContractAt("CensusCurve", d.CensusCurve, signer);

  const launched = [];
  for (const c of COINS) {
    const { salt, address } = await grindSalt(d.LaunchFactory, { name: c.name, symbol: c.symbol, totalSupply: SUPPLY, decimals: DEC }, signer.address);
    const params = [c.name, c.symbol, SUPPLY, DEC, POOLFEE, VQ, GQ];
    const rc = await (await factory[CREATE_SIG](params, salt)).wait();
    const token = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "Launched").args.token;
    launched.push({ ...c, token });
    console.log(`launched ${c.name} (${c.symbol}) -> ${token}${token.toLowerCase().endsWith("c0de") ? " [c0de]" : ""}`);
  }

  // small one-tap buy on the first coin so it shows a price + some volume (creator is anti-snipe exempt).
  // Uses buyWithETH: native ETH in, wrapped + bought in a single tx (proves the new one-tap path on-chain).
  await (await curve.buyWithETH(launched[0].token, 0, { value: E(0.0006) })).wait();
  console.log(`\nbought 0.0006 ETH of ${launched[0].symbol} via buyWithETH | graduation progress ${(await curve.graduationProgress(launched[0].token)).toString()} bps`);

  console.log("\nDEMO COINS:");
  for (const c of launched) console.log(`  ${c.symbol.padEnd(6)} ${c.token}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
