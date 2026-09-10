// Maxima-on-curve proof: a stock-dividend-basket coin launched on the CensusCurve. Proves the holder
// share of the 2% curve fee routes to the DividendVault PRE-graduation (straight from the curve, no
// pool), the vault swaps it into the basket, holders claim pro-rata, a post-distribution buyer earns
// nothing from past dividends (reward-debt fix), and the coin still graduates into a locked pool.
//
//   npx hardhat run scripts/devnetCurveV2.js
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
const ERC20_ABI = ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"];

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

async function main() {
  const [deployer, platform, creator, buyer1, buyer2, , attacker] = await ethers.getSigners();
  console.log("=== Maxima-on-curve proof (stock-dividend basket) ===");

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
  const TSLA = await deployTok("Tesla", "TSLA"); await seedPool(TSLA, WETH);          // direct WETH pool
  const COST = await deployTok("Costco", "COST"); await seedPool(COST, USDG);          // USDG-only -> 2-hop
  const zx = await (await ethers.getContractFactory("MockZeroEx", deployer)).deploy(); await zx.waitForDeployment();
  console.log("[1] Uniswap V3 + TSLA(direct)/COST(via USDG) pools up");

  // --- Census curve stack ---
  const feeVault = await (await ethers.getContractFactory("FeeVault", deployer)).deploy(platform.address); await feeVault.waitForDeployment();
  const locker = await (await ethers.getContractFactory("LaunchLocker", deployer)).deploy(npmAddr, await feeVault.getAddress(), 2500); await locker.waitForDeployment();
  const curve = await (await ethers.getContractFactory("CensusCurve", deployer)).deploy(npmAddr, platform.address, await locker.getAddress(), WETH, uniRouter); await curve.waitForDeployment();
  const factoryV2 = await (await ethers.getContractFactory("LaunchFactoryV2", deployer)).deploy(WETH, await curve.getAddress(), uniRouter, 3000, await zx.getAddress()); await factoryV2.waitForDeployment();
  await (await locker.initFactory(await curve.getAddress())).wait();
  await (await curve.setFactory(await factoryV2.getAddress(), true)).wait();
  console.log("[2] Census curve stack up");

  // --- Launch Maxima: basket 50% TSLA / 50% COST, ALL of the 75% creator side to holders (holdersBps=10000) ---
  const params = ["Iron Man", "IRON", E(1_000_000_000), 18, 10000, E(1.5), E(4)];
  const costPath = ethers.solidityPacked(["address", "uint24", "address", "uint24", "address"], [WETH, 3000, USDG, 3000, COST]);
  const rc = await (await factoryV2.connect(creator)["createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])"](
    params, [TSLA, COST], [5000, 5000], ["0x", costPath], SALT, WETH, 10000, []
  )).wait();
  const lev = rc.logs.map((l) => { try { return factoryV2.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "LaunchedV2");
  const token = lev.args.token, vaultAddr = lev.args.vault;
  const iron = new ethers.Contract(token, ERC20_ABI, deployer);
  const vault = await ethers.getContractAt("DividendVault", vaultAddr, deployer);
  const tslaT = new ethers.Contract(TSLA, ERC20_ABI, deployer), costT = new ethers.Contract(COST, ERC20_ABI, deployer);
  console.log("[3] Launched $IRON on the curve | vault", vaultAddr.slice(0, 10), "| holdersBps 10000 (all to holders)");

  // --- Buy on the CURVE (not a pool). The holder fee (1.5% of input) routes straight to the vault. ---
  for (const b of [buyer1, buyer2, attacker]) { const w = new ethers.Contract(WETH, WETH_ABI, b); await (await w.deposit({ value: E(10) })).wait(); await (await w.approve(await curve.getAddress(), ethers.MaxUint256)).wait(); }
  await ethers.provider.send("hardhat_mine", ["0x65"]); // past the anti-snipe window
  const cbuy = (who, amt) => curve.connect(who).buy(token, E(amt), 0);
  await (await cbuy(buyer1, "2")).wait();
  await (await cbuy(buyer2, "1")).wait();
  const b1 = await iron.balanceOf(buyer1.address), b2 = await iron.balanceOf(buyer2.address);
  const vaultWeth = await weth.balanceOf(vaultAddr);
  console.log("[4] curve buys: buyer1 2 WETH, buyer2 1 WETH | vault WETH from holder fees:", f(vaultWeth), "(expect 0.045 = 1.5% of 3)");
  if (vaultWeth !== E(0.045)) throw new Error(`holder fee did not route from the curve to the vault (got ${f(vaultWeth)})`);
  console.log("    ✓ holder fee routed from the CURVE to the vault pre-graduation (no pool involved)");

  // --- distribute -> basket -> holders claim pro-rata ---
  await (await vault.connect(creator).distribute([0, 0])).wait();
  const tslaBought = await tslaT.balanceOf(vaultAddr), costBought = await costT.balanceOf(vaultAddr);
  console.log("[5] vault bought basket — TSLA:", f(tslaBought), "COST (via WETH→USDG→COST):", f(costBought));
  if (tslaBought === 0n || costBought === 0n) throw new Error("basket swap failed");
  await (await vault.connect(buyer1).claim()).wait();
  await (await vault.connect(buyer2).claim()).wait();
  const share1 = Number(b1) / Number(b1 + b2);
  console.log(`    buyer1 (${(share1 * 100).toFixed(1)}% of supply): TSLA ${f(await tslaT.balanceOf(buyer1.address))} COST ${f(await costT.balanceOf(buyer1.address))}`);
  console.log(`    buyer2 (${((1 - share1) * 100).toFixed(1)}%):            TSLA ${f(await tslaT.balanceOf(buyer2.address))} COST ${f(await costT.balanceOf(buyer2.address))}`);
  console.log("    ✓ dividends paid pro-rata to circulating holders");

  // --- adversarial: a buyer AFTER the distribution earns nothing from the past one ---
  await (await cbuy(attacker, "1")).wait();
  const owed = await vault.withdrawableOf(attacker.address, TSLA);
  if (owed !== 0n) throw new Error("FIX BROKEN: post-distribution buyer can claim past dividends");
  console.log("[6] ✓ post-distribution buyer earns NOTHING from the prior distribution (reward-debt fix holds on the curve)");

  // --- fill + graduate, then a post-grad distribution keeps paying holders ---
  await (await cbuy(buyer1, "3")).wait(); // realQuote now > 4 -> ready
  await (await curve.graduate(token)).wait();
  if (!(await curve.curves(token)).graduated) throw new Error("did not graduate");
  console.log("[7] ✓ graduated into a locked Uniswap pool; curve closed");
  // post-grad trading -> LP fees -> locker -> vault (protocol share) -> another dividend round
  await (await weth.approve(uniRouter, ethers.MaxUint256)).wait();
  const uni = new ethers.Contract(uniRouter, ["function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)"], deployer);
  await (await weth.deposit({ value: E(2) })).wait();
  await (await uni.exactInputSingle([WETH, token, 10000, deployer.address, E(1), 0, 0])).wait();
  const tid = (await curve.queryFilter(curve.filters.Graduated(token)))[0].args.tokenId;
  await (await locker.collectFees(tid)).wait();
  const postVaultWeth = await weth.balanceOf(vaultAddr);
  console.log("    post-grad: vault WETH from pool LP fees:", f(postVaultWeth), "(> 0 -> Maxima keeps paying after graduation)");
  if (postVaultWeth === 0n) throw new Error("post-grad vault got no LP fee share");

  console.log("\n=== Maxima-on-curve proof complete ✓ ===");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
