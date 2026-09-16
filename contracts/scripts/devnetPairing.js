// Company-coin pairing proof. A Maxima coin ($IRON, TSLA/COST basket) is launched, traded and graduated
// into its locked pool; a post-graduation distribution is left UNCLAIMED in its vault; then a second coin
// ($SUIT) launches ANCHORED TO $IRON — its curve is priced in IRON and buyers pay in IRON — and trades.
// Proves the contracts already accept a graduated coin as the quote asset (no allowlist on main), and
// leaves a live state the frontend's devnet mode can render: a graduated "company coin", a coin anchored
// to it, and claimable holder rewards.
//
//   npx hardhat node                                   (terminal 1)
//   OUT=<addresses.json> npx hardhat run scripts/devnetPairing.js --network localhost
//
// Without OUT it runs on the in-process network as a plain proof and prints the addresses.
const fs = require("fs");
const hre = require("hardhat");
const { ethers } = hre;

const FACTORY = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const NFTDESC = require("@uniswap/v3-periphery/artifacts/contracts/libraries/NFTDescriptor.sol/NFTDescriptor.json");
const POSDESC = require("@uniswap/v3-periphery/artifacts/contracts/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json");
const NPM = require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
const ROUTER = require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

const E = (n) => ethers.parseEther(String(n));
const f = (n) => ethers.formatUnits(n, 18);
const SALT = "0x" + "00".repeat(32);
const MAXTICK = 887220;
const WETH_ABI = ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
const ERC20_ABI = ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function symbol() view returns (string)"];
const LAUNCH_SIG_V2 = "createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])";
const LAUNCH_SIG_V1 = "createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32,address,address[])";

function link(art, libs) {
  let bc = art.bytecode;
  for (const fr of Object.values(art.linkReferences)) for (const [n, refs] of Object.entries(fr)) {
    const a = libs[n].replace(/^0x/, "").toLowerCase();
    for (const { start, length } of refs) bc = bc.slice(0, 2 + start * 2) + a + bc.slice(2 + (start + length) * 2);
  }
  return bc;
}
async function dep(signer, art, bc, args = []) {
  const c = await new ethers.ContractFactory(art.abi, bc, signer).deploy(...args);
  await c.waitForDeployment();
  return await c.getAddress();
}
const parsed = (rc, iface, name) => rc.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === name);

