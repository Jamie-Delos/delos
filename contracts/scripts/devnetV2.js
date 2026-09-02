// Devnet demo of v1 (base, HOOD-paired) and v2 (stock-dividend basket), end to end, one process.
//   npx hardhat run scripts/devnetV2.js
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
const ERC20_ABI = ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)", "function symbol() view returns (string)"];
const SWAP_ABI = ["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"];
const f = (n, d = 18) => ethers.formatUnits(n, d);
const MAXTICK = 887220; // full range aligned to spacing 60

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
  const [deployer, creator, buyer1, buyer2] = await ethers.getSigners();
  const STD = standardFor("robinhood"); // ETH-quoted 1% standard

  // ---- Uniswap V3 ----
  const wc = await (await ethers.getContractFactory("WETH9")).deploy(); await wc.waitForDeployment();
  const WETH = await wc.getAddress();
  const uf = await dep(deployer, FACTORY, FACTORY.bytecode);
  const nft = await dep(deployer, NFTDESC, NFTDESC.bytecode);
  const pd = await dep(deployer, POSDESC, link(POSDESC, { NFTDescriptor: nft }), [WETH, ethers.encodeBytes32String("ETH")]);
  const npmAddr = await dep(deployer, NPM, NPM.bytecode, [uf, WETH, pd]);
  const routerAddr = await dep(deployer, ROUTER, ROUTER.bytecode, [ethers.ZeroAddress, uf, npmAddr, WETH]);
  const npm = new ethers.Contract(npmAddr, NPM.abi, deployer);
  const weth = new ethers.Contract(WETH, WETH_ABI, deployer);
  console.log("Uniswap V3 up.\n");

  // ---- mock tokenized stocks + their WETH pools (so the vault can buy them) ----
  async function deployStock(name, sym) {
    const t = await (await ethers.getContractFactory("LaunchToken", deployer)).deploy(name, sym, ethers.parseEther("1000000"), 18, deployer.address);
    await t.waitForDeployment(); return await t.getAddress();
  }
  async function seedStockPool(stock) { // 1:1 price, two-sided
    const [t0, t1] = stock.toLowerCase() < WETH.toLowerCase() ? [stock, WETH] : [WETH, stock];
    await (await npm.createAndInitializePoolIfNecessary(t0, t1, 3000, (2n ** 96n).toString())).wait();
    await (await weth.deposit({ value: ethers.parseEther("500") })).wait();
    await (await new ethers.Contract(stock, ERC20_ABI, deployer).approve(npmAddr, ethers.MaxUint256)).wait();
    await (await weth.approve(npmAddr, ethers.MaxUint256)).wait();
    await (await npm.mint({ token0: t0, token1: t1, fee: 3000, tickLower: -MAXTICK, tickUpper: MAXTICK,
      amount0Desired: ethers.parseEther("500"), amount1Desired: ethers.parseEther("500"), amount0Min: 0, amount1Min: 0, recipient: deployer.address, deadline: (await ethers.provider.getBlock("latest")).timestamp + 600 })).wait();
  }
  const TSLA = await deployStock("Tesla", "TSLA"); await seedStockPool(TSLA);
  const COST = await deployStock("Costco", "COST"); await seedStockPool(COST);
  console.log("Mock stocks TSLA + COST deployed and pooled against WETH.\n");

  const buy = async (who, router, tokenIn, tokenOut, amtIn, fee) => {
    const r = new ethers.Contract(router, SWAP_ABI, who);
    await (await r.exactInputSingle({ tokenIn, tokenOut, fee, recipient: who.address, amountIn: amtIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0 })).wait();
  };

  // ============================ v1 — base, HOOD-paired ============================
  console.log("========== v1: base launch, paired with HOOD ==========");
  const hoodC = await (await ethers.getContractFactory("LaunchToken", deployer)).deploy("Robinhood", "HOOD", ethers.parseEther("1000000"), 18, deployer.address);
  await hoodC.waitForDeployment(); const HOOD = await hoodC.getAddress();
  const hood = new ethers.Contract(HOOD, ERC20_ABI, deployer);
  await (await hood.transfer(buyer1.address, ethers.parseEther("50000"))).wait();

  const fv1 = await (await ethers.getContractFactory("FeeVault", deployer)).deploy(deployer.address); await fv1.waitForDeployment();
  const lk1 = await (await ethers.getContractFactory("LaunchLocker", deployer)).deploy(npmAddr, await fv1.getAddress(), 2000); await lk1.waitForDeployment();
  const fac1 = await (await ethers.getContractFactory("LaunchFactory", deployer)).deploy(npmAddr, HOOD, await lk1.getAddress()); await fac1.waitForDeployment();
  await (await lk1.initFactory(await fac1.getAddress())).wait();

  const fac1Addr = await fac1.getAddress();
  let nonce = await ethers.provider.getTransactionCount(fac1Addr);
  let predicted = ethers.getCreateAddress({ from: fac1Addr, nonce });
  let lp = computeLaunchParams({ token: predicted, weth: HOOD, tokenDecimals: 18, quoteDecimals: 18, fee: STD.fee, priceWethPerToken: STD.launchPriceWethPerToken });
  let gt = computeGraduationTick({ token: predicted, weth: HOOD, tokenDecimals: 18, quoteDecimals: 18, graduationPriceWethPerToken: STD.graduationPriceWethPerToken });
  let rc = await (await fac1.connect(creator).createLaunch({ name: "HoodDoge", symbol: "HDOGE", totalSupply: ethers.parseEther("1000000000"), decimals: 18, fee: STD.fee, sqrtPriceX96: lp.sqrtPriceX96, tickLower: lp.tickLower, tickUpper: lp.tickUpper, graduationTick: gt })).wait();
  let ev = rc.logs.map(l => { try { return fac1.interface.parseLog(l); } catch { return null; } }).find(x => x && x.name === "Launched");
  const v1token = ev.args.token, v1id = ev.args.tokenId;
  console.log("Launched HoodDoge paired with HOOD. pool", ev.args.pool.slice(0, 10));
  await (await hood.connect(buyer1).approve(routerAddr, ethers.MaxUint256)).wait();
  await buy(buyer1, routerAddr, HOOD, v1token, ethers.parseEther("6000"), STD.fee); // graduate
  console.log("buyer1 bought with HOOD. graduated?", await lk1.isGraduated(v1id));
  const cHoodBefore = await hood.balanceOf(creator.address);
  await (await lk1.collectFees(v1id)).wait();
  console.log("creator HOOD fees:", f(await hood.balanceOf(creator.address) - cHoodBefore), "HOOD  ✓ v1 works (any pair asset)\n");

  // ==================== v2 — stock-dividend basket (TSLA + COST) ====================
  console.log("========== v2: dividend basket — pays holders TSLA + COST ==========");
  const fv2 = await (await ethers.getContractFactory("FeeVault", deployer)).deploy(deployer.address); await fv2.waitForDeployment();
  const lk2 = await (await ethers.getContractFactory("LaunchLocker", deployer)).deploy(npmAddr, await fv2.getAddress(), 2000); await lk2.waitForDeployment();
  const fac2 = await (await ethers.getContractFactory("LaunchFactoryV2", deployer)).deploy(npmAddr, WETH, await lk2.getAddress(), routerAddr, 3000); await fac2.waitForDeployment();
  await (await lk2.initFactory(await fac2.getAddress())).wait();

  const fac2Addr = await fac2.getAddress();
  nonce = await ethers.provider.getTransactionCount(fac2Addr);
  // v2 factory deploys the vault FIRST (nonce n), then the token (nonce n+1) => predict token at n+1.
  predicted = ethers.getCreateAddress({ from: fac2Addr, nonce: nonce + 1 });
  lp = computeLaunchParams({ token: predicted, weth: WETH, tokenDecimals: 18, quoteDecimals: 18, fee: STD.fee, priceWethPerToken: STD.launchPriceWethPerToken });
  gt = computeGraduationTick({ token: predicted, weth: WETH, tokenDecimals: 18, quoteDecimals: 18, graduationPriceWethPerToken: STD.graduationPriceWethPerToken });
  rc = await (await fac2.connect(creator).createLaunch(
    { name: "Iron Man", symbol: "IRON", totalSupply: ethers.parseEther("1000000000"), decimals: 18, fee: STD.fee, sqrtPriceX96: lp.sqrtPriceX96, tickLower: lp.tickLower, tickUpper: lp.tickUpper, graduationTick: gt },
    [TSLA, COST], [5000, 5000]
  )).wait();
  ev = rc.logs.map(l => { try { return fac2.interface.parseLog(l); } catch { return null; } }).find(x => x && x.name === "LaunchedV2");
  const v2token = ev.args.token, v2id = ev.args.tokenId, vaultAddr = ev.args.vault;
  console.log("Launched Iron Man ($IRON), dividend basket = 50% TSLA / 50% COST. vault", vaultAddr.slice(0, 10));
  const iron = new ethers.Contract(v2token, ERC20_ABI, deployer);
  const vault = await ethers.getContractAt("DividendVault", vaultAddr, deployer);

  // buyers wrap ETH -> WETH and approve the router
  for (const b of [buyer1, buyer2]) {
    const w = new ethers.Contract(WETH, WETH_ABI, b);
    await (await w.deposit({ value: ethers.parseEther("10") })).wait();
    await (await w.approve(routerAddr, ethers.MaxUint256)).wait();
  }

  // two holders buy different amounts
  await buy(buyer1, routerAddr, WETH, v2token, ethers.parseEther("4"), STD.fee); // graduate + big holder
  await buy(buyer2, routerAddr, WETH, v2token, ethers.parseEther("1"), STD.fee); // smaller holder
  console.log("graduated?", await lk2.isGraduated(v2id));
  const b1 = await iron.balanceOf(buyer1.address), b2 = await iron.balanceOf(buyer2.address);
  console.log(`holdings — buyer1: ${f(b1)} IRON  buyer2: ${f(b2)} IRON`);
  // more post-grad trading -> generates the fees that fund the dividend
  await buy(buyer1, routerAddr, WETH, v2token, ethers.parseEther("0.5"), STD.fee);
  await buy(buyer2, routerAddr, WETH, v2token, ethers.parseEther("0.5"), STD.fee);

  // collect fees -> 20% protocol share (WETH) lands in the vault
  await (await lk2.collectFees(v2id)).wait();
  console.log("vault WETH from fees:", f(await weth.balanceOf(vaultAddr)));
  // anyone triggers the basket buy
  await (await vault.distribute()).wait();
  console.log("vault bought basket — TSLA:", f(await new ethers.Contract(TSLA, ERC20_ABI, deployer).balanceOf(vaultAddr)), " COST:", f(await new ethers.Contract(COST, ERC20_ABI, deployer).balanceOf(vaultAddr)));

  // holders claim their stock dividends
  const tslaT = new ethers.Contract(TSLA, ERC20_ABI, deployer), costT = new ethers.Contract(COST, ERC20_ABI, deployer);
  await (await vault.connect(buyer1).claim()).wait();
  await (await vault.connect(buyer2).claim()).wait();
  console.log("\n--- dividends paid to holders (pro-rata to IRON held) ---");
  console.log(`buyer1  TSLA ${f(await tslaT.balanceOf(buyer1.address))}  COST ${f(await costT.balanceOf(buyer1.address))}`);
  console.log(`buyer2  TSLA ${f(await tslaT.balanceOf(buyer2.address))}  COST ${f(await costT.balanceOf(buyer2.address))}`);
  const share1 = Number(b1) / Number(b1 + b2);
  console.log(`(buyer1 holds ${(share1 * 100).toFixed(1)}% of circulating IRON => should get ~${(share1 * 100).toFixed(1)}% of each stock)`);
  console.log("\n=== v1 + v2 devnet complete ✓ ===");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
