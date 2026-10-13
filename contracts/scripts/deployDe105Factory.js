// Deploy a fresh LaunchFactoryV4 (de105 vanity) against an EXISTING V4 stack, plus the reward-vault
// deployer it needs, and bind them. The curve, graduator, hook, router and PoolManager stay as they are.
//
//   PRIVATE_KEY=0x… npx hardhat run scripts/deployDe105Factory.js --network robinhood
//
// Anyone can run this: the factory and its vault deployer have no privileged setup beyond
// vaultDeployer.setLaunchFactory, which the deployer of the vault deployer (this signer) owns. The one
// step that needs the curve's deployer wallet is curve.setFactory(factory, true); when this signer IS
// that wallet it is sent here, otherwise the exact call is printed for it. Until that call lands the
// factory reverts every launch (the curve refuses registrations from unknown factories), so nothing can
// go wrong by deploying early.
//
// Defaults are the Robinhood Chain team-test stack (docs/MAINNET-TEAM-TEST-2026-09-24.md); override with
// WETH, CURVE_V4, SWAP_ROUTER, V4_ROUTER, STOCK_SWAP_FEE, ALLOWANCE_HOLDER.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const TEAM_TEST = {
  WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  CURVE_V4: "0xD1300ccE1Ed4c778791cF713b6bA47FE32B217C3",
  SWAP_ROUTER: "0xCaf681a66D020601342297493863E78C959E5cb2", // Uniswap V3 SwapRouter02 (stock routes)
  V4_ROUTER: "0xb087d45099D9e275c67693eD1a215c66B4907BA6",
  STOCK_SWAP_FEE: 3000,
  ALLOWANCE_HOLDER: "0x0000000000001fF3684f28c67538d4D072C22734", // 0x AllowanceHolder (Cancun singleton)
};

async function deployDe105Factory(signer, cfg = {}) {
  const { ethers } = hre;
  const c = {
    weth: cfg.weth || process.env.WETH || TEAM_TEST.WETH,
    curve: cfg.curve || process.env.CURVE_V4 || TEAM_TEST.CURVE_V4,
    swapRouter: cfg.swapRouter || process.env.SWAP_ROUTER || TEAM_TEST.SWAP_ROUTER,
    v4Router: cfg.v4Router || process.env.V4_ROUTER || TEAM_TEST.V4_ROUTER,
    stockSwapFee: Number(cfg.stockSwapFee || process.env.STOCK_SWAP_FEE || TEAM_TEST.STOCK_SWAP_FEE),
    allowanceHolder: cfg.allowanceHolder || process.env.ALLOWANCE_HOLDER || TEAM_TEST.ALLOWANCE_HOLDER,
  };
  for (const [k, a] of Object.entries(c)) {
    if (typeof a === "string" && (await ethers.provider.getCode(a)) === "0x") throw new Error(`${k} ${a} has no code on this network`);
  }
  const curve = await ethers.getContractAt("CensusCurveV4", c.curve, signer);
  const router = await ethers.getContractAt("CensusV4Router", c.v4Router, signer);
  if ((await curve.weth()).toLowerCase() !== c.weth.toLowerCase()) throw new Error("curve.weth() does not match WETH");
  if ((await curve.swapRouter()).toLowerCase() !== c.swapRouter.toLowerCase()) throw new Error("curve.swapRouter() does not match SWAP_ROUTER");
  if ((await router.hook()) === ethers.ZeroAddress) throw new Error("V4 router has no hook");

  const vaultDeployer = await (await ethers.getContractFactory("CensusRewardVaultDeployer", signer)).deploy();
  await vaultDeployer.waitForDeployment();
  const vaultDeployerAddr = await vaultDeployer.getAddress();
  const factory = await (await ethers.getContractFactory("LaunchFactoryV4", signer)).deploy(
    c.weth, c.curve, c.swapRouter, c.stockSwapFee, c.allowanceHolder, c.v4Router, vaultDeployerAddr,
  );
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  await (await vaultDeployer.setLaunchFactory(factoryAddr)).wait();

  // Wiring and the one thing this deploy is for.
  if ((await factory.curve()).toLowerCase() !== c.curve.toLowerCase()) throw new Error("factory.curve mismatch");
  if ((await factory.v4Router()).toLowerCase() !== c.v4Router.toLowerCase()) throw new Error("factory.v4Router mismatch");
  if ((await factory.vaultDeployer()).toLowerCase() !== vaultDeployerAddr.toLowerCase()) throw new Error("factory.vaultDeployer mismatch");
  if ((await vaultDeployer.launchFactory()).toLowerCase() !== factoryAddr.toLowerCase()) throw new Error("vault deployer not bound");
  if ((await factory.VANITY_SUFFIX()) !== 0xde105n || (await factory.VANITY_MASK()) !== 0xfffffn) throw new Error("factory is not a de105 build");

  const curveDeployer = await curve.deployer();
  let authorised = false, authorisation = null;
  if (curveDeployer.toLowerCase() === signer.address.toLowerCase()) {
    await (await curve.setFactory(factoryAddr, true)).wait();
    authorised = true;
  } else {
    authorisation = { from: curveDeployer, to: c.curve, data: curve.interface.encodeFunctionData("setFactory", [factoryAddr, true]) };
  }
  return { ...c, vaultDeployer: vaultDeployerAddr, factory: factoryAddr, curveDeployer, authorised, authorisation };
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("No signer: set PRIVATE_KEY for this network");
  const net = await hre.ethers.provider.getNetwork();
  console.log(`network ${hre.network.name} (chainId ${net.chainId}) · signer ${signer.address}`);
  const r = await deployDe105Factory(signer);
  console.log(`CensusRewardVaultDeployer: ${r.vaultDeployer}`);
  console.log(`LaunchFactoryV4 (de105):   ${r.factory}`);
  if (r.authorised) console.log("curve.setFactory(factory, true): sent by this signer (it is the curve deployer).");
  else {
    console.log(`\nNOT YET AUTHORISED. The curve deployer ${r.curveDeployer} must send:`);
    console.log(`  to:   ${r.authorisation.to}`);
    console.log(`  data: ${r.authorisation.data}`);
    console.log(`  (CensusCurveV4.setFactory(${r.factory}, true))`);
  }
  console.log("\nFrontend env (both launch paths use the one factory):");
  console.log(`  VITE_FACTORY_V4_ADDRESS=${r.factory}`);
  console.log(`  VITE_FACTORY_V4_DEV_BUY=${r.factory}`);
  const out = { network: hre.network.name, chainId: Number(net.chainId), deployedAt: new Date().toISOString(), signer: signer.address, ...r,
    verify: { CensusRewardVaultDeployer: [], LaunchFactoryV4: [r.weth, r.curve, r.swapRouter, r.stockSwapFee, r.allowanceHolder, r.v4Router, r.vaultDeployer] } };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hre.network.name}-de105-factory.json`);
  fs.writeFileSync(file, JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`\nWritten ${path.relative(process.cwd(), file)}`);
}

module.exports = { deployDe105Factory, TEAM_TEST };
if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });
