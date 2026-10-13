// Delos vanity addresses. LaunchFactoryV4 enforces `…de105` (VANITY_SUFFIX over VANITY_MASK) on grinded
// salts, keeps the plain zero-salt path, and exposes the constants the grinders read.
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deploy, deployHook } = require('./helpers/v4');
const { grindSalt, predict, vanityOf } = require('../scripts/lib/grindSalt');
const E = ethers.parseEther;
const SIG = 'createLaunch((string,string,uint256,uint8,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])';
const ARGS = { name: 'Delos Vanity', symbol: 'DLV', totalSupply: E('1000000000'), decimals: 18 };
const PARAMS = [ARGS.name, ARGS.symbol, ARGS.totalSupply, ARGS.decimals, E('1.5'), E('1')];
// Deterministic on a fresh Hardhat network (fixed signers and nonces, pinned LaunchToken bytecode): the
// salt that lands ARGS on a …de105 address for `creator` from the factory stack() deploys. If the stack,
// the signers or the token bytecode change, the test grinds a fresh one (slower) and prints it here.
// Regenerate: VANITY_GRIND=1 npx hardhat test test/v4.vanity.test.js
const KNOWN_SALT = process.env.KNOWN_SALT || '0x00000000000000000000000000000000000000000000000000000000000aef4e';

async function stack() {
  const [owner, treasury, creator, , , , , keeper] = await ethers.getSigners();
  const weth = await deploy('MockWETH');
  const v3Router = await deploy('MockSwapRouter');
  const manager = await deploy('PoolManager', owner.address);
  const curve = await deploy('CensusCurveV4', treasury.address, weth.target, v3Router.target);
  const graduator = await deploy('CensusV4Graduator', manager.target, curve.target, treasury.address);
  const hook = await deployHook(manager.target, graduator.target, treasury.address);
  await graduator.setHook(hook.target);
  await curve.setGraduator(graduator.target);
  const v4Router = await deploy('CensusV4Router', manager.target, hook.target);
  const vaultDeployer = await deploy('CensusRewardVaultDeployer');
  const factory = await deploy('LaunchFactoryV4', weth.target, curve.target, v3Router.target, 3000, ethers.ZeroAddress, v4Router.target, vaultDeployer.target);
  await vaultDeployer.setLaunchFactory(factory.target);
  await curve.setFactory(factory.target, true);
  await curve.setKeeper(keeper.address);
  return { factory, curve, creator, stranger: (await ethers.getSigners())[8] };
}
const launched = (receipt, factory) => receipt.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'LaunchedV4').args;
const endsDe105 = (addr) => (BigInt(addr) & 0xfffffn) === 0xde105n;
// The factory is compiled with revert strings stripped (legacy settings), so a failed suffix check reverts without data.

describe('V4 vanity: every grinded Delos address ends in de105', function () {
  this.timeout(1_800_000);
  let s;
  before(async () => { s = await stack(); });

  it('exposes the suffix and mask the grinders read', async () => {
    expect(await s.factory.VANITY_SUFFIX()).to.equal(0xde105n);
    expect(await s.factory.VANITY_MASK()).to.equal(0xfffffn);
    expect(await vanityOf(s.factory.target)).to.deep.equal({ suffix: 0xde105n, mask: 0xfffffn });
  });

  it('still deploys plainly with the zero salt (no vanity, no grind)', async () => {
    const rc = await (await s.factory.connect(s.creator)[SIG](PARAMS, [], [], [], ethers.ZeroHash, ethers.ZeroAddress, 0, [])).wait();
    const { token, creator } = launched(rc, s.factory);
    expect(creator).to.equal(s.creator.address);
    expect((await s.curve.curves(token)).exists).to.equal(true);
  });

  it('rejects a grinded salt whose address does not end in de105', async () => {
    for (const i of [1, 2, 3]) { // salt 1 is (overwhelmingly) not a de105 address; the loop guards the 1-in-a-million case
      const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      if (endsDe105(await predict(s.factory.target, ARGS, s.creator.address, salt))) continue;
      await expect(s.factory.connect(s.creator)[SIG](PARAMS, [], [], [], salt, ethers.ZeroAddress, 0, [])).to.be.reverted;
      return;
    }
    throw new Error('salts 1..3 all land on de105 addresses, which is absurd');
  });

  it('accepts the de105 address the grinder predicts, bound to the creator', async () => {
    let salt = KNOWN_SALT, address = await predict(s.factory.target, ARGS, s.creator.address, KNOWN_SALT);
    if (process.env.VANITY_GRIND || !endsDe105(address)) {
      const t0 = Date.now();
      const g = await grindSalt(s.factory.target, ARGS, s.creator.address);
      salt = g.salt; address = g.address;
      console.log(`      grinded ${address} in ${g.tries} tries (${((Date.now() - t0) / 1000).toFixed(1)} s). Pin it: KNOWN_SALT = '${salt}'`);
    }
    expect(endsDe105(address)).to.equal(true);
    // The same salt from another wallet lands elsewhere, so the reserved address cannot be hijacked (CX-F1).
    const elsewhere = await predict(s.factory.target, ARGS, s.stranger.address, salt);
    expect(elsewhere.toLowerCase()).to.not.equal(address.toLowerCase());
    if (!endsDe105(elsewhere)) await expect(s.factory.connect(s.stranger)[SIG](PARAMS, [], [], [], salt, ethers.ZeroAddress, 0, [])).to.be.reverted;
    const rc = await (await s.factory.connect(s.creator)[SIG](PARAMS, [], [], [], salt, ethers.ZeroAddress, 0, [])).wait();
    const { token } = launched(rc, s.factory);
    expect(token.toLowerCase()).to.equal(address.toLowerCase());
    expect(token.toLowerCase().endsWith('de105')).to.equal(true);
    expect((await s.curve.curves(token)).creator).to.equal(s.creator.address);
  });
});
