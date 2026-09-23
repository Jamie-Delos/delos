// Repeatable local rehearsal of the V4 product against the actual Uniswap V4 PoolManager bytecode. Never a
// public network. Writes audit/V4-LIFECYCLE-RESULTS.{json,md} with every step's fee allocation.
//   npx hardhat run scripts/rehearseV4Lifecycle.js --network hardhat
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers, network } = require('hardhat');
const { findHookSalt } = require('./lib/hookSalt');
const E = ethers.parseEther, S = E('1000000000');
const MIN = 4295128740n, MAX = 1461446703485210103287273052203988822378723970341n;
const SIG = 'createLaunch((string,string,uint256,uint8,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])';
const fmt = (x) => ethers.formatEther(x);
const find = (rc, c, name) => rc.logs.map((l) => { try { return c.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === name);
async function deploy(name, ...args) { const c = await (await ethers.getContractFactory(name)).deploy(...args); await c.waitForDeployment(); return c; }

async function scenario(label, reflectionBps, basket, weights) {
  const [owner, treasury, creator, alice, bob, carol, keeper] = await ethers.getSigners();
  const weth = await deploy('WETH9'), v3Router = await deploy('MockSwapRouter'), stock = await deploy('MockERC20', 'NVIDIA', 'NVDA');
  await stock.mint(v3Router.target, E('1000000'));
  const manager = await deploy('PoolManager', owner.address);
  const curve = await deploy('CensusCurveV4', treasury.address, weth.target, v3Router.target);
  const graduator = await deploy('CensusV4Graduator', manager.target, curve.target, treasury.address);
  const hookDeployer = await deploy('CensusHookDeployer');
  const HookFactory = await ethers.getContractFactory('CensusV4Hook');
  const code = (await HookFactory.getDeployTransaction(manager.target, graduator.target, treasury.address)).data;
  const { salt, address } = findHookSalt(hookDeployer.target, code);
  await (await hookDeployer.deploy(salt, code)).wait();
  const hook = HookFactory.attach(address);
  await graduator.setHook(hook.target); await curve.setGraduator(graduator.target);
  const router = await deploy('CensusV4Router', manager.target, hook.target);
  const vaultDeployer = await deploy('CensusRewardVaultDeployer');
  const factory = await deploy('LaunchFactoryV4', weth.target, curve.target, v3Router.target, 3000, ethers.ZeroAddress, router.target, vaultDeployer.target);
  await vaultDeployer.setLaunchFactory(factory.target); await curve.setFactory(factory.target, true); await curve.setKeeper(keeper.address);
  await curve.setRewardAssetAllowed(stock.target, true);
  for (const a of [alice, bob, carol]) { await weth.connect(a).deposit({ value: E('20') }); await weth.connect(a).approve(curve.target, ethers.MaxUint256); await weth.connect(a).approve(router.target, ethers.MaxUint256); }
  const resolvedBasket = basket.map((b) => b === 'weth' ? weth.target : stock.target);
  const rc = await (await factory.connect(creator)[SIG](['Lifecycle', 'LIFE', S, 18, E('1.5'), E('4')], resolvedBasket, weights, resolvedBasket.map(() => '0x'), ethers.ZeroHash, weth.target, reflectionBps, [])).wait();
  const launched = find(rc, factory, 'LaunchedV4')[0].args;
  const token = await ethers.getContractAt('LaunchToken', launched.token);
  const vault = launched.vault === ethers.ZeroAddress ? null : await ethers.getContractAt('CensusRewardVault', launched.vault);
  const result = { label, reflectionBps, basket, weights, hook: hook.target, steps: [], checks: [] };
  const step = async (name, receipt, extra = {}) => {
    const alloc = find(receipt, curve, 'FeeAllocated')[0]?.args ?? find(receipt, hook, 'FeeAccrued')[0]?.args;
    const c = await curve.curves(token.target);
    result.steps.push({ step: name, gasUsed: receipt.gasUsed.toString(), tokenReserve: fmt(c.tokenReserve), realQuote: fmt(c.realQuote), graduated: c.graduated,
      fee: alloc ? { protocol: fmt(alloc.protocolFee), creator: fmt(alloc.creatorFee), holders: fmt(alloc.holderFee), penalty: alloc.penalty !== undefined ? fmt(alloc.penalty) : '0' } : null, ...extra });
  };
  const launchedAt = Number(await curve.launchedAt(token.target));
  await network.provider.send('evm_setNextBlockTimestamp', [launchedAt + 1]);
  await step('window buy +1s (penalised)', await (await curve.connect(alice).buy(token.target, E('0.1'), 0)).wait(), { actor: 'alice', quoteIn: '0.1' });
  for (const a of [alice, bob, carol]) { await token.connect(a).approve(curve.target, ethers.MaxUint256); await token.connect(a).approve(router.target, ethers.MaxUint256); }
  await network.provider.send('evm_increaseTime', [10]);
  await step('buy 1 ETH', await (await curve.connect(alice).buyWithETH(token.target, 0, { value: E('1') })).wait(), { actor: 'alice', quoteIn: '1' });
  await step('sell half', await (await curve.connect(alice).sell(token.target, (await token.balanceOf(alice.address)) / 2n, 0)).wait(), { actor: 'alice' });
  await step('buy 0.5 ETH', await (await curve.connect(bob).buy(token.target, E('0.5'), 0)).wait(), { actor: 'bob', quoteIn: '0.5' });
  if (vault) {
    const before = await vault.availableQuote();
    const rcD = await (await vault.connect(keeper).distribute(resolvedBasket.map((b) => b === weth.target ? 0 : 1))).wait();
    result.steps.push({ step: 'distribute (pre-graduation)', gasUsed: rcD.gasUsed.toString(), quoteDistributed: fmt(before), reserved: await Promise.all(resolvedBasket.map(async (b, i) => `${basket[i]}=${fmt(await vault.reserved(b))}`)) });
  }
  const maximum = await curve.maxQuoteInFor(token.target, carol.address);
  const rcG = await (await curve.connect(carol).buyWithETH(token.target, 0, { value: E('10') })).wait();
  await step('final fill 10 ETH (capped, refund) — graduates in the same tx', rcG, { actor: 'carol', accepted: fmt(maximum), refunded: fmt(E('10') - maximum) });
  const g = find(rcG, curve, 'Graduated')[0].args;
  result.steps.push({ step: 'graduate -> V4 (automatic, inside the fill)', gasUsed: rcG.gasUsed.toString(), poolId: g.poolId, tokensIn: fmt(g.tokensIn), quoteIn: fmt(g.quoteIn), liquidity: g.liquidity.toString(), tokenDust: fmt(await curve.migrationTokenDust(token.target)), quoteDust: fmt(await curve.migrationQuoteDust(token.target)) });
  const coin0 = BigInt(token.target) < BigInt(weth.target);
  const key = { currency0: coin0 ? token.target : weth.target, currency1: coin0 ? weth.target : token.target, fee: 0, tickSpacing: 60, hooks: hook.target };
  const buy = { key, zeroForOne: !coin0, amountIn: E('0.2'), minOut: 1n, sqrtPriceLimitX96: coin0 ? MAX : MIN, recipient: bob.address, deadline: ethers.MaxUint256 };
  await step('pool buy 0.2 (hook)', await (await router.connect(bob).swapExactInput(buy)).wait(), { actor: 'bob', quoteIn: '0.2' });
  await step('pool sell all (hook)', await (await router.connect(bob).swapExactInput({ ...buy, zeroForOne: coin0, amountIn: await token.balanceOf(bob.address), sqrtPriceLimitX96: coin0 ? MIN : MAX })).wait(), { actor: 'bob' });
  for (const [who, name] of [[treasury.address, 'treasury'], [creator.address, 'creator'], ...(vault ? [[vault.target, 'vault']] : [])]) {
    const owed = await hook.claimable(weth.target, who);
    await hook.connect(keeper).claimFor(weth.target, who);
    result.steps.push({ step: `hook.claimFor ${name}`, amount: fmt(owed) });
  }
  if (vault) {
    const before = await vault.availableQuote();
    await (await vault.connect(keeper).distribute(resolvedBasket.map((b) => b === weth.target ? 0 : 1))).wait();
    result.steps.push({ step: 'distribute (post-graduation)', quoteDistributed: fmt(before) });
    for (const who of [alice, carol]) {
      const owed = await Promise.all(resolvedBasket.map((b) => vault.withdrawableOf(who.address, b)));
      const rcC = await (await vault.connect(who).claim()).wait();
      result.steps.push({ step: `claim ${who === alice ? 'alice' : 'carol'}`, paid: find(rcC, vault, 'Claimed').length, owed: owed.map((o, i) => `${basket[i]}=${fmt(o)}`) });
    }
    for (const b of resolvedBasket) assert.ok(await (await ethers.getContractAt('MockERC20', b)).balanceOf(vault.target) >= await vault.reserved(b));
    assert.equal(await token.balanceOf(vault.target), 0n); result.checks.push('vault never holds the coin');
    result.checks.push('vault solvent for every reserved asset');
  }
  assert.equal(await weth.balanceOf(hook.target), await hook.totalReserved(weth.target)); result.checks.push('hook custody equals reserved liabilities');
  assert.equal(await token.balanceOf(graduator.target), 0n); result.checks.push('graduator holds nothing');
  let sum = 0n; for (const a of [alice, bob, carol, manager, curve, treasury, creator, ...(vault ? [vault] : [])]) sum += await token.balanceOf(a.address ?? a.target);
  assert.equal(sum, await token.totalSupply()); result.checks.push('1B supply fully accounted for');
  console.log(`${label}: ${result.steps.length} steps, ${result.checks.length} checks`);
  return result;
}

async function main() {
  if (network.name !== 'hardhat') throw new Error('LOCAL HARDHAT ONLY');
  const results = [await scenario('meme launch, reflection off', 0, [], []), await scenario('company launch, 3% reflection, basket ETH/stock', 300, ['weth', 'stock'], [4000, 6000])];
  const dir = path.join(__dirname, '..', '..', 'audit');
  fs.writeFileSync(path.join(dir, 'V4-LIFECYCLE-RESULTS.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  const md = ['# V4 lifecycle rehearsal results', '', `Generated ${new Date().toISOString()} by contracts/scripts/rehearseV4Lifecycle.js (local Hardhat, real Uniswap V4 PoolManager bytecode).`, ''];
  for (const r of results) {
    md.push(`## ${r.label}`, '', '| step | fee protocol | fee creator | fee holders | penalty | tokenReserve | realQuote | notes |', '|---|---|---|---|---|---|---|---|');
    for (const s of r.steps) md.push(`| ${s.step} | ${s.fee?.protocol ?? ''} | ${s.fee?.creator ?? ''} | ${s.fee?.holders ?? ''} | ${s.fee?.penalty ?? ''} | ${s.tokenReserve ?? ''} | ${s.realQuote ?? ''} | ${Object.entries(s).filter(([k]) => !['step', 'fee', 'tokenReserve', 'realQuote', 'graduated', 'gasUsed'].includes(k)).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(' ') : v}`).join(', ')} |`);
    md.push('', `Checks: ${r.checks.join('; ')}`, '');
  }
  fs.writeFileSync(path.join(dir, 'V4-LIFECYCLE-RESULTS.md'), md.join('\n'));
  console.log('ALL V4 LIFECYCLE SCENARIOS PASSED');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
