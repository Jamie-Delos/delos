// Closes the on-chain proof for the Prima coin launched by launch.js: wrap ETH -> WETH, buy the coin
// (push toward graduation), then collect the creator's fees. Buys as much as the wallet can spare
// (capped), so graduation depends on how much faucet ETH is available.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const TOKEN = "0x54c2C5BB8b462dc4ec2f1f5B5Ac8E652a306C0de"; // Prima "Test Token", launched by launch.js
const TOKEN_ID = 1n;
const FEE = 10000; // 1% pool tier
const f = (x) => hre.ethers.formatEther(x);

const WETH_ABI = ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"];
const ROUTER_ABI = ["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"];
const LOCKER_ABI = ["function collectFees(uint256) returns (uint256,uint256)", "function isGraduated(uint256) view returns (bool)"];

async function main() {
  const net = hre.network.name;
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", `deployments.${net}.json`), "utf8"));
  const uni = JSON.parse(fs.readFileSync(path.join(__dirname, "..", `uniswap.${net}.json`), "utf8"));
  const [signer] = await hre.ethers.getSigners();
  const me = signer.address;

  const weth = await hre.ethers.getContractAt(WETH_ABI, uni.WETH, signer);
  const token = await hre.ethers.getContractAt(ERC20_ABI, TOKEN, signer);
  const router = await hre.ethers.getContractAt(ROUTER_ABI, uni.SwapRouter02, signer);
  const locker = await hre.ethers.getContractAt(LOCKER_ABI, dep.LaunchLocker, signer);

  const bal = await hre.ethers.provider.getBalance(me);
  console.log("deployer ETH balance:", f(bal));
  const reserve = hre.ethers.parseEther(process.env.GAS_RESERVE || "0.1"); // keep some for gas
  const cap = hre.ethers.parseEther(process.env.BUY_CAP || "4.5");          // ~graduation needs ~4 ETH of buys
  let spend = bal > reserve ? bal - reserve : 0n;
  if (spend > cap) spend = cap;
  if (spend <= 0n) throw new Error("not enough ETH to buy — top up from the faucet");
  console.log("buying with:", f(spend), "WETH\n");

  console.log("[1] wrap ETH -> WETH");
  await (await weth.deposit({ value: spend })).wait();
  console.log("[2] approve router");
  await (await weth.approve(uni.SwapRouter02, spend)).wait();
  console.log("[3] swap WETH -> Test Token");
  await (await router.exactInputSingle({ tokenIn: uni.WETH, tokenOut: TOKEN, fee: FEE, recipient: me, amountIn: spend, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n })).wait();
  console.log("    bought:", f(await token.balanceOf(me)), await token.symbol());

  const grad = await locker.isGraduated(TOKEN_ID).catch(() => "n/a");
  console.log("[4] graduated?", grad);

  console.log("[5] collect creator fees");
  const before = await weth.balanceOf(me);
  await (await locker.collectFees(TOKEN_ID)).wait();
  const gained = (await weth.balanceOf(me)) - before;
  console.log("    creator collected:", f(gained), "WETH  ✓ full Prima lifecycle: launch -> buy -> fees");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
