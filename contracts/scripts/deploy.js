// Deploys the Census bonding-curve launchpad and wires it together:
//   FeeVault -> LaunchLocker -> CensusCurve -> LaunchFactory (Prima) + LaunchFactoryV2 (Maxima).
// Coins trade on the CensusCurve (un-dodgeable 2% fee); at graduation the curve migrates them into a
// permanently-locked Uniswap V3 pool held by the LaunchLocker.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const ADDR = require("./addresses");

const PROTOCOL_FEE_BPS = 2500; // 25% of POST-graduation LP fees -> protocol; creator keeps 75%
const STOCK_SWAP_FEE = 3000;   // fallback tier for the vault's quote->stock swaps (routes encode their own)
const ALLOWANCE_HOLDER = "0x0000000000001fF3684f28c67538d4D072C22734"; // 0x AllowanceHolder (Cancun singleton)

function loadUni(netName) {
  const file = path.join(__dirname, "..", `uniswap.${netName}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  return ADDR[netName];
}

async function main() {
  const netName = hre.network.name;
  const uni = loadUni(netName);
  if (!uni || !uni.NonfungiblePositionManager) throw new Error(`No Uniswap addresses for "${netName}".`);
  if (!uni.SwapRouter02) throw new Error(`No SwapRouter02 for "${netName}" — needed by LaunchFactoryV2's vaults.`);

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deploying on ${netName} (chainId ${uni.chainId}) from ${deployer.address}`);

  // Protocol treasury. When FEE_SPLIT_A/FEE_SPLIT_B are set, deploy an immutable FeeSplitter so each
  // party's share is trustless and unchangeable (recommended for mainnet, e.g. 1000/9000 bps = 10/90).
  // Otherwise fall back to the simple owner-withdraw FeeVault (fine for testnet).
  const SPLIT_A = process.env.FEE_SPLIT_A, SPLIT_B = process.env.FEE_SPLIT_B;
  const SPLIT_A_BPS = Number(process.env.FEE_SPLIT_A_BPS || 1000), SPLIT_B_BPS = Number(process.env.FEE_SPLIT_B_BPS || 9000);
  let treasuryAddr, treasuryKind, feeVaultAddr = null, splitterAddr = null, splitterArgs = null;
  if (SPLIT_A && SPLIT_B) {
    const splitter = await (await hre.ethers.getContractFactory("FeeSplitter")).deploy(SPLIT_A, SPLIT_A_BPS, SPLIT_B, SPLIT_B_BPS);
    await splitter.waitForDeployment();
    splitterAddr = await splitter.getAddress();
    splitterArgs = [SPLIT_A, SPLIT_A_BPS, SPLIT_B, SPLIT_B_BPS];
    treasuryAddr = splitterAddr;
    treasuryKind = "FeeSplitter";
    console.log(`FeeSplitter:   ${splitterAddr}  (${SPLIT_A} ${SPLIT_A_BPS}bps / ${SPLIT_B} ${SPLIT_B_BPS}bps, immutable)`);
  } else {
    const feeVault = await (await hre.ethers.getContractFactory("FeeVault")).deploy(deployer.address);
    await feeVault.waitForDeployment();
    feeVaultAddr = await feeVault.getAddress();
    treasuryAddr = feeVaultAddr;
    treasuryKind = "FeeVault";
    console.log("FeeVault:      ", feeVaultAddr, "(set FEE_SPLIT_A/FEE_SPLIT_B for the immutable splitter on mainnet)");
  }

  // One locker holds every graduated LP forever; the CURVE (not a factory) registers positions with it.
  const locker = await (await hre.ethers.getContractFactory("LaunchLocker")).deploy(uni.NonfungiblePositionManager, treasuryAddr, PROTOCOL_FEE_BPS);
  await locker.waitForDeployment();
  const lockerAddr = await locker.getAddress();
  console.log("LaunchLocker:  ", lockerAddr);

  // The bonding curve — the trading venue for every coin; platform fee share -> treasury (splitter/vault).
  const curve = await (await hre.ethers.getContractFactory("CensusCurve")).deploy(uni.NonfungiblePositionManager, treasuryAddr, lockerAddr, uni.WETH, uni.SwapRouter02);
  await curve.waitForDeployment();
  const curveAddr = await curve.getAddress();
  console.log("CensusCurve:   ", curveAddr);

  await (await locker.initFactory(curveAddr)).wait(); // the curve registers graduated positions with the locker
  console.log("Locker wired to the curve.");

  const factory = await (await hre.ethers.getContractFactory("LaunchFactory")).deploy(uni.WETH, curveAddr);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("LaunchFactory: ", factoryAddr);

  const factoryV2 = await (await hre.ethers.getContractFactory("LaunchFactoryV2")).deploy(uni.WETH, curveAddr, uni.SwapRouter02, STOCK_SWAP_FEE, ALLOWANCE_HOLDER);
  await factoryV2.waitForDeployment();
  const factoryV2Addr = await factoryV2.getAddress();
  console.log("LaunchFactoryV2: ", factoryV2Addr);

  await (await curve.setFactory(factoryAddr, true)).wait();
  await (await curve.setFactory(factoryV2Addr, true)).wait();
  console.log("Curve authorised both factories.");

  // Optional: enable the one-tap ETH zap for a non-ETH quote (e.g. HOOD) via a Uniswap V3 multi-hop path.
  // Env-gated so we never guess the route — set on the mainnet deploy once the pools/tiers are confirmed.
  // HOOD has no direct WETH pool (liquidity is HOOD/USDG), so route WETH->USDG->HOOD, e.g.:
  //   ZAP_QUOTE=0x32ac8c1d7672667d5ebdea22935f7b06fc8d496f  (HOOD)
  //   ZAP_MIDS=0x5fc5360d0400a0fd4f2af552add042d716f1d168   (USDG)
  //   ZAP_FEES=<WETH/USDG tier>,10000                        (…,HOOD/USDG is the 1% pool)
  if (process.env.ZAP_QUOTE && process.env.ZAP_FEES) {
    const quote = process.env.ZAP_QUOTE;
    const mids = (process.env.ZAP_MIDS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const fees = process.env.ZAP_FEES.split(",").map((s) => Number(s.trim()));
    const inTokens = [uni.WETH, ...mids, quote];
    if (fees.length !== inTokens.length - 1) throw new Error("ZAP_FEES must have exactly (WETH + ZAP_MIDS + ZAP_QUOTE − 1) entries");
    const buildPath = (tokens, feeList) => {
      const types = [], vals = [];
      tokens.forEach((t, i) => { types.push("address"); vals.push(t); if (i < feeList.length) { types.push("uint24"); vals.push(feeList[i]); } });
      return hre.ethers.solidityPacked(types, vals);
    };
    const pathIn = buildPath(inTokens, fees);
    const pathOut = buildPath([...inTokens].reverse(), [...fees].reverse());
    await (await curve.setZapPath(quote, pathIn, pathOut)).wait();
    console.log(`Zap enabled for ${quote}: ${inTokens.join(" -> ")}`);
  }

  const out = {
    network: netName,
    chainId: uni.chainId,
    deployedAt: new Date().toISOString(),
    Treasury: treasuryAddr,
    TreasuryKind: treasuryKind,
    ...(feeVaultAddr ? { FeeVault: feeVaultAddr } : {}),
    ...(splitterAddr ? { FeeSplitter: splitterAddr } : {}),
    LaunchLocker: lockerAddr,
    CensusCurve: curveAddr,
    LaunchFactory: factoryAddr,
    LaunchFactoryV2: factoryV2Addr,
    uniswap: uni,
    verify: {
      ...(feeVaultAddr ? { FeeVault: [deployer.address] } : {}),
      ...(splitterAddr ? { FeeSplitter: splitterArgs } : {}),
      LaunchLocker: [uni.NonfungiblePositionManager, treasuryAddr, PROTOCOL_FEE_BPS],
      CensusCurve: [uni.NonfungiblePositionManager, treasuryAddr, lockerAddr, uni.WETH, uni.SwapRouter02],
      LaunchFactory: [uni.WETH, curveAddr],
      LaunchFactoryV2: [uni.WETH, curveAddr, uni.SwapRouter02, STOCK_SWAP_FEE, ALLOWANCE_HOLDER],
    },
  };
  const file = path.join(__dirname, "..", `deployments.${netName}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nSaved ${file}`);
  console.log("\nPaste into frontend/.env:\n" +
    `VITE_FACTORY_ADDRESS=${factoryAddr}\nVITE_FACTORY_V2_ADDRESS=${factoryV2Addr}\nVITE_LOCKER_ADDRESS=${lockerAddr}\nVITE_CURVE_ADDRESS=${curveAddr}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