async function main() {
  const [deployer, platform, creator, buyer1, buyer2] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log(`=== Company-coin pairing proof (chainId ${net.chainId}) ===`);

  // --- Uniswap V3 + mock stocks/pools the vault buys through ---
  const wc = await (await ethers.getContractFactory("WETH9")).deploy(); await wc.waitForDeployment();
  const WETH = await wc.getAddress();
  const uf = await dep(deployer, FACTORY, FACTORY.bytecode);
  const nft = await dep(deployer, NFTDESC, NFTDESC.bytecode);
  const pd = await dep(deployer, POSDESC, link(POSDESC, { NFTDescriptor: nft }), [WETH, ethers.encodeBytes32String("ETH")]);
  const npmAddr = await dep(deployer, NPM, NPM.bytecode, [uf, WETH, pd]);
  const uniRouter = await dep(deployer, ROUTER, ROUTER.bytecode, [ethers.ZeroAddress, uf, npmAddr, WETH]);
  const npm = new ethers.Contract(npmAddr, NPM.abi, deployer);
  const weth = new ethers.Contract(WETH, WETH_ABI, deployer);

  const deployTok = async (name, sym) => {
    const t = await (await ethers.getContractFactory("LaunchToken", deployer)).deploy(name, sym, E(1_000_000), 18, deployer.address);
    await t.waitForDeployment(); return await t.getAddress();
  };
  const seedPool = async (a, b) => {
    const [t0, t1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    await (await npm.createAndInitializePoolIfNecessary(t0, t1, 3000, (2n ** 96n).toString())).wait();
    for (const t of [a, b]) {
      if (t.toLowerCase() === WETH.toLowerCase()) { await (await weth.deposit({ value: E(500) })).wait(); await (await weth.approve(npmAddr, ethers.MaxUint256)).wait(); }
      else await (await new ethers.Contract(t, ERC20_ABI, deployer).approve(npmAddr, ethers.MaxUint256)).wait();
    }
    await (await npm.mint({ token0: t0, token1: t1, fee: 3000, tickLower: -MAXTICK, tickUpper: MAXTICK, amount0Desired: E(500), amount1Desired: E(500), amount0Min: 0, amount1Min: 0, recipient: deployer.address, deadline: (await ethers.provider.getBlock("latest")).timestamp + 600 })).wait();
  };
  const USDG = await deployTok("Global Dollar", "USDG"); await seedPool(WETH, USDG);
  const TSLA = await deployTok("Tesla", "TSLA"); await seedPool(TSLA, WETH);
  const COST = await deployTok("Costco", "COST"); await seedPool(COST, USDG);
  const zx = await (await ethers.getContractFactory("MockZeroEx", deployer)).deploy(); await zx.waitForDeployment();
  console.log("[1] Uniswap V3 + TSLA(direct)/COST(via USDG) pools up");

  // --- Census curve stack: curve, locker, fee vault, BOTH factories ---
  const feeVault = await (await ethers.getContractFactory("FeeVault", deployer)).deploy(platform.address); await feeVault.waitForDeployment();
  const locker = await (await ethers.getContractFactory("LaunchLocker", deployer)).deploy(npmAddr, await feeVault.getAddress(), 2500); await locker.waitForDeployment();
  const curve = await (await ethers.getContractFactory("CensusCurve", deployer)).deploy(npmAddr, platform.address, await locker.getAddress(), WETH, uniRouter); await curve.waitForDeployment();
  const curveAddr = await curve.getAddress();
  const factoryV2 = await (await ethers.getContractFactory("LaunchFactoryV2", deployer)).deploy(WETH, curveAddr, uniRouter, 3000, await zx.getAddress()); await factoryV2.waitForDeployment();
  const factoryV1 = await (await ethers.getContractFactory("LaunchFactory", deployer)).deploy(WETH, curveAddr); await factoryV1.waitForDeployment();
  await (await locker.initFactory(curveAddr)).wait();
  await (await curve.setFactory(await factoryV2.getAddress(), true)).wait();
  await (await curve.setFactory(await factoryV1.getAddress(), true)).wait();
  console.log("[2] Census curve stack up (Prima + Maxima factories)");

  // --- Maxima $IRON: 50/50 TSLA/COST basket, all of the creator side to holders ---
  const params = ["Iron Man", "IRON", E(1_000_000_000), 18, 10000, E(1.5), E(4)];
  const costPath = ethers.solidityPacked(["address", "uint24", "address", "uint24", "address"], [WETH, 3000, USDG, 3000, COST]);
  const rc = await (await factoryV2.connect(creator)[LAUNCH_SIG_V2](params, [TSLA, COST], [5000, 5000], ["0x", costPath], SALT, WETH, 10000, [])).wait();
  const lev = parsed(rc, factoryV2.interface, "LaunchedV2");
  const IRON = lev.args.token, ironVault = lev.args.vault;
  const iron = new ethers.Contract(IRON, ERC20_ABI, deployer);
  const vault = await ethers.getContractAt("DividendVault", ironVault, deployer);
  console.log("[3] Launched $IRON (Maxima) | vault", ironVault);

  for (const b of [buyer1, buyer2]) { const w = new ethers.Contract(WETH, WETH_ABI, b); await (await w.deposit({ value: E(10) })).wait(); await (await w.approve(curveAddr, ethers.MaxUint256)).wait(); }
  await ethers.provider.send("hardhat_mine", ["0x65"]); // past the anti-snipe window
  await (await curve.connect(buyer1).buy(IRON, E(2), 0)).wait();
  await (await curve.connect(buyer2).buy(IRON, E(1), 0)).wait();
  await (await vault.connect(creator).distribute([0, 0])).wait(); // first round: swapped into the basket
  await (await vault.connect(buyer1).claim()).wait();
  await (await vault.connect(buyer2).claim()).wait();
  console.log("[4] curve buys + first distribution claimed");

  // --- fill + graduate ---
  await (await curve.connect(buyer1).buy(IRON, E(3), 0)).wait();
  await (await curve.graduate(IRON)).wait();
  if (!(await curve.curves(IRON)).graduated) throw new Error("IRON did not graduate");
  console.log("[5] ✓ $IRON graduated into a locked Uniswap pool — it is now a company coin");

  // --- post-grad LP fees -> vault -> a second distribution, left UNCLAIMED ---
  await (await weth.approve(uniRouter, ethers.MaxUint256)).wait();
  const uni = new ethers.Contract(uniRouter, ["function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)"], deployer);
  await (await weth.deposit({ value: E(2) })).wait();
  await (await uni.exactInputSingle([WETH, IRON, 10000, deployer.address, E(1), 0, 0])).wait();
  const tid = (await curve.queryFilter(curve.filters.Graduated(IRON)))[0].args.tokenId;
  await (await locker.collectFees(tid)).wait();
  await (await vault.connect(creator).distribute([0, 0])).wait();
  const owedT = await vault.withdrawableOf(buyer1.address, TSLA), owedC = await vault.withdrawableOf(buyer1.address, COST);
  if (owedT === 0n && owedC === 0n) throw new Error("post-grad distribution left nothing claimable");
  console.log(`[6] ✓ post-grad distribution unclaimed — buyer1 can withdraw TSLA ${f(owedT)} / COST ${f(owedC)}`);

  // --- Prima $SUIT anchored to $IRON: the curve is priced in IRON and buyers pay in IRON ---
  const params2 = ["Iron Suit", "SUIT", E(1_000_000_000), 18, 10000, E(1000), E(4000)]; // V0 1,000 IRON, graduate at 4,000 IRON
  const rc2 = await (await factoryV1.connect(creator)[LAUNCH_SIG_V1](params2, SALT, IRON, [])).wait();
  const SUIT = parsed(rc2, factoryV1.interface, "Launched").args.token;
  const cv2 = await curve.curves(SUIT);
  if (cv2.quote.toLowerCase() !== IRON.toLowerCase()) throw new Error("SUIT is not quoted in IRON");
  await ethers.provider.send("hardhat_mine", ["0x65"]);
  await (await iron.connect(buyer1).approve(curveAddr, ethers.MaxUint256)).wait();
  const ironBefore = await iron.balanceOf(buyer1.address);
  const expect = await curve.quoteBuy(SUIT, E(50));
  await (await curve.connect(buyer1).buy(SUIT, E(50), 0)).wait();
  const suitBal = await new ethers.Contract(SUIT, ERC20_ABI, deployer).balanceOf(buyer1.address);
  if (suitBal !== expect) throw new Error(`buy in IRON mismatched quoteBuy (${f(suitBal)} vs ${f(expect)})`);
  console.log(`[7] ✓ $SUIT launched anchored to $IRON; buyer1 paid ${f(ironBefore - (await iron.balanceOf(buyer1.address)))} IRON for ${f(suitBal)} SUIT (matches quoteBuy)`);

  const out = {
    chainId: Number(net.chainId), rpc: "http://127.0.0.1:8545",
    curve: curveAddr, factory: await factoryV1.getAddress(), factoryV2: await factoryV2.getAddress(), locker: await locker.getAddress(),
    v3Factory: uf, npm: npmAddr, swapRouter: uniRouter, weth: WETH, usdg: USDG, tsla: TSLA, cost: COST,
    iron: IRON, ironVault, suit: SUIT, creator: creator.address, buyer1: buyer1.address, buyer2: buyer2.address,
  };
  if (process.env.OUT) { fs.writeFileSync(process.env.OUT, JSON.stringify(out, null, 2)); console.log("addresses ->", process.env.OUT); }
  else console.log(JSON.stringify(out, null, 2));
  console.log("\n=== Company-coin pairing proof complete ✓ ===");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
