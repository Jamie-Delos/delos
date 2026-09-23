// The complete V4 product (factory -> curve -> graduation -> hooked pool -> reward vault) against the
// OFFICIAL Robinhood Chain PoolManager on a LOCAL fork. Opt-in: AUDIT_V4_FORK=1. Pin with AUDIT_FORK_BLOCK.
// Public RPC reads only; every deployment and transaction is local.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { deploy, deployHook } = require('./helpers/v4');
const E = ethers.parseEther;
const MIN = 4295128740n;
const MAX = 1461446703485210103287273052203988822378723970341n;
const SIG = 'createLaunch((string,string,uint256,uint8,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])';
const ROBINHOOD = require('../scripts/addresses').robinhood;
const ev = (receipt, contract, name) => receipt.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === name);

const suite = process.env.AUDIT_V4_FORK === '1' ? describe : describe.skip;
suite('V4 product on a Robinhood Chain fork (official PoolManager, local transactions only)', function () {
  this.timeout(300000);
  it('launches, trades on the curve, graduates into the official PoolManager, trades through the hook and distributes reflections in the pairing asset', async () => {
    if (network.name !== 'hardhat') throw new Error('LOCAL HARDHAT ONLY');
    const rpc = 'https://rpc.mainnet.chain.robinhood.com';
    const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), signal: AbortSignal.timeout(15000) });
    const body = await response.json(); if (!body.result) throw new Error('no fork block');
    const blockNumber = process.env.AUDIT_FORK_BLOCK ? Number(process.env.AUDIT_FORK_BLOCK) : Number(BigInt(body.result));
    await network.provider.send('hardhat_reset', [{ forking: { jsonRpcUrl: rpc, blockNumber } }]);
    console.log(`      Robinhood dependency state pinned at block ${blockNumber}; deployments and trades LOCAL ONLY`);

    const [owner, treasury, creator, alice, bob, keeper] = await ethers.getSigners();
    const manager = await ethers.getContractAt('PoolManager', ROBINHOOD.v4.PoolManager);
    const weth = new ethers.Contract(ROBINHOOD.WETH, ['function deposit() payable', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], owner);
    const curve = await deploy('CensusCurveV4', treasury.address, ROBINHOOD.WETH, ROBINHOOD.SwapRouter02);
    const graduator = await deploy('CensusV4Graduator', manager.target, curve.target, treasury.address);
    const hook = await deployHook(manager.target, graduator.target, treasury.address);
    await graduator.setHook(hook.target);
    await curve.setGraduator(graduator.target);
    const router = await deploy('CensusV4Router', manager.target, hook.target);
    const vaultDeployer = await deploy('CensusRewardVaultDeployer');
    const factory = await deploy('LaunchFactoryV4', ROBINHOOD.WETH, curve.target, ROBINHOOD.SwapRouter02, 3000, ethers.ZeroAddress, router.target, vaultDeployer.target);
    await vaultDeployer.setLaunchFactory(factory.target);
    await curve.setFactory(factory.target, true);
    await curve.setKeeper(keeper.address);

    const rc = await (await factory.connect(creator)[SIG](['Fork V4', 'FV4', E('1000000000'), 18, E('1.5'), E('4')], [ROBINHOOD.WETH], [10000], ['0x'], ethers.ZeroHash, ROBINHOOD.WETH, 200, [])).wait();
    const launched = ev(rc, factory, 'LaunchedV4')[0].args;
    const token = await ethers.getContractAt('LaunchToken', launched.token);
    const vault = await ethers.getContractAt('CensusRewardVault', launched.vault);
    await network.provider.send('evm_increaseTime', [10]); await network.provider.send('evm_mine');

    await curve.connect(alice).buyWithETH(token.target, 0, { value: E('1') });
    const fill = await (await curve.connect(bob).buyWithETH(token.target, 0, { value: E('10') })).wait(); // capped final fill, ETH refund, auto-graduation
    expect(await curve.graduationProgress(token.target)).to.equal(10000n);
    const g = ev(fill, curve, 'Graduated')[0].args;
    expect(await token.balanceOf(manager.target)).to.equal(g.tokensIn);
    expect(await weth.balanceOf(manager.target) >= g.quoteIn).to.equal(true);

    const coin0 = BigInt(token.target) < BigInt(ROBINHOOD.WETH);
    const key = { currency0: coin0 ? token.target : ROBINHOOD.WETH, currency1: coin0 ? ROBINHOOD.WETH : token.target, fee: 0, tickSpacing: 60, hooks: hook.target };
    await weth.connect(alice).deposit({ value: E('1') }); await weth.connect(alice).approve(router.target, E('1'));
    const buy = { key, zeroForOne: !coin0, amountIn: E('0.5'), minOut: 1n, sqrtPriceLimitX96: coin0 ? MAX : MIN, recipient: alice.address, deadline: ethers.MaxUint256 };
    const out = await router.connect(alice).swapExactInput.staticCall(buy);
    const swap = ev(await (await router.connect(alice).swapExactInput({ ...buy, minOut: out })).wait(), hook, 'FeeAccrued')[0].args;
    expect([swap.protocolFee, swap.creatorFee, swap.holderFee]).to.deep.equal([E('0.003'), E('0.007'), E('0.01')]);
    await token.connect(alice).approve(router.target, out);
    await router.connect(alice).swapExactInput({ ...buy, zeroForOne: coin0, amountIn: out, sqrtPriceLimitX96: coin0 ? MIN : MAX });
    await hook.connect(keeper).claimFor(ROBINHOOD.WETH, vault.target);
    const reservedBefore = await vault.reserved(ROBINHOOD.WETH);
    await vault.connect(keeper).distribute([0]);
    expect(await vault.reserved(ROBINHOOD.WETH)).to.be.gt(reservedBefore);
    expect(await vault.withdrawableOf(bob.address, ROBINHOOD.WETH)).to.be.gt(0n);
    await vault.connect(bob).claim();
    expect(await weth.balanceOf(hook.target)).to.equal(await hook.totalReserved(ROBINHOOD.WETH));
    console.log('      V4 lifecycle verified against the official PoolManager at', manager.target);
  });
});
