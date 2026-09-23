// Deploys the Census V4 product and wires it together:
//   Treasury (FeeSplitter/FeeVault) -> CensusCurveV4 -> CensusV4Graduator -> CensusV4Hook (CREATE2, mined salt)
//   -> CensusV4Router -> CensusRewardVaultDeployer -> LaunchFactoryV4.
// Every new launch (meme or company) trades on CensusCurveV4 (2% base, 90/10 Census/creator, optional 1-4%
// reflection, 3-second anti-snipe) and graduates into a permanently custodied Uniswap V4 pool where the hook
// charges the same 2% base (30/70) + reflection on every router.
//
//   npx hardhat run scripts/deployV4.js --network hardhat            (local rehearsal: deploys a PoolManager too)
//   npx hardhat run scripts/deployV4.js --network robinhoodTestnet   (POOL_MANAGER_ADDRESS or a fresh local manager)
//   npx hardhat run scripts/deployV4.js --network robinhood          (official PoolManager; refuses without treasury/keeper)
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const ADDR = require("./addresses");
const { findHookSalt } = require("./lib/hookSalt");

const STOCK_SWAP_FEE = 3000;
const ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734"; // 0x AllowanceHolder (Cancun singleton)

async function main() {
  const netName = hre.network.name;
  const net = ADDR[netName] || {};
  const [deployer] = await hre.ethers.getSigners();
  const mainnet = netName === "robinhood";
  // DEPLOY_TAG=rehearsal: a throwaway side stack (mainnet dress rehearsal, see MAINNET_RUNBOOK_V4.md). Its
  // record goes to deployments.v4.<net>-<tag>.json so it can never be mistaken for, or overwrite, the
  // production record, and verify:* (which reads deployments.v4.<net>.json) never touches it.
  const tag = (process.env.DEPLOY_TAG || "").replace(/[^a-z0-9-]/gi, "");
  const recordName = tag ? `${netName}-${tag}` : netName;
  if (tag) console.log(`*** ${tag.toUpperCase()} deploy: record -> deployments.v4.${recordName}.json. Do NOT verify on the explorer; do NOT point production at it. ***`);

  if (mainnet) {
    if (!(process.env.FEE_SPLIT_A && process.env.FEE_SPLIT_B)) throw new Error("Mainnet deploy refused (CX-G2): set FEE_SPLIT_A/FEE_SPLIT_B to an approved immutable FeeSplitter/multisig.");
    if (!process.env.KEEPER_ADDRESS) throw new Error("Mainnet deploy refused (CX-G2): set KEEPER_ADDRESS.");
    if (!net.v4?.PoolManager) throw new Error("No official PoolManager recorded for robinhood in scripts/addresses.js");
  }
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  console.log(`Deploying Census V4 on ${netName} (chainId ${chainId}) from ${deployer.address}`);

  // --- Uniswap dependencies -------------------------------------------------------------------
  let weth = net.WETH, swapRouter = net.SwapRouter02;
  let poolManager = process.env.POOL_MANAGER_ADDRESS || net.v4?.PoolManager;
  let localUniswap = false;
  if (netName === "hardhat" || netName === "localhost") {
    const w = await (await hre.ethers.getContractFactory("WETH9")).deploy(); await w.waitForDeployment(); weth = await w.getAddress();
    const r = await (await hre.ethers.getContractFactory("MockSwapRouter")).deploy(); await r.waitForDeployment(); swapRouter = await r.getAddress();
    localUniswap = true;
  }
  // Testnet stress runs: tokenised stocks do not exist there, so a MockSwapRouter (pre-funded with mock
  // stocks) can stand in for SwapRouter02 on the stock/zap routes. Refused on mainnet.
  if (process.env.STOCK_ROUTER_OVERRIDE) {
    if (mainnet) throw new Error("STOCK_ROUTER_OVERRIDE is not allowed on mainnet");
    swapRouter = process.env.STOCK_ROUTER_OVERRIDE;
    console.log(`Stock/zap router overridden (testnet only): ${swapRouter}`);
  }
  if (!weth || !swapRouter) throw new Error(`No WETH/SwapRouter02 for "${netName}" in scripts/addresses.js`);
  if (!poolManager) {
    if (mainnet) throw new Error("PoolManager missing");
    // Testnets without an official V4 deployment: deploy the canonical PoolManager bytecode (owner = deployer).
    const pm = await (await hre.ethers.getContractFactory("PoolManager")).deploy(deployer.address);
    await pm.waitForDeployment();
    poolManager = await pm.getAddress();
    console.log(`PoolManager (deployed locally, NOT the official Uniswap instance): ${poolManager}`);
  } else {
    if ((await hre.ethers.provider.getCode(poolManager)) === "0x") throw new Error(`PoolManager ${poolManager} has no code on ${netName}`);
    console.log(`PoolManager: ${poolManager}`);
  }

  // --- Treasury -----------------------------------------------------------------------------------
  const SPLIT_A = process.env.FEE_SPLIT_A, SPLIT_B = process.env.FEE_SPLIT_B;
  const SPLIT_A_BPS = Number(process.env.FEE_SPLIT_A_BPS || 1000), SPLIT_B_BPS = Number(process.env.FEE_SPLIT_B_BPS || 9000);
  let treasury, treasuryKind, treasuryArgs;
  if (SPLIT_A && SPLIT_B) {
    const s = await (await hre.ethers.getContractFactory("FeeSplitter")).deploy(SPLIT_A, SPLIT_A_BPS, SPLIT_B, SPLIT_B_BPS);
    await s.waitForDeployment(); treasury = await s.getAddress(); treasuryKind = "FeeSplitter"; treasuryArgs = [SPLIT_A, SPLIT_A_BPS, SPLIT_B, SPLIT_B_BPS];
  } else {
    const v = await (await hre.ethers.getContractFactory("FeeVault")).deploy(deployer.address);
    await v.waitForDeployment(); treasury = await v.getAddress(); treasuryKind = "FeeVault"; treasuryArgs = [deployer.address];
    console.log("FeeVault treasury (testnet/local only; mainnet requires FEE_SPLIT_A/B)");
  }
  console.log(`Treasury (${treasuryKind}): ${treasury}`);

  // --- Core -----------------------------------------------------------------------------------------
  const curve = await (await hre.ethers.getContractFactory("CensusCurveV4")).deploy(treasury, weth, swapRouter);
  await curve.waitForDeployment(); const curveAddr = await curve.getAddress();
  console.log(`CensusCurveV4: ${curveAddr}`);

  const graduator = await (await hre.ethers.getContractFactory("CensusV4Graduator")).deploy(poolManager, curveAddr, treasury);
  await graduator.waitForDeployment(); const graduatorAddr = await graduator.getAddress();
  console.log(`CensusV4Graduator: ${graduatorAddr}`);

  // Hook: CREATE2 through the owner-only deployer at an address carrying the beforeInitialize/beforeSwap/
  // afterSwap/returns-delta flag bits (0x20cc). The salt is mined deterministically off-chain.
  const hookDeployer = await (await hre.ethers.getContractFactory("CensusHookDeployer")).deploy();
  await hookDeployer.waitForDeployment(); const hookDeployerAddr = await hookDeployer.getAddress();
  const HookFactory = await hre.ethers.getContractFactory("CensusV4Hook");
  const hookInitCode = (await HookFactory.getDeployTransaction(poolManager, graduatorAddr, treasury)).data;
  const { salt, address: predictedHook, iterations } = findHookSalt(hookDeployerAddr, hookInitCode);
  console.log(`Hook salt mined in ${iterations} iterations -> ${predictedHook}`);
  if ((await hookDeployer.predict(salt, hre.ethers.keccak256(hookInitCode))) !== predictedHook) throw new Error("hook address prediction mismatch");
  await (await hookDeployer.deploy(salt, hookInitCode)).wait();
  const hook = HookFactory.attach(predictedHook);
  if ((await hre.ethers.provider.getCode(predictedHook)) === "0x") throw new Error("hook deployment failed");
  if ((await hook.registrar()) !== graduatorAddr || (await hook.protocol()) !== treasury) throw new Error("hook wiring mismatch");
  console.log(`CensusV4Hook: ${predictedHook}`);

  await (await graduator.setHook(predictedHook)).wait();
  await (await curve.setGraduator(graduatorAddr)).wait();
  console.log("Graduator <-> hook <-> curve wired.");

  const router = await (await hre.ethers.getContractFactory("CensusV4Router")).deploy(poolManager, predictedHook);
  await router.waitForDeployment(); const routerAddr = await router.getAddress();
  console.log(`CensusV4Router: ${routerAddr}`);

  const vaultDeployer = await (await hre.ethers.getContractFactory("CensusRewardVaultDeployer")).deploy();
  await vaultDeployer.waitForDeployment(); const vaultDeployerAddr = await vaultDeployer.getAddress();
  const factory = await (await hre.ethers.getContractFactory("LaunchFactoryV4")).deploy(weth, curveAddr, swapRouter, STOCK_SWAP_FEE, ALLOWANCE_HOLDER, routerAddr, vaultDeployerAddr);
  await factory.waitForDeployment(); const factoryAddr = await factory.getAddress();
  await (await vaultDeployer.setLaunchFactory(factoryAddr)).wait();
  await (await curve.setFactory(factoryAddr, true)).wait();
  console.log(`LaunchFactoryV4: ${factoryAddr} (vault deployer ${vaultDeployerAddr})`);

  const allowedQuotes = (process.env.ALLOWED_QUOTES || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const q of allowedQuotes) { await (await curve.setQuoteAllowed(q, true)).wait(); console.log(`Quote collateral enabled: ${q}`); }
  // Tokenised stocks creators may put in reward baskets. Additive: list more later with
  // curve.setRewardAssetAllowed(addr, true) from the deployer; no contract change is ever needed.
  const rewardAssets = (process.env.REWARD_ASSETS || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const a of rewardAssets) {
    if ((await hre.ethers.provider.getCode(a)) === "0x") throw new Error(`REWARD_ASSETS entry ${a} has no code on ${netName}`);
    await (await curve.setRewardAssetAllowed(a, true)).wait(); console.log(`Reward asset listed: ${a}`);
  }
  if (!rewardAssets.length) console.log("No reward assets listed yet (REWARD_ASSETS): baskets can only use the pairing asset until stocks are listed.");
  if (process.env.KEEPER_ADDRESS) { await (await curve.setKeeper(process.env.KEEPER_ADDRESS)).wait(); console.log(`Keeper registered: ${process.env.KEEPER_ADDRESS}`); }
  else console.log("WARNING: KEEPER_ADDRESS unset: reward distribution needs curve.setKeeper(<keeperd signer>) before launch.");

  // Post-deploy assertions: the executable path is V4 and the economics constants are the agreed ones.
  if ((await curve.graduator()) !== graduatorAddr || (await graduator.hook()) !== predictedHook) throw new Error("curve/graduator wiring failed");
  if (Number(await curve.FEE_BPS()) !== 200 || Number(await curve.CURVE_PROTOCOL_BPS()) !== 9000) throw new Error("fee constants mismatch");
  if ((await router.hook()) !== predictedHook || (await router.manager()).toLowerCase() !== poolManager.toLowerCase()) throw new Error("router wiring failed"); // addresses.js may hold lowercase addresses

  const out = {
    network: netName, chainId, deployedAt: new Date().toISOString(), product: "v4", tag: tag || null,
    Treasury: treasury, TreasuryKind: treasuryKind,
    PoolManager: poolManager, PoolManagerOfficial: !!net.v4?.PoolManager && poolManager.toLowerCase() === net.v4.PoolManager.toLowerCase(),
    StateView: net.v4?.StateView || null, V4Quoter: net.v4?.Quoter || null,
    WETH: weth, SwapRouter02: swapRouter, localUniswap,
    CensusCurveV4: curveAddr, CensusV4Graduator: graduatorAddr, CensusHookDeployer: hookDeployerAddr, CensusV4Hook: predictedHook, hookSalt: salt,
    CensusV4Router: routerAddr, CensusRewardVaultDeployer: vaultDeployerAddr, LaunchFactoryV4: factoryAddr,
    allowedQuotes: [weth, ...allowedQuotes], rewardAssets, keeper: process.env.KEEPER_ADDRESS || null,
    verify: {
      [treasuryKind]: treasuryArgs,
      CensusCurveV4: [treasury, weth, swapRouter],
      CensusV4Graduator: [poolManager, curveAddr, treasury],
      CensusHookDeployer: [],
      CensusV4Hook: [poolManager, graduatorAddr, treasury],
      CensusV4Router: [poolManager, predictedHook],
      CensusRewardVaultDeployer: [],
      LaunchFactoryV4: [weth, curveAddr, swapRouter, STOCK_SWAP_FEE, ALLOWANCE_HOLDER, routerAddr, vaultDeployerAddr],
    },
  };
  const file = path.join(__dirname, "..", `deployments.v4.${recordName}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nSaved ${file}`);
  console.log("\nPaste into frontend/.env:\n" +
    `VITE_FACTORY_V4_ADDRESS=${factoryAddr}\nVITE_CURVE_V4_ADDRESS=${curveAddr}\nVITE_V4_ROUTER=${routerAddr}\nVITE_V4_HOOK=${predictedHook}\nVITE_POOL_MANAGER=${poolManager}` +
    (out.StateView ? `\nVITE_STATE_VIEW=${out.StateView}` : "\n# VITE_STATE_VIEW=<StateView for this chain>") +
    (out.V4Quoter ? `\nVITE_V4_QUOTER=${out.V4Quoter}` : "\n# VITE_V4_QUOTER=<V4Quoter for this chain>"));
  console.log("\nIndexer/keeper:\n" + `CURVE_V4_ADDRESS=${curveAddr}\nFACTORY_V4_ADDRESS=${factoryAddr}\nPOOL_MANAGER_ADDRESS=${poolManager}\nHOOK_ADDRESS=${predictedHook}\nV4_ROUTER_ADDRESS=${routerAddr}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
