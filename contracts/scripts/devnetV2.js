// Devnet demo of v1 (base, HOOD-paired) and v2 (stock-dividend basket), end to end, one process.
//   npx hardhat run scripts/devnetV2.js
const hre = require("hardhat");
const { ethers } = hre;
const standardFor = require("./standards");
const { computeLaunchParams, computeGraduationTick } = require("./lib/launchParams");
const { grindSalt } = require("./lib/grindSalt");

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

  // ---- mock tokenized stocks + the pools the vault buys through ----
  async function deployTok(name, sym) {
    const t = await (await ethers.getContractFactory("LaunchToken", deployer)).deploy(name, sym, ethers.parseEther("1000000"), 18, deployer.address);
    await t.waitForDeployment(); return await t.getAddress();
  }
  // Seed a two-sided 1:1 full-range V3 pool for any pair (wrapping ETH->WETH as needed).
  async function seedPool(a, b) {
    const [t0, t1] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    await (await npm.createAndInitializePoolIfNecessary(t0, t1, 3000, (2n ** 96n).toString())).wait();
    for (const t of [a, b]) {
      if (t.toLowerCase() === WETH.toLowerCase()) { await (await weth.deposit({ value: ethers.parseEther("500") })).wait(); await (await weth.approve(npmAddr, ethers.MaxUint256)).wait(); }
      else await (await new ethers.Contract(t, ERC20_ABI, deployer).approve(npmAddr, ethers.MaxUint256)).wait();
    }
    await (await npm.mint({ token0: t0, token1: t1, fee: 3000, tickLower: -MAXTICK, tickUpper: MAXTICK,
      amount0Desired: ethers.parseEther("500"), amount1Desired: ethers.parseEther("500"), amount0Min: 0, amount1Min: 0, recipient: deployer.address, deadline: (await ethers.provider.getBlock("latest")).timestamp + 600 })).wait();
  }
  // USDG stablecoin hub + the WETH<->USDG bridge — mirrors Robinhood Chain, where most tokenized
  // stocks are quoted in USDG, not WETH.
  const USDG = await deployTok("Global Dollar", "USDG");
  await seedPool(WETH, USDG);
  // TSLA has a direct WETH pool -> vault reaches it single-hop.
  const TSLA = await deployTok("Tesla", "TSLA"); await seedPool(TSLA, WETH);
  // COST has ONLY a USDG pool (no WETH pool) -> vault can reach it ONLY via WETH -> USDG -> COST.
  const COST = await deployTok("Costco", "COST"); await seedPool(COST, USDG);
  console.log("Mock stocks: TSLA (direct WETH pool) + COST (USDG-only pool) + WETH/USDG bridge.\n");

  // 0x stand-in (AllowanceHolder + Settler), pre-funded with a stock inventory so distributeVia0x can be
  // exercised without a live 0x deployment. On Robinhood Chain this is the real 0x AllowanceHolder address.
  const zx = await (await ethers.getContractFactory("MockZeroEx", deployer)).deploy(); await zx.waitForDeployment();
  const ZEROX = await zx.getAddress();
  await (await new ethers.Contract(TSLA, ERC20_ABI, deployer).transfer(ZEROX, ethers.parseEther("100000"))).wait();
  await (await new ethers.Contract(COST, ERC20_ABI, deployer).transfer(ZEROX, ethers.parseEther("100000"))).wait();

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
  const supply1 = ethers.parseEther("1000000000");
  let g = await grindSalt(fac1Addr, { name: "HoodDoge", symbol: "HDOGE", totalSupply: supply1, decimals: 18 }, creator.address);
  let predicted = g.address, salt = g.salt;
  console.log(`[c0de] v1 salt in ${g.tries} tries -> ${predicted}`);
  let lp = computeLaunchParams({ token: predicted, weth: HOOD, tokenDecimals: 18, quoteDecimals: 18, fee: STD.fee, priceWethPerToken: STD.launchPriceWethPerToken });
  let gt = computeGraduationTick({ token: predicted, weth: HOOD, tokenDecimals: 18, quoteDecimals: 18, graduationPriceWethPerToken: STD.graduationPriceWethPerToken });
  let rc = await (await fac1.connect(creator).createLaunch({ name: "HoodDoge", symbol: "HDOGE", totalSupply: supply1, decimals: 18, fee: STD.fee, sqrtPriceX96: lp.sqrtPriceX96, tickLower: lp.tickLower, tickUpper: lp.tickUpper, graduationTick: gt }, salt)).wait();
  let ev = rc.logs.map(l => { try { return fac1.interface.parseLog(l); } catch { return null; } }).find(x => x && x.name === "Launched");
  const v1token = ev.args.token, v1id = ev.args.tokenId;
  console.log("Launched HoodDoge paired with HOOD. pool", ev.args.pool.slice(0, 10));
  await ethers.provider.send("hardhat_mine", ["0x65"]); // fast-forward past the anti-snipe window
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
  const fac2 = await (await ethers.getContractFactory("LaunchFactoryV2", deployer)).deploy(npmAddr, WETH, await lk2.getAddress(), routerAddr, 3000, ZEROX); await fac2.waitForDeployment();
  await (await lk2.initFactory(await fac2.getAddress())).wait();

  const fac2Addr = await fac2.getAddress();
  // Grind the CREATE2 vanity salt for the v2 token (the factory deploys it via CREATE2 -> `…c0de`).
  const supply2 = ethers.parseEther("1000000000");
  g = await grindSalt(fac2Addr, { name: "Iron Man", symbol: "IRON", totalSupply: supply2, decimals: 18 }, creator.address);
  predicted = g.address; salt = g.salt;
  console.log(`[c0de] v2 salt in ${g.tries} tries -> ${predicted}`);
  lp = computeLaunchParams({ token: predicted, weth: WETH, tokenDecimals: 18, quoteDecimals: 18, fee: STD.fee, priceWethPerToken: STD.launchPriceWethPerToken });
  gt = computeGraduationTick({ token: predicted, weth: WETH, tokenDecimals: 18, quoteDecimals: 18, graduationPriceWethPerToken: STD.graduationPriceWethPerToken });
  // per-stock swap route: TSLA direct (empty), COST via WETH -> USDG -> COST (2-hop V3 path)
  const costPath = ethers.solidityPacked(["address", "uint24", "address", "uint24", "address"], [WETH, 3000, USDG, 3000, COST]);
  rc = await (await fac2.connect(creator).createLaunch(
    { name: "Iron Man", symbol: "IRON", totalSupply: supply2, decimals: 18, fee: STD.fee, sqrtPriceX96: lp.sqrtPriceX96, tickLower: lp.tickLower, tickUpper: lp.tickUpper, graduationTick: gt },
    [TSLA, COST], [5000, 5000], ["0x", costPath], salt
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

  // two holders buy different amounts (fast-forward past the anti-snipe window first)
  await ethers.provider.send("hardhat_mine", ["0x65"]);
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
  // distribute is operator-gated & slippage-safe (creator = operator; minOut computed off-chain, 0 on devnet)
  let gated = false;
  try { await vault.connect(buyer1).distribute([0, 0]); } catch { gated = true; }
  console.log("  slippage guard: non-operator distribute blocked?", gated, "(expect true)");
  await (await vault.connect(creator).distribute([0, 0])).wait();
  const tslaBought = await new ethers.Contract(TSLA, ERC20_ABI, deployer).balanceOf(vaultAddr);
  const costBought = await new ethers.Contract(COST, ERC20_ABI, deployer).balanceOf(vaultAddr);
  console.log("vault bought basket — TSLA (direct WETH):", f(tslaBought), " COST (via WETH→USDG→COST 2-hop):", f(costBought));
  if (costBought === 0n) throw new Error("2-hop routing FAILED: COST has no WETH pool and was not bought via USDG");
  console.log("  ✓ COST reached through the USDG hub — the ~50 USDG-quoted stocks are now payable");

  // holders claim their stock dividends
  const tslaT = new ethers.Contract(TSLA, ERC20_ABI, deployer), costT = new ethers.Contract(COST, ERC20_ABI, deployer);
  await (await vault.connect(buyer1).claim()).wait();
  await (await vault.connect(buyer2).claim()).wait();
  console.log("\n--- dividends paid to holders (pro-rata to IRON held) ---");
  console.log(`buyer1  TSLA ${f(await tslaT.balanceOf(buyer1.address))}  COST ${f(await costT.balanceOf(buyer1.address))}`);
  console.log(`buyer2  TSLA ${f(await tslaT.balanceOf(buyer2.address))}  COST ${f(await costT.balanceOf(buyer2.address))}`);
  const share1 = Number(b1) / Number(b1 + b2);
  console.log(`(buyer1 holds ${(share1 * 100).toFixed(1)}% of circulating IRON => should get ~${(share1 * 100).toFixed(1)}% of each stock)`);

  // ---- ADVERSARIAL: prove the Option A accounting fix ----
  // An attacker buys IRON AFTER the distribution above. Under the OLD (demo) accounting they could
  // immediately claim a share of that past distribution and drain the vault. Reward-debt settle-on-
  // transfer must earn them NOTHING from distributions that predate their purchase.
  console.log("\n--- adversarial: buyer AFTER the distribution ---");
  const attacker = (await ethers.getSigners())[6];
  {
    const w = new ethers.Contract(WETH, WETH_ABI, attacker);
    await (await w.deposit({ value: ethers.parseEther("5") })).wait();
    await (await w.approve(routerAddr, ethers.MaxUint256)).wait();
  }
  await buy(attacker, routerAddr, WETH, v2token, ethers.parseEther("1"), STD.fee); // buys a big bag, AFTER the distribute
  const attBal = await iron.balanceOf(attacker.address);
  const owedTSLA = await vault.withdrawableOf(attacker.address, TSLA);
  const owedCOST = await vault.withdrawableOf(attacker.address, COST);
  console.log(`attacker bought ${f(attBal)} IRON; withdrawable from the PAST distribution — TSLA ${f(owedTSLA)}  COST ${f(owedCOST)}`);
  if (owedTSLA !== 0n || owedCOST !== 0n) throw new Error("FIX BROKEN: attacker can claim past-distribution dividends");
  await (await vault.connect(attacker).claim()).wait();
  if ((await tslaT.balanceOf(attacker.address)) !== 0n || (await costT.balanceOf(attacker.address)) !== 0n) throw new Error("FIX BROKEN: attacker drained past dividends");
  console.log("  ✓ attacker earns NOTHING from the distribution that predates their buy (drain prevented)");

  // excluded addresses (the pool) never earn
  if ((await vault.withdrawableOf(ev.args.pool, TSLA)) !== 0n) throw new Error("excluded pool accrued dividends");
  console.log("  ✓ excluded pool earns nothing");

  // fair going forward: a SECOND distribution — now the attacker earns their pro-rata of THAT one only
  await buy(buyer1, routerAddr, WETH, v2token, ethers.parseEther("0.5"), STD.fee); // more trading -> more fees
  await (await lk2.collectFees(v2id)).wait();
  await (await vault.connect(creator).distribute([0, 0])).wait();
  const owed2 = await vault.withdrawableOf(attacker.address, TSLA);
  console.log(`after a 2nd distribution the attacker's TSLA withdrawable is ${f(owed2)} (should be > 0 — earns going forward)`);
  if (owed2 === 0n) throw new Error("attacker should earn from distributions AFTER their buy");
  console.log("  ✓ attacker earns their pro-rata of distributions that happen AFTER they hold");

  // ---- 0x path: distributeVia0x (going 0x-heavy) ----
  // Generate fresh fees, then convert them into the basket through the pinned 0x AllowanceHolder stand-in.
  console.log("\n--- 0x path: distributeVia0x (guarded 0x execution) ---");
  await buy(buyer1, routerAddr, WETH, v2token, ethers.parseEther("0.5"), STD.fee);
  await buy(buyer2, routerAddr, WETH, v2token, ethers.parseEther("0.5"), STD.fee);
  await (await lk2.collectFees(v2id)).wait();
  const vaultWeth0x = await weth.balanceOf(vaultAddr);
  console.log("vault WETH from fees:", f(vaultWeth0x));

  // Keeper splits by weights and builds the 0x calldata per stock OFF-CHAIN (taker = vault). `outAmount`
  // here stands in for the 0x quote's buyAmount; on-chain the vault credits the MEASURED delta and enforces minOut.
  const sell0 = vaultWeth0x / 2n, sell1 = vaultWeth0x - sell0;
  const zxIface = new ethers.Interface(["function swap(address tokenIn,uint256 amountIn,address tokenOut,uint256 amountOut,address recipient)"]);
  const outTSLA = ethers.parseEther("2"), outCOST = ethers.parseEther("2");
  const data0 = zxIface.encodeFunctionData("swap", [WETH, sell0, TSLA, outTSLA, vaultAddr]);
  const data1 = zxIface.encodeFunctionData("swap", [WETH, sell1, COST, outCOST, vaultAddr]);

  let gated0x = false;
  try { await vault.connect(buyer1).distributeVia0x([sell0, sell1], [data0, data1], [0, 0]); } catch { gated0x = true; }
  console.log("  operator gate: non-operator distributeVia0x blocked?", gated0x, "(expect true)");

  let minOutHeld = false;
  try { await vault.connect(creator).distributeVia0x([sell0, sell1], [data0, data1], [outTSLA + 1n, outCOST + 1n]); } catch { minOutHeld = true; }
  console.log("  minOut guard: swap below the floor reverts?", minOutHeld, "(expect true)");

  const tslaBefore0x = await tslaT.balanceOf(vaultAddr), costBefore0x = await costT.balanceOf(vaultAddr);
  await (await vault.connect(creator).distributeVia0x([sell0, sell1], [data0, data1], [outTSLA, outCOST])).wait();
  const tslaGot0x = (await tslaT.balanceOf(vaultAddr)) - tslaBefore0x, costGot0x = (await costT.balanceOf(vaultAddr)) - costBefore0x;
  console.log("  0x swap credited — TSLA:", f(tslaGot0x), " COST:", f(costGot0x));
  if (tslaGot0x !== outTSLA || costGot0x !== outCOST) throw new Error("0x path did not credit the received basket");
  const wethErc = new ethers.Contract(WETH, ["function allowance(address,address) view returns (uint256)"], deployer);
  if ((await wethErc.allowance(vaultAddr, ZEROX)) !== 0n) throw new Error("0x allowance not reset to 0 after swap");
  console.log("  ✓ approval reset to 0 after the swap (no standing allowance to 0x)");
  await (await vault.connect(buyer2).claim()).wait();
  console.log("  ✓ distributeVia0x works: fees → 0x → basket → holders (Uniswap distribute() stays as fallback)");

  console.log("\n=== v1 + v2 devnet complete ✓ ===");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
