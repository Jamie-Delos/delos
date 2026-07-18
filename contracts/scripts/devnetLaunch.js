// Full devnet test-launch, end to end, in one process on the in-process Hardhat network.
// No key, no faucet. Deploys our own Uniswap V3 (mirroring Robinhood's), deploys the launchpad,
// launches a coin, then drives its whole lifecycle: pre-graduation buy (creator keeps 100%),
// buys until it graduates, post-graduation buy (fees flip to 80/20), collecting fees at each stage.
//
//   npx hardhat run scripts/devnetLaunch.js
const hre = require("hardhat");
const { ethers } = hre;
const standardFor = require("./standards");
const { computeLaunchParams, computeGraduationTick } = require("./lib/launchParams");

const FACTORY = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const NFTDESC = require("@uniswap/v3-periphery/artifacts/contracts/libraries/NFTDescriptor.sol/NFTDescriptor.json");
const POSDESC = require("@uniswap/v3-periphery/artifacts/contracts/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json");
const NPM = require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
const ROUTER = require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

const WETH_ABI = ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
const SWAP_ABI = ["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"];
const eth = (n) => ethers.formatEther(n);

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
  const [deployer, creator, buyer] = await ethers.getSigners();
  console.log("=== RobinPad devnet test launch ===");
  console.log("deployer:", deployer.address, "| creator:", creator.address, "| buyer:", buyer.address);

  // --- 1. Uniswap V3 (our own, mirrors Robinhood's on-chain deployment) ----
  const wethC = await (await ethers.getContractFactory("WETH9")).deploy();
  await wethC.waitForDeployment();
  const WETH = await wethC.getAddress();
  const uniFactory = await dep(deployer, FACTORY, FACTORY.bytecode);
  const nftLib = await dep(deployer, NFTDESC, NFTDESC.bytecode);
  const posDesc = await dep(deployer, POSDESC, linkBytecode(POSDESC, { NFTDescriptor: nftLib }), [WETH, ethers.encodeBytes32String("ETH")]);
  const npm = await dep(deployer, NPM, NPM.bytecode, [uniFactory, WETH, posDesc]);
  const router = await dep(deployer, ROUTER, ROUTER.bytecode, [ethers.ZeroAddress, uniFactory, npm, WETH]);
  console.log("\n[1] Uniswap V3 up  — factory:", uniFactory.slice(0, 10), "npm:", npm.slice(0, 10), "router:", router.slice(0, 10));

  // --- 2. Launchpad --------------------------------------------------------
  const feeVault = await (await ethers.getContractFactory("FeeVault", deployer)).deploy(deployer.address);
  await feeVault.waitForDeployment();
  const locker = await (await ethers.getContractFactory("LaunchLocker", deployer)).deploy(npm, await feeVault.getAddress(), 2000);
  await locker.waitForDeployment();
  const factory = await (await ethers.getContractFactory("LaunchFactory", deployer)).deploy(npm, WETH, await locker.getAddress());
  await factory.waitForDeployment();
  await (await locker.initFactory(await factory.getAddress())).wait();
  console.log("[2] Launchpad up   — factory:", (await factory.getAddress()).slice(0, 10), "locker:", (await locker.getAddress()).slice(0, 10), "(protocol fee 20% post-grad)");

  // --- 3. One-click launch (as the creator) --------------------------------
  const std = standardFor("robinhood"); // ETH-quoted standard
  const factoryAddr = await factory.getAddress();
  const nonce = await ethers.provider.getTransactionCount(factoryAddr);
  const predicted = ethers.getCreateAddress({ from: factoryAddr, nonce });
  const p = computeLaunchParams({ token: predicted, weth: WETH, tokenDecimals: 18, quoteDecimals: std.quoteDecimals, fee: std.fee, priceWethPerToken: std.launchPriceWethPerToken });
  const gradTick = computeGraduationTick({ token: predicted, weth: WETH, tokenDecimals: 18, quoteDecimals: std.quoteDecimals, graduationPriceWethPerToken: std.graduationPriceWethPerToken });
  const supply = 1_000_000_000n * 10n ** 18n;
  const rc = await (await factory.connect(creator).createLaunch({ name: "Devnet Doge", symbol: "DDOGE", totalSupply: supply, decimals: 18, fee: std.fee, sqrtPriceX96: p.sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, graduationTick: gradTick })).wait();
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "Launched");
  const token = ev.args.token, tokenId = ev.args.tokenId;
  console.log("\n[3] Launched 'Devnet Doge' ($DDOGE)  — token:", token.slice(0, 10), "pool:", ev.args.pool.slice(0, 10), "liquidity:", ev.args.liquidity.toString());
  console.log("    graduated?", await locker.isGraduated(tokenId), "(fresh launch → creator keeps 100% of fees)");

  // --- helpers -------------------------------------------------------------
  const weth = new ethers.Contract(WETH, WETH_ABI, buyer);
  const swap = new ethers.Contract(router, SWAP_ABI, buyer);
  await (await weth.deposit({ value: ethers.parseEther("60") })).wait();
  await (await weth.approve(router, ethers.MaxUint256)).wait();
  const buy = async (amt) => (await (await swap.exactInputSingle({ tokenIn: WETH, tokenOut: token, fee: std.fee, recipient: buyer.address, amountIn: ethers.parseEther(amt), amountOutMinimum: 0, sqrtPriceLimitX96: 0 })).wait());
  const collect = async (label) => {
    const vault = await feeVault.getAddress();
    const cb = await weth.balanceOf(creator.address), vb = await weth.balanceOf(vault);
    await (await locker.collectFees(tokenId)).wait();
    const cg = (await weth.balanceOf(creator.address)) - cb, vg = (await weth.balanceOf(vault)) - vb;
    console.log(`    ${label}: creator +${eth(cg)} WETH | vault +${eth(vg)} WETH`);
    return { cg, vg };
  };

  // --- 4. Lifecycle --------------------------------------------------------
  console.log("\n[4] pre-graduation buy: 0.02 WETH");
  await buy("0.02");
  console.log("    graduated?", await locker.isGraduated(tokenId));
  await collect("fees after pre-grad buy");

  console.log("\n[5] buying until graduation (~$60k mcap)…");
  let spent = 0;
  for (let i = 0; i < 60 && !(await locker.isGraduated(tokenId)); i++) { await buy("0.5"); spent += 0.5; }
  console.log(`    graduated after ~${spent} WETH of buys → ${await locker.isGraduated(tokenId)}`);

  console.log("\n[6] post-graduation buy: 0.5 WETH (fees now split 80/20)");
  await buy("0.5");
  const r = await collect("fees after post-grad buy");
  const ratio = r.vg > 0n ? Number(r.cg * 100n / r.vg) / 100 : 0;
  console.log(`    creator:vault ratio = ${ratio.toFixed(2)} (expect ~4.0 for 80/20)`);

  console.log("\n=== devnet test launch complete ✓ ===");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
