// Deploys a full Uniswap V3 stack (WETH9 + Factory + NonfungiblePositionManager + SwapRouter02)
// from Uniswap's official prebuilt artifacts. Used to stand up Uniswap on a chain that lacks an
// official deployment (Robinhood testnet). Writes uniswap.<network>.json, which deploy.js/launch.js
// prefer over the hardcoded addresses.
//
//   npx hardhat run scripts/deployUniswapV3.js                          # local sanity check
//   npx hardhat run scripts/deployUniswapV3.js --network robinhoodTestnet
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const FACTORY = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");
const NFTDESC = require("@uniswap/v3-periphery/artifacts/contracts/libraries/NFTDescriptor.sol/NFTDescriptor.json");
const POSDESC = require("@uniswap/v3-periphery/artifacts/contracts/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json");
const NPM = require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");
const ROUTER = require("@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json");

// Splice deployed library addresses into a contract's bytecode placeholders.
function linkBytecode(artifact, libraries) {
  let bytecode = artifact.bytecode;
  for (const fileRefs of Object.values(artifact.linkReferences)) {
    for (const [libName, refs] of Object.entries(fileRefs)) {
      const addr = libraries[libName];
      if (!addr) throw new Error("missing library " + libName);
      const clean = addr.replace(/^0x/, "").toLowerCase();
      for (const { start, length } of refs) {
        const pos = 2 + start * 2;
        bytecode = bytecode.slice(0, pos) + clean + bytecode.slice(pos + length * 2);
      }
    }
  }
  return bytecode;
}

async function deploy(signer, artifact, bytecode, args = []) {
  const f = new hre.ethers.ContractFactory(artifact.abi, bytecode, signer);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return await c.getAddress();
}

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const net = hre.network.name;
  console.log(`Deploying Uniswap V3 stack on ${net} from ${signer.address}`);

  const wethC = await (await hre.ethers.getContractFactory("WETH9")).deploy();
  await wethC.waitForDeployment();
  const WETH = await wethC.getAddress();
  console.log("WETH9:                     ", WETH);

  const UniswapV3Factory = await deploy(signer, FACTORY, FACTORY.bytecode);
  console.log("UniswapV3Factory:          ", UniswapV3Factory);

  const nftLib = await deploy(signer, NFTDESC, NFTDESC.bytecode);
  const posDescBytecode = linkBytecode(POSDESC, { NFTDescriptor: nftLib });
  const label = hre.ethers.encodeBytes32String("ETH");
  const positionDescriptor = await deploy(signer, POSDESC, posDescBytecode, [WETH, label]);

  const NonfungiblePositionManager = await deploy(signer, NPM, NPM.bytecode, [
    UniswapV3Factory, WETH, positionDescriptor,
  ]);
  console.log("NonfungiblePositionManager:", NonfungiblePositionManager);

  const SwapRouter02 = await deploy(signer, ROUTER, ROUTER.bytecode, [
    hre.ethers.ZeroAddress, UniswapV3Factory, NonfungiblePositionManager, WETH,
  ]);
  console.log("SwapRouter02:              ", SwapRouter02);

  const out = {
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    UniswapV3Factory,
    NonfungiblePositionManager,
    SwapRouter02,
    WETH,
  };
  const file = path.join(__dirname, "..", `uniswap.${net}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nSaved ${file} — deploy.js/launch.js will use these automatically on --network ${net}.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
