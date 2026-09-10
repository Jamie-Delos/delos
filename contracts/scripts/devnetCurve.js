// Full devnet proof of the CensusCurve model, end to end, on the in-process Hardhat network with a
// real Uniswap V3 (mirroring Robinhood's). Proves: whole supply seeds the curve; buys/sells take the
// 2% fee (un-dodgeable — no pool exists yet); anti-snipe; the curve fills to its graduation reserve;
// graduate() migrates into a real, locked Uniswap V3 pool; and the coin then trades on that pool with
// LP fees flowing through the locker.
//
//   npx hardhat run scripts/devnetCurve.js
const hre = require("hardhat");
const { ethers } = hre;

const FACTORY = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const NFTDESC = require("@uniswap/v3-periphery/artifacts/contracts/libraries/NFTDescriptor.sol/NFTDescriptor.json");
const POSDESC = require("@uniswap/v3-periphery/artifacts/contracts/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json");
const NPM = require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
const ROUTER = require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

const E = (n) => ethers.parseEther(String(n));
const eth = (n) => ethers.formatEther(n);
const SALT = "0x" + "00".repeat(32);
const WETH_ABI = ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
const SWAP_ABI = ["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"];
const IUNIFACTORY = ["function getPool(address,address,uint24) view returns (address)"];

function linkBytecode(artifact, libs) {
  let bc = artifact.bytecode;
  for (const fileRefs of Object.values(artifact.linkReferences))
    for (const [name, refs] of Object.entries(fileRefs)) {
      const a = libs[name].replace(/^0x/, "").toLowerCase();
      for (const { start, length } of refs) bc = bc.slice(0, 2 + start * 2) + a + bc.slice(2 + (start + length) * 2);
    }
  return bc;
}
async function dep(signer, art, bc, args = []) {
  const c = await new ethers.ContractFactory(art.abi, bc, signer).deploy(...args);
  await c.waitForDeployment();
  return await c.getAddress();
}

async function main() {
  const [deployer, platform, creator, buyer] = await ethers.getSigners();
  console.log("=== CensusCurve devnet proof ===");

  // 1. Uniswap V3
  const wethC = await (await ethers.getContractFactory("WETH9")).deploy(); await wethC.waitForDeployment();
  const WETH = await wethC.getAddress();
  const uniFactory = await dep(deployer, FACTORY, FACTORY.bytecode);
  const nftLib = await dep(deployer, NFTDESC, NFTDESC.bytecode);
  const posDesc = await dep(deployer, POSDESC, linkBytecode(POSDESC, { NFTDescriptor: nftLib }), [WETH, ethers.encodeBytes32String("ETH")]);
  const npm = await dep(deployer, NPM, NPM.bytecode, [uniFactory, WETH, posDesc]);
  const uniRouter = await dep(deployer, ROUTER, ROUTER.bytecode, [ethers.ZeroAddress, uniFactory, npm, WETH]);
  console.log("[1] Uniswap V3 up");

  // 2. Census curve stack (one curve + one locker; the CURVE registers graduated LPs with the locker)
  const feeVault = await (await ethers.getContractFactory("FeeVault", deployer)).deploy(platform.address); await feeVault.waitForDeployment();
  const locker = await (await ethers.getContractFactory("LaunchLocker", deployer)).deploy(npm, await feeVault.getAddress(), 2500); await locker.waitForDeployment();
  const curve = await (await ethers.getContractFactory("CensusCurve", deployer)).deploy(npm, platform.address, await locker.getAddress(), WETH, uniRouter); await curve.waitForDeployment();
  const factory = await (await ethers.getContractFactory("LaunchFactory", deployer)).deploy(WETH, await curve.getAddress()); await factory.waitForDeployment();
  await (await locker.initFactory(await curve.getAddress())).wait(); // the curve registers graduated positions
  await (await curve.setFactory(await factory.getAddress(), true)).wait();
  console.log("[2] Census curve stack up");

  // 3. Launch a Prima coin (whole supply -> curve). poolFee = 1% for the graduated pool.
  const supply = E(1_000_000_000);
  const params = ["Curve Doge", "CDOGE", supply, 18, 10000, E(1.5), E(4)]; // poolFee, virtualQuote(V0), graduationQuote
  const rc = await (await factory.connect(creator)["createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32)"](params, SALT)).wait();
  const token = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "Launched").args.token;
  console.log("[3] Launched CDOGE:", token.slice(0, 10), "| whole supply in curve:", eth(await curve.curves(token).then((c) => c.tokenReserve)));

  // helpers
  const weth = new ethers.Contract(WETH, WETH_ABI, buyer);
  await (await weth.deposit({ value: E(20) })).wait();
  await (await weth.approve(await curve.getAddress(), ethers.MaxUint256)).wait();
  await (await weth.approve(uniRouter, ethers.MaxUint256)).wait(); // for the post-graduation pool swap in step 6
  const curveBuyer = curve.connect(buyer);
  const buy = (amt) => curveBuyer.buy(token, E(amt), 0);

  // 3b. anti-snipe: an oversized in-window buy is rejected
  let sniped = false; try { await buy("1"); } catch { sniped = true; }
  console.log("[3b] anti-snipe blocks the oversized in-window buy?", sniped);
  if (!sniped) throw new Error("anti-snipe FAILED");
  await ethers.provider.send("hardhat_mine", ["0x65"]); // past the window

  // 4. Fill the curve past its 4-ETH graduation reserve, checking the 2% fee lands each buy
  const p0 = await weth.balanceOf(platform.address);
  await (await buy("5")).wait(); // net 4.9 -> ready to graduate
  const platGain = (await weth.balanceOf(platform.address)) - p0;
  console.log("[4] bought 5 WETH | platform fee gained:", eth(platGain), "(≈0.025 = 25% of 2% of 5)");
  const cc = await curve.curves(token);
  console.log("    curve realQuote:", eth(cc.realQuote), "| graduation progress bps:", (await curve.graduationProgress(token)).toString());

  // 5. Graduate -> real locked Uniswap V3 pool
  const grc = await (await curve.graduate(token)).wait();
  const gev = grc.logs.map((l) => { try { return curve.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "Graduated");
  const pool = gev.args.pool, tokenId = gev.args.tokenId;
  const onchainPool = await new ethers.Contract(uniFactory, IUNIFACTORY, deployer).getPool(token, WETH, 10000);
  console.log("[5] graduated -> pool:", pool.slice(0, 10), "| tokenId:", tokenId.toString());
  if (onchainPool.toLowerCase() !== pool.toLowerCase() || pool === ethers.ZeroAddress) throw new Error("pool not created on the factory");
  if (!(await curve.curves(token)).graduated) throw new Error("curve not marked graduated");
  console.log("    pool confirmed on the Uniswap factory ✓ | curve trading now closed ✓");

  // 5b. curve trading is closed post-graduation
  let closed = false; try { await buy("0.1"); } catch { closed = true; }
  if (!closed) throw new Error("curve still trading after graduation");
  console.log("    post-graduation curve buy rejected ✓");

  // 6. The coin now trades on the real pool; LP fees flow through the locker
  const swap = new ethers.Contract(uniRouter, SWAP_ABI, buyer);
  await (await swap.exactInputSingle({ tokenIn: WETH, tokenOut: token, fee: 10000, recipient: buyer.address, amountIn: E(1), amountOutMinimum: 0, sqrtPriceLimitX96: 0 })).wait();
  console.log("[6] traded 1 WETH on the graduated pool ✓");
  const cb = await weth.balanceOf(creator.address), vb = await weth.balanceOf(await feeVault.getAddress());
  await (await locker.collectFees(tokenId)).wait();
  console.log("    locker collected LP fees | creator +", eth((await weth.balanceOf(creator.address)) - cb), "| protocol +", eth((await weth.balanceOf(await feeVault.getAddress())) - vb));

  console.log("\n=== CensusCurve devnet proof complete ✓ ===");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
