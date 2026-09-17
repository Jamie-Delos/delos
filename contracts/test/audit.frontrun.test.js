// AUDIT (2026-09-17), CX-F1: launch front-running via CREATE2 — and the fix.
// Before the fix, the vanity address depended only on (name, symbol, supply, decimals, salt), so a
// mempool watcher could resubmit the identical params+salt, become the coin's creator, and revert the
// victim. The fix binds the CREATE2 salt to the creator: the factory deploys with
// keccak256(abi.encodePacked(salt, msg.sender)). This test proves the attacker can no longer occupy
// the victim's reserved address, and the victim's launch still succeeds.
// Local Hardhat only; no external chain or keys.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const E = ethers.parseEther;

async function deploy(name, ...args) {
  const c = await (await ethers.getContractFactory(name)).deploy(...args);
  await c.waitForDeployment(); return c;
}

// Grind a salt whose CREATE2 address ends in 0xc0de, mirroring the factory's creator-bound derivation
// (effective salt = keccak256(abi.encodePacked(salt, creator))) exactly as grindSalt.js / c0de.ts do.
function grind(factoryAddr, initCodeHash, creator) {
  for (let i = 0; i < 2000000; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const eff = ethers.solidityPackedKeccak256(['bytes32', 'address'], [salt, creator]);
    const addr = ethers.getCreate2Address(factoryAddr, eff, initCodeHash);
    if (addr.toLowerCase().endsWith('c0de')) return { salt, addr };
  }
  throw new Error('no salt found');
}

describe('AUDIT CX-F1: launch front-running is prevented (vanity address bound to the creator)', function () {
  this.timeout(120000);
  it('an attacker cannot reproduce the victim\'s vanity address; the victim\'s launch still succeeds', async () => {
    const [deployer, victim, attacker] = await ethers.getSigners();
    const weth = await deploy('WETH9');
    const UF = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
    const NPM = require('@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json');
    const ROUTER = require('@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json');
    const uni = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, deployer).deploy(...args); await c.waitForDeployment(); return c; };
    const uf = await uni(UF);
    const npm = await uni(NPM, uf.target, weth.target, ethers.ZeroAddress);
    const router = await uni(ROUTER, ethers.ZeroAddress, uf.target, npm.target, weth.target);
    const locker = await deploy('LaunchLocker', npm.target, deployer.address, 2500);
    const curve = await deploy('CensusCurve', npm.target, deployer.address, locker.target, weth.target, router.target);
    await locker.initFactory(curve.target);
    const factory = await deploy('LaunchFactory', weth.target, curve.target);
    await curve.setFactory(factory.target, true);

    const p = { name: 'Census Coin', symbol: 'CENS', totalSupply: E('1000000000'), decimals: 18, poolFee: 10000, virtualQuote: E('1.5'), graduationQuote: E('4') };
    const params = [p.name, p.symbol, p.totalSupply, p.decimals, p.poolFee, p.virtualQuote, p.graduationQuote];
    const LT = await ethers.getContractFactory('LaunchToken');
    const initHash = ethers.keccak256(ethers.concat([
      LT.bytecode,
      ethers.AbiCoder.defaultAbiCoder().encode(['string', 'string', 'uint256', 'uint8', 'address'], [p.name, p.symbol, p.totalSupply, p.decimals, factory.target]),
    ]));

    // The victim grinds a salt bound to THEIR address and reserves that …c0de address.
    const { salt, addr: victimAddr } = grind(factory.target, initHash, victim.address);
    expect(victimAddr.toLowerCase().endsWith('c0de')).to.equal(true);

    const sig = 'createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32)';

    // ATTACKER front-runs with the victim's identical params + salt. The on-chain salt is
    // keccak256(salt, attacker) → a different address that is (overwhelmingly) not …c0de → revert.
    let attackerToken = null;
    try {
      const rc = await (await factory.connect(attacker)[sig](params, salt)).wait();
      attackerToken = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'Launched').args.token;
    } catch { /* reverted "not a census address" — expected */ }
    if (attackerToken) expect(attackerToken.toLowerCase()).to.not.equal(victimAddr.toLowerCase());

    // The victim's reserved address is untouched: their launch succeeds and they are the creator.
    await expect(factory.connect(victim)[sig](params, salt)).not.to.be.reverted;
    const c = await curve.curves(victimAddr);
    expect(c.exists).to.equal(true);
    expect(c.creator).to.equal(victim.address);
  });
});
