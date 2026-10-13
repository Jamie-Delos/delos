// Rehearsal of "test 2" on a fork of Robinhood Chain mainnet: deploy the de105 factory against the live
// team-test stack, have the curve deployer authorise it, then launch a coin that must land on a …de105
// address, buy it to its 0.02 ETH target and watch it graduate into the live hook's pool.
// Opt-in (needs the mainnet RPC): DE105_FORK=1 npx hardhat test test/v4.de105.fork.test.js --network hardhat
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { deployDe105Factory, TEAM_TEST } = require('../scripts/deployDe105Factory');
const { grindSalt } = require('../scripts/lib/grindSalt');
const run = process.env.DE105_FORK === '1' ? describe : describe.skip;
const E = ethers.parseEther;
const SIG = 'createLaunch((string,string,uint256,uint8,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])';
const RPC = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';

run('de105 factory on a Robinhood mainnet fork: deploy, authorise, launch, bond, graduate', function () {
  this.timeout(1_800_000);
  let deployer, creator, buyer, curve, factory, r;

  before(async () => {
    const live = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true });
    const blockNumber = process.env.DE105_FORK_BLOCK ? Number(process.env.DE105_FORK_BLOCK) : (await live.getBlockNumber()) - 5;
    console.log('      fork block', blockNumber);
    await network.provider.send('hardhat_reset', [{ forking: { jsonRpcUrl: RPC, blockNumber } }]);
    // Hardhat has no hardfork history for chain 4663, so execution at the fork block itself is refused; mine one
    // local block first so every call and transaction runs on a locally produced (Cancun) block.
    await network.provider.send('evm_mine');
    [deployer, creator, buyer] = await ethers.getSigners();
    for (const a of [deployer, creator, buyer]) await network.provider.send('hardhat_setBalance', [a.address, '0x' + E('10').toString(16)]);
    r = await deployDe105Factory(deployer);
    factory = await ethers.getContractAt('LaunchFactoryV4', r.factory);
    curve = await ethers.getContractAt('CensusCurveV4', r.curve);
    console.log('      factory', r.factory, '| authorised by script:', r.authorised);
  });

  it('is refused by the curve until the curve deployer authorises it', async () => {
    const params = ['Delos Test 2', 'TEST2', E('1000000000'), 18, E('1.5'), E('0.02')];
    await expect(factory.connect(creator)[SIG](params, [], [], [], ethers.ZeroHash, ethers.ZeroAddress, 0, [])).to.be.reverted;
    // The printed authorisation, sent from the curve deployer (impersonated here), is the only step Neil has to do.
    await network.provider.send('hardhat_impersonateAccount', [r.curveDeployer]);
    await network.provider.send('hardhat_setBalance', [r.curveDeployer, '0x' + E('1').toString(16)]);
    const neil = await ethers.getSigner(r.curveDeployer);
    await (await neil.sendTransaction({ to: r.authorisation.to, data: r.authorisation.data })).wait();
    expect(await curve.factory(r.factory)).to.equal(true);
  });

  it('launches on a …de105 address, bonds at 0.02 ETH and graduates into the live pool', async () => {
    const args = { name: 'Delos Test 2', symbol: 'TEST2', totalSupply: E('1000000000'), decimals: 18 };
    const t0 = Date.now();
    const g = await grindSalt(r.factory, args, creator.address);
    console.log(`      grinded ${g.address} in ${g.tries} tries (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    expect(g.address.toLowerCase().endsWith('de105')).to.equal(true);

    const params = [args.name, args.symbol, args.totalSupply, args.decimals, E('1.5'), E('0.02')];
    const rc = await (await factory.connect(creator)[SIG](params, [], [], [], g.salt, ethers.ZeroAddress, 0, [])).wait();
    const launched = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === 'LaunchedV4').args;
    expect(launched.token.toLowerCase()).to.equal(g.address.toLowerCase());
    const rec = await curve.curves(launched.token);
    expect(rec.graduationQuote).to.equal(E('0.02'));
    expect(rec.creator).to.equal(creator.address);

    // A friend buys after the 3-second snipe window: the buy caps at the target, refunds the rest, and
    // the same transaction graduates the coin into the canonical hooked pool.
    await network.provider.send('evm_increaseTime', [5]);
    await network.provider.send('evm_mine');
    const before = await ethers.provider.getBalance(buyer.address);
    const buy = await (await curve.connect(buyer).buyWithETH(launched.token, 0, { value: E('0.1') })).wait();
    const names = buy.logs.map((l) => { try { return curve.interface.parseLog(l)?.name; } catch { return null; } }).filter(Boolean);
    console.log('      buy events:', names.join(', '));
    expect(names).to.include('Traded');
    expect(names).to.include('Graduated');
    const after = await curve.curves(launched.token);
    expect(after.graduated).to.equal(true);
    expect(await curve.graduationProgress(launched.token)).to.equal(10000n);
    const spent = before - (await ethers.provider.getBalance(buyer.address));
    console.log(`      buyer spent ${ethers.formatEther(spent)} ETH of the 0.1 sent (rest refunded, incl. gas)`);
    expect(spent).to.be.lessThan(E('0.03'));
    const bal = await (await ethers.getContractAt('LaunchToken', launched.token)).balanceOf(buyer.address);
    expect(bal).to.be.greaterThan(0n);
  });
});
