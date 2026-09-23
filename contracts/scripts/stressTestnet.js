// Real-network stress test of the V4 product on Robinhood Chain TESTNET (chainId 46630). Broadcasts
// real testnet transactions from PRIVATE_KEY in contracts/.env. Never run against mainnet.
//
//   npx hardhat run scripts/stressTestnet.js --network robinhoodTestnet
//
// Phases (each phase is resumable through audit/testnet-stress-state.json):
//   1. deploy   - mock stocks + MockSwapRouter, then the full V4 stack via deployV4 logic (PoolManager copy,
//                 FeeVault treasury placeholder, keeper = deployer, stocks listed on the allowlist)
//   2. wallets  - derive and fund N trader wallets from the deployer
//   3. launch   - K launches with different reflection rates/baskets (small graduation targets)
//   4. window   - buys fired immediately after each launch (anti-snipe window on a real chain)
//   5. trades   - TRADES mixed buys/sells across wallets and coins, sent concurrently per round,
//                 every FeeAllocated checked against the fee formula
//   6. graduate - capped final fills + permissionless graduation into the V4 pool
//   7. pool     - POOL_TRADES router trades across wallets, hook FeeAccrued checked
//   8. rewards  - hook.claimFor (vault/creator/treasury), vault.distribute, claimFor(holder)
//   9. verify   - custody/solvency/supply invariants on-chain; report to audit/TESTNET-STRESS-<date>.{json,md}
const fs = require('node:fs');
const path = require('node:path');
const { ethers, network } = require('hardhat');
const { findHookSalt } = require('./lib/hookSalt');
const E = ethers.parseEther;
const BPS = 10000n;
const MIN = 4295128740n, MAX = 1461446703485210103287273052203988822378723970341n;
const SIG = 'createLaunch((string,string,uint256,uint8,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])';
const N_WALLETS = Number(process.env.STRESS_WALLETS || 10);
const K_COINS = Number(process.env.STRESS_COINS || 4);
const TRADES = Number(process.env.STRESS_TRADES || 500);
const POOL_TRADES = Number(process.env.STRESS_POOL_TRADES || 120);
const WALLET_FUND = E(process.env.STRESS_WALLET_ETH || '0.03');
const GRADUATION = E(process.env.STRESS_GRADUATION_ETH || '0.03');
const VIRTUAL = E(process.env.STRESS_VIRTUAL_ETH || '0.012');
const TRADE_UNIT = E(process.env.STRESS_TRADE_ETH || '0.0002');
const POOL_UNIT = E(process.env.STRESS_POOL_TRADE_ETH || '0.0003');
const FILL_BUFFER = E(process.env.STRESS_FILL_BUFFER_ETH || '0.002');
const STATE_FILE = path.join(__dirname, '..', '..', 'audit', `testnet-stress-state.${network.name}.json`);
const REPORT_BASE = path.join(__dirname, '..', '..', 'audit', `TESTNET-STRESS-${network.name}-${new Date().toISOString().slice(0, 10)}`);

const mulDiv = (a, b, c) => (a * b) / c;
function rates(reflection, elapsed, penalized) {
  let penalty = 0n;
  if (penalized && elapsed < 3) { const raw = 9900n >> BigInt(Math.floor((elapsed * 14) / 3)); const cap = 9900n - 200n - reflection; penalty = raw < cap ? raw : cap; }
  return { total: 200n + reflection + penalty, penalty };
}
function fees(gross, reflection, elapsed, penalized, graduated) {
  const r = rates(reflection, elapsed, penalized);
  const total = mulDiv(gross, r.total, BPS), holders = mulDiv(gross, reflection, BPS), penalty = mulDiv(gross, r.penalty, BPS);
  const shared = total - holders; const protocol = mulDiv(shared, graduated ? 3000n : 9000n, BPS);
  return { total, holders, penalty, protocol, creator: shared - protocol };
}
const ev = (rc, iface, name) => rc.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { network: network.name, phases: {}, txs: [], errors: [], timings: {} };
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(line); };
const recordTx = (phase, label, rc) => { state.txs.push({ phase, label, hash: rc.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString(), status: rc.status }); };
const recordError = (phase, label, e) => { const msg = (e?.shortMessage || e?.message || String(e)).slice(0, 2000); state.errors.push({ phase, label, error: msg }); log(`ERROR ${phase}/${label}: ${msg}`); };

// Sends with bounded retries for transient RPC/nonce problems; a REVERT is returned as {reverted} not retried.
async function send(phase, label, fn, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const tx = await fn();
      const rc = await tx.wait();
      recordTx(phase, label, rc);
      return rc;
    } catch (e) {
      const msg = String(e?.shortMessage || e?.message || e);
      const transient = /nonce|replacement|underpriced|timeout|ECONNRESET|429|503|502|network|already known|Too Many/i.test(msg) && !/revert/i.test(msg);
      if (transient && attempt < retries) { await sleep(500 * (attempt + 1)); continue; }
      if (/revert|CALL_EXCEPTION|execution reverted/i.test(msg)) return { reverted: true, error: msg };
      if (/insufficient funds/i.test(msg)) return { reverted: true, error: 'insufficient funds (wallet gas exhausted; harness budget, not a contract failure)', funds: true };
      throw e;
    }
  }
}

async function deploy(signer, name, ...args) {
  const f = await ethers.getContractFactory(name, signer);
  const c = await f.deploy(...args); await c.waitForDeployment();
  const rc = await c.deploymentTransaction().wait();
  recordTx('deploy', name, rc);
  return c;
}

async function main() {
  if (network.name === 'robinhood') throw new Error('never on mainnet');
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;
  const ADDR = require('./addresses')[network.name] || {};
  const t0 = Date.now();
  log(`stress on ${network.name} chainId ${(await provider.getNetwork()).chainId} deployer ${deployer.address} balance ${ethers.formatEther(await provider.getBalance(deployer.address))} ETH`);
  // Local dry run of this harness (network hardhat): deploy a WETH9 since there is no chain WETH.
  if (!state.phases.deploy && !ADDR.WETH) { const w = await deploy(deployer, 'WETH9'); state.localWeth = w.target; save(); }
  const wethAddr = ADDR.WETH || state.localWeth;
  const weth = new ethers.Contract(wethAddr, ['function deposit() payable', 'function withdraw(uint256)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'], deployer);

  // ---- 1. deploy ------------------------------------------------------------------------------
  if (!state.phases.deploy) {
    const p = Date.now();
    const stockRouter = await deploy(deployer, 'MockSwapRouter');
    const stocks = [];
    for (const [n, s] of [['NVIDIA', 'NVDA'], ['Apple', 'AAPL'], ['Tesla', 'TSLA']]) {
      const st = await deploy(deployer, 'MockERC20', n, s);
      await send('deploy', `mint ${s} to router`, () => st.mint(stockRouter.target, E('1000000000')));
      stocks.push(st.target);
    }
    const manager = await deploy(deployer, 'PoolManager', deployer.address);
    const treasury = await deploy(deployer, 'FeeVault', deployer.address); // PLACEHOLDER: multisig/FeeSplitter on mainnet
    const curve = await deploy(deployer, 'CensusCurveV4', treasury.target, wethAddr, stockRouter.target);
    const graduator = await deploy(deployer, 'CensusV4Graduator', manager.target, curve.target, treasury.target);
    const hookDeployer = await deploy(deployer, 'CensusHookDeployer');
    const HookFactory = await ethers.getContractFactory('CensusV4Hook', deployer);
    const code = (await HookFactory.getDeployTransaction(manager.target, graduator.target, treasury.target)).data;
    const { salt, address: hookAddr, iterations } = findHookSalt(hookDeployer.target, code);
    log(`hook salt mined in ${iterations} iterations -> ${hookAddr}`);
    await send('deploy', 'hookDeployer.deploy', () => hookDeployer.deploy(salt, code));
    if ((await provider.getCode(hookAddr)) === '0x') throw new Error('hook not deployed');
    await send('deploy', 'graduator.setHook', () => graduator.setHook(hookAddr));
    await send('deploy', 'curve.setGraduator', () => curve.setGraduator(graduator.target));
    const router = await deploy(deployer, 'CensusV4Router', manager.target, hookAddr);
    const vaultDeployer = await deploy(deployer, 'CensusRewardVaultDeployer');
    const factory = await deploy(deployer, 'LaunchFactoryV4', wethAddr, curve.target, stockRouter.target, 3000, ethers.ZeroAddress, router.target, vaultDeployer.target);
    await send('deploy', 'vaultDeployer.setLaunchFactory', () => vaultDeployer.setLaunchFactory(factory.target));
    await send('deploy', 'curve.setFactory', () => curve.setFactory(factory.target, true));
    await send('deploy', 'curve.setKeeper', () => curve.setKeeper(deployer.address)); // PLACEHOLDER keeper
    for (const s of stocks) await send('deploy', `curve.setRewardAssetAllowed ${s}`, () => curve.setRewardAssetAllowed(s, true));
    state.phases.deploy = { stockRouter: stockRouter.target, stocks, manager: manager.target, treasury: treasury.target, curve: curve.target, graduator: graduator.target, hookDeployer: hookDeployer.target, hook: hookAddr, hookSalt: salt, router: router.target, vaultDeployer: vaultDeployer.target, factory: factory.target, weth: wethAddr };
    state.timings.deploy = Date.now() - p; save();
    fs.writeFileSync(path.join(__dirname, '..', `deployments.v4.${network.name}.json`), JSON.stringify({ network: network.name, chainId: 46630, product: 'v4', stress: true, deployedAt: new Date().toISOString(), PoolManager: manager.target, PoolManagerOfficial: false, Treasury: treasury.target, TreasuryKind: 'FeeVault (placeholder)', WETH: wethAddr, StockRouter: stockRouter.target, CensusCurveV4: curve.target, CensusV4Graduator: graduator.target, CensusHookDeployer: hookDeployer.target, CensusV4Hook: hookAddr, hookSalt: salt, CensusV4Router: router.target, CensusRewardVaultDeployer: vaultDeployer.target, LaunchFactoryV4: factory.target, rewardAssets: stocks, keeper: deployer.address }, null, 2));
    log(`deployed in ${state.timings.deploy} ms`);
  }
  const D = state.phases.deploy;
  const curve = await ethers.getContractAt('CensusCurveV4', D.curve, deployer);
  const factory = await ethers.getContractAt('LaunchFactoryV4', D.factory, deployer);
  const hook = await ethers.getContractAt('CensusV4Hook', D.hook, deployer);
  const router = await ethers.getContractAt('CensusV4Router', D.router, deployer);
  const graduator = await ethers.getContractAt('CensusV4Graduator', D.graduator, deployer);
  const stockRouter = await ethers.getContractAt('MockSwapRouter', D.stockRouter, deployer);

  // ---- 2. wallets -----------------------------------------------------------------------------
  if (!state.phases.wallets) {
    const p = Date.now();
    const wallets = [];
    for (let i = 0; i < N_WALLETS; i++) wallets.push(ethers.Wallet.createRandom().privateKey);
    for (const [i, k] of wallets.entries()) {
      const w = new ethers.Wallet(k, provider);
      await send('wallets', `fund wallet ${i}`, () => deployer.sendTransaction({ to: w.address, value: WALLET_FUND }));
    }
    state.phases.wallets = { keys: wallets };
    state.timings.wallets = Date.now() - p; save();
    log(`funded ${N_WALLETS} wallets with ${ethers.formatEther(WALLET_FUND)} ETH each`);
  }
  const wallets = state.phases.wallets.keys.map((k) => new ethers.Wallet(k, provider));
  const wethOf = (w) => weth.connect(w), curveOf = (w) => curve.connect(w), routerOf = (w) => router.connect(w);
  const TOPUP_AT = E(process.env.STRESS_TOPUP_AT_ETH || '0.00006'), TOPUP = E(process.env.STRESS_TOPUP_ETH || '0.00012'), DEPLOYER_RESERVE = E(process.env.STRESS_DEPLOYER_RESERVE_ETH || '0.003');
  let topupQueue = Promise.resolve();
  const topUp = (w, label) => (topupQueue = topupQueue.then(async () => {
    if ((await provider.getBalance(w.address)) >= TOPUP_AT) return;
    if ((await provider.getBalance(deployer.address)) < DEPLOYER_RESERVE + TOPUP) { log(`no top-up for ${label}: deployer reserve reached`); return; }
    await send('topup', `top up ${label}`, () => deployer.sendTransaction({ to: w.address, value: TOPUP }));
  }));

  // Each wallet: wrap a little WETH for ERC20 buys + approvals (one time).
  if (!state.phases.approvals) {
    const p = Date.now();
    await Promise.all(wallets.map(async (w, i) => {
      await send('approvals', `wrap ${i}`, () => wethOf(w).deposit({ value: WALLET_FUND / 3n }));
      await send('approvals', `approve curve ${i}`, () => wethOf(w).approve(D.curve, ethers.MaxUint256));
      await send('approvals', `approve router ${i}`, () => wethOf(w).approve(D.router, ethers.MaxUint256));
    }));
    state.phases.approvals = true; state.timings.approvals = Date.now() - p; save();
  }

  // ---- 3+4. launch + window ---------------------------------------------------------------------
  if (!state.phases.launch) {
    const p = Date.now();
    const specs = [
      { reflection: 0, basket: [], weights: [] },
      { reflection: 100, basket: [D.weth], weights: [10000] },
      { reflection: 300, basket: [D.weth, D.stocks[0]], weights: [5000, 5000] },
      { reflection: 400, basket: [D.stocks[0], D.stocks[1], D.stocks[2]], weights: [3000, 3000, 4000] },
    ].slice(0, K_COINS);
    const coins = [];
    for (const [i, s] of specs.entries()) {
      const creator = wallets[i % wallets.length];
      const rc = await send('launch', `createLaunch ${i}`, () => factory.connect(creator)[SIG]([`Stress ${i}`, `ST${i}`, E('1000000000'), 18, VIRTUAL, GRADUATION], s.basket, s.weights, s.basket.map(() => '0x'), ethers.ZeroHash, D.weth, s.reflection, []));
      if (rc.reverted) { recordError('launch', `createLaunch ${i}`, rc.error); continue; }
      const e = ev(rc, factory.interface, 'LaunchedV4')[0].args;
      const launchedAt = Number(await curve.launchedAt(e.token));
      // Window: fire a buy from a non-exempt wallet right away; record the elapsed seconds it landed at.
      const sniper = wallets[(i + 1) % wallets.length];
      const buyRc = await send('window', `window buy coin ${i}`, () => curveOf(sniper).buy(e.token, TRADE_UNIT * 5n, 0));
      let window = null;
      if (!buyRc.reverted) {
        const blk = await provider.getBlock(buyRc.blockNumber);
        const elapsed = blk.timestamp - launchedAt;
        const al = ev(buyRc, curve.interface, 'FeeAllocated')[0].args;
        const f = fees(TRADE_UNIT * 5n, BigInt(s.reflection), elapsed, true, false);
        const ok = al.protocolFee === f.protocol && al.creatorFee === f.creator && al.holderFee === f.holders && al.penalty === f.penalty;
        window = { elapsed, totalBps: rates(BigInt(s.reflection), elapsed, true).total.toString(), penalty: ethers.formatEther(al.penalty), formulaMatch: ok };
        if (!ok) recordError('window', `coin ${i}`, new Error('fee mismatch vs formula'));
      }
      coins.push({ token: e.token, vault: e.vault, creator: creator.address, reflection: s.reflection, basket: s.basket, weights: s.weights, launchedAt, window });
      log(`launched coin ${i} ${e.token} reflection ${s.reflection} vault ${e.vault} window=${JSON.stringify(window)}`);
    }
    state.phases.launch = { coins }; state.timings.launch = Date.now() - p; save();
  }
  const coins = state.phases.launch.coins;
  const tokenOf = (c, w) => new ethers.Contract(c.token, ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function totalSupply() view returns (uint256)', 'function transfer(address,uint256) returns (bool)'], w);

  // ---- 5. trades ------------------------------------------------------------------------------
  if (!state.phases.trades) {
    const p = Date.now();
    // approvals of every coin to curve + router per wallet
    await Promise.all(wallets.map(async (w, i) => { for (const c of coins) { await send('trades', `approve coin->curve w${i}`, () => tokenOf(c, w).approve(D.curve, ethers.MaxUint256)); await send('trades', `approve coin->router w${i}`, () => tokenOf(c, w).approve(D.router, ethers.MaxUint256)); } }));
    const stats = { sent: 0, ok: 0, reverted: 0, feeMismatch: 0, buys: 0, sells: 0, gasMax: 0n, gasTotal: 0n, byCoin: coins.map(() => ({ buys: 0, sells: 0, feeTotal: 0n })) };
    const perRound = wallets.length;
    let i = 0;
    while (i < TRADES) {
      const batch = [];
      for (let j = 0; j < perRound && i < TRADES; j++, i++) {
        const idx = i, w = wallets[j], ci = idx % coins.length, c = coins[ci];
        batch.push((async () => {
          await topUp(w, `w${j}`);
          const held = await tokenOf(c, w).balanceOf(w.address);
          const cv = await curve.curves(c.token);
          if (cv.graduated || cv.realQuote >= cv.graduationQuote) return; // filled: leave for the graduation phase
          const sell = held > 0n && idx % 3 === 2;
          const amount = TRADE_UNIT * BigInt(1 + (idx % 5));
          if (!sell && (await weth.balanceOf(w.address)) < amount) {
            const eth = await provider.getBalance(w.address);
            if (eth > amount + FILL_BUFFER / 10n) await send('trades', `wrap more w${j}`, () => wethOf(w).deposit({ value: amount * 5n }));
            else return;
          }
          const rc = sell
            ? await send('trades', `sell c${ci} w${j}`, () => curveOf(w).sell(c.token, held / 2n, 0), { retries: 2 })
            : await send('trades', `buy c${ci} w${j}`, () => curveOf(w).buy(c.token, amount, 0), { retries: 2 });
          stats.sent++;
          if (rc.reverted) { stats.reverted++; recordError('trades', `${sell ? 'sell' : 'buy'} c${ci} w${j}`, rc.error); return; }
          stats.ok++; sell ? stats.sells++ : stats.buys++; sell ? stats.byCoin[ci].sells++ : stats.byCoin[ci].buys++;
          stats.gasTotal += rc.gasUsed; if (rc.gasUsed > stats.gasMax) stats.gasMax = rc.gasUsed;
          const t = ev(rc, curve.interface, 'Traded')[0].args, al = ev(rc, curve.interface, 'FeeAllocated')[0].args;
          const gross = sell ? t.amountOut + t.fee : t.amountIn;
          const blk = await provider.getBlock(rc.blockNumber);
          const f = fees(gross, BigInt(c.reflection), blk.timestamp - c.launchedAt, !sell, false);
          const match = t.fee === f.total && al.protocolFee === f.protocol && al.creatorFee === f.creator && al.holderFee === f.holders;
          if (!match) { stats.feeMismatch++; recordError('trades', `fee mismatch c${ci} tx ${rc.hash}`, new Error(`fee ${t.fee} expected ${f.total}`)); }
          stats.byCoin[ci].feeTotal += t.fee;
        })());
      }
      await Promise.all(batch);
      if (i % 100 === 0) { log(`trades ${i}/${TRADES} ok=${stats.ok} reverted=${stats.reverted} mismatch=${stats.feeMismatch}`); save(); }
    }
    state.phases.trades = stats; state.timings.trades = Date.now() - p; save();
    log(`trades done: ${JSON.stringify(stats, (_, v) => typeof v === 'bigint' ? v.toString() : v)} in ${state.timings.trades} ms`);
  }

  // ---- 6. graduate ----------------------------------------------------------------------------
  if (!state.phases.graduate) {
    const p = Date.now();
    const results = [];
    for (const [ci, c] of coins.entries()) {
      const w = deployer; // the capped final fill needs more ETH than a trader wallet carries
      const maximum = await curve.maxQuoteInFor(c.token, w.address);
      const fill = await send('graduate', `final fill c${ci}`, () => curveOf(w).buyWithETH(c.token, 0, { value: maximum + FILL_BUFFER }));
      const refund = fill.reverted ? null : ev(fill, curve.interface, 'BuyRefunded')[0]?.args?.amount;
      const cv = await curve.curves(c.token);
      // Graduation is automatic inside the filling buy; the permissionless call is only the retry path.
      let grad = fill;
      if (fill.reverted || !ev(fill, curve.interface, 'Graduated')[0]) grad = await send('graduate', `graduate (retry) c${ci}`, () => curveOf(wallets[(ci + 3) % wallets.length]).graduate(c.token));
      const g = grad.reverted ? null : (ev(grad, curve.interface, 'Graduated')[0]?.args ?? null);
      const managerBal = await tokenOf(c, deployer).balanceOf(D.manager);
      results.push({ coin: c.token, accepted: ethers.formatEther(maximum), refund: refund == null ? null : ethers.formatEther(refund), realQuoteAtCap: ethers.formatEther(cv.realQuote), poolId: g?.poolId ?? null, tokensIn: g ? ethers.formatEther(g.tokensIn) : null, quoteIn: g ? ethers.formatEther(g.quoteIn) : null, liquidity: g?.liquidity?.toString() ?? null, managerHolds: ethers.formatEther(managerBal), dust: ethers.formatEther(await curve.migrationTokenDust(c.token)) });
      if (grad.reverted) recordError('graduate', `c${ci}`, grad.error);
      log(`graduated c${ci}: ${JSON.stringify(results[results.length - 1])}`);
    }
    state.phases.graduate = { results }; state.timings.graduate = Date.now() - p; save();
  }

  // ---- 7. pool ---------------------------------------------------------------------------------
  if (!state.phases.pool) {
    const p = Date.now();
    const stats = { sent: 0, ok: 0, reverted: 0, feeMismatch: 0, gasMax: 0n };
    const keyFor = (c) => { const coin0 = BigInt(c.token) < BigInt(D.weth); return { coin0, key: { currency0: coin0 ? c.token : D.weth, currency1: coin0 ? D.weth : c.token, fee: 0, tickSpacing: 60, hooks: D.hook } }; };
    let i = 0;
    while (i < POOL_TRADES) {
      const chainNow = (await provider.getBlock('latest')).timestamp; // chain time, not wall clock (local chains drift)
      const batch = [];
      for (let j = 0; j < wallets.length && i < POOL_TRADES; j++, i++) {
        const idx = i, w = wallets[j], ci = idx % coins.length, c = coins[ci];
        batch.push((async () => {
          await topUp(w, `w${j}`);
          const { coin0, key } = keyFor(c);
          const held = await tokenOf(c, w).balanceOf(w.address);
          const sell = held > 0n && idx % 2 === 1;
          const req = sell
            ? { key, zeroForOne: coin0, amountIn: held / 2n, minOut: 1n, sqrtPriceLimitX96: coin0 ? MIN : MAX, recipient: w.address, deadline: chainNow + 600 }
            : { key, zeroForOne: !coin0, amountIn: POOL_UNIT * BigInt(1 + (idx % 4)), minOut: 1n, sqrtPriceLimitX96: coin0 ? MAX : MIN, recipient: w.address, deadline: chainNow + 600 };
          if (!sell) {
            const have = await weth.balanceOf(w.address);
            if (have < req.amountIn) {
              const eth = await provider.getBalance(w.address);
              if (eth > req.amountIn + FILL_BUFFER / 10n) await send('pool', `wrap more w${j}`, () => wethOf(w).deposit({ value: req.amountIn }));
              else return; // wallet exhausted: skip rather than record a funding revert as a contract failure
            }
          }
          let gas; try { gas = (await routerOf(w).swapExactInput.estimateGas(req)) * 13n / 10n; } catch { gas = undefined; }
          const rc = await send('pool', `${sell ? 'sell' : 'buy'} c${ci} w${j}`, () => routerOf(w).swapExactInput(req, gas ? { gasLimit: gas } : {}), { retries: 2 });
          stats.sent++;
          if (rc.reverted) {
            stats.reverted++; recordError('pool', `${sell ? 'sell' : 'buy'} c${ci} w${j}`, rc.error);
            const diag = { weth: ethers.formatEther(await weth.balanceOf(w.address)), eth: ethers.formatEther(await provider.getBalance(w.address)), coin: ethers.formatEther(held), amountIn: ethers.formatEther(req.amountIn), zeroForOne: req.zeroForOne };
            try { await routerOf(w).swapExactInput.staticCall(req); diag.static = 'ok'; } catch (e) { diag.static = String(e?.data || e?.shortMessage || e?.message).slice(0, 400); }
            log(`pool revert diag c${ci} w${j}: ${JSON.stringify(diag)}`);
            return;
          }
          stats.ok++; if (rc.gasUsed > stats.gasMax) stats.gasMax = rc.gasUsed;
          const acc = ev(rc, hook.interface, 'FeeAccrued')[0].args;
          const f = fees(acc.quoteVolume, BigInt(c.reflection), 100, false, true);
          if (acc.protocolFee !== f.protocol || acc.creatorFee !== f.creator || acc.holderFee !== f.holders) { stats.feeMismatch++; recordError('pool', `fee mismatch ${rc.hash}`, new Error('hook fee mismatch')); }
        })());
      }
      await Promise.all(batch);
      if (i % 40 === 0) { log(`pool trades ${i}/${POOL_TRADES} ok=${stats.ok} reverted=${stats.reverted}`); save(); }
    }
    state.phases.pool = stats; state.timings.pool = Date.now() - p; save();
    log(`pool trades done: ${JSON.stringify(stats, (_, v) => typeof v === 'bigint' ? v.toString() : v)}`);
  }

  // ---- 8. rewards ------------------------------------------------------------------------------
  if (!state.phases.rewards) {
    const p = Date.now();
    const out = [];
    for (const [ci, c] of coins.entries()) {
      const r = { coin: c.token, vault: c.vault, claims: {}, distributed: null, holdersPaid: 0, insolvent: false };
      for (const [label, who] of [['vault', c.vault], ['creator', c.creator], ['treasury', D.treasury]]) {
        if (who === ethers.ZeroAddress) continue;
        const owed = await hook.claimable(D.weth, who);
        if (owed > 0n) { const rc = await send('rewards', `hook.claimFor ${label} c${ci}`, () => hook.claimFor(D.weth, who)); r.claims[label] = rc.reverted ? `REVERT ${rc.error}` : ethers.formatEther(owed); }
      }
      if (c.vault !== ethers.ZeroAddress) {
        const vault = await ethers.getContractAt('CensusRewardVault', c.vault, deployer);
        const available = await vault.availableQuote();
        const minOut = c.basket.map((b) => (b.toLowerCase() === D.weth.toLowerCase() ? 0 : 1));
        const rc = await send('rewards', `vault.distribute c${ci}`, () => vault.distribute(minOut)); // deployer == curve keeper
        r.distributed = rc.reverted ? `REVERT ${rc.error}` : ethers.formatEther(available);
        for (const w of wallets) {
          let any = false;
          for (const b of c.basket) if ((await vault.withdrawableOf(w.address, b)) > 0n) any = true;
          if (any) { const cr = await send('rewards', `vault.claimFor c${ci}`, () => vault.claimFor(w.address)); if (!cr.reverted) r.holdersPaid++; else recordError('rewards', `claimFor c${ci}`, cr.error); }
        }
        for (const b of c.basket) {
          const bal = await new ethers.Contract(b, ['function balanceOf(address) view returns (uint256)'], provider).balanceOf(c.vault);
          if (bal < await vault.reserved(b)) r.insolvent = true;
        }
        if ((await tokenOf(c, deployer).balanceOf(c.vault)) !== 0n) recordError('rewards', `vault holds coin c${ci}`, new Error('vault holds launch token'));
      }
      out.push(r); log(`rewards c${ci}: ${JSON.stringify(r)}`);
    }
    state.phases.rewards = { out }; state.timings.rewards = Date.now() - p; save();
  }

  // ---- 9. verify -------------------------------------------------------------------------------
  const checks = [];
  const hookBal = await weth.balanceOf(D.hook), reserved = await hook.totalReserved(D.weth);
  checks.push({ check: 'hook custody == reserved liabilities', ok: hookBal === reserved, detail: `${ethers.formatEther(hookBal)} vs ${ethers.formatEther(reserved)}` });
  for (const [ci, c] of coins.entries()) {
    const t = tokenOf(c, deployer);
    const supply = await t.totalSupply();
    let sum = 0n;
    for (const a of new Set([...wallets.map((w) => w.address), deployer.address, D.manager, D.curve, D.hook, D.router, D.graduator, D.treasury, c.creator, ...(c.vault !== ethers.ZeroAddress ? [c.vault] : [])])) sum += await t.balanceOf(a);
    checks.push({ check: `coin ${ci} supply accounted`, ok: sum === supply, detail: `${ethers.formatEther(sum)} / ${ethers.formatEther(supply)}` });
    checks.push({ check: `coin ${ci} graduator holds nothing`, ok: (await t.balanceOf(D.graduator)) === 0n });
    const cv = await curve.curves(c.token);
    checks.push({ check: `coin ${ci} graduated`, ok: cv.graduated });
    checks.push({ check: `coin ${ci} curve holds only dust`, ok: (await t.balanceOf(D.curve)) === (await curve.migrationTokenDust(c.token)) });
  }
  const failed = checks.filter((c) => !c.ok);
  state.phases.verify = { checks }; state.timings.total = Date.now() - t0; save();

  // ---- report ----------------------------------------------------------------------------------
  const report = { network: network.name, chainId: 46630, deployer: deployer.address, deployments: D, timings: state.timings, txCount: state.txs.length, gas: { total: state.txs.reduce((a, t) => a + BigInt(t.gasUsed), 0n).toString() }, launch: coins, trades: state.phases.trades, graduate: state.phases.graduate, pool: state.phases.pool, rewards: state.phases.rewards, checks, errors: state.errors };
  fs.writeFileSync(REPORT_BASE + '.json', JSON.stringify(report, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  const md = [`# Testnet stress test — ${network.name} (chainId 46630)`, '', `Deployer ${deployer.address}. ${state.txs.length} transactions, total gas ${report.gas.total}. Errors: ${state.errors.length}. Failed checks: ${failed.length}.`, '',
    '## Deployment (placeholders: FeeVault treasury, deployer as keeper, PoolManager copy)', '', ...Object.entries(D).filter(([k]) => k !== 'stocks').map(([k, v]) => `- ${k}: \`${v}\``), `- stocks: ${D.stocks.map((s) => `\`${s}\``).join(', ')}`, '',
    '## Launches and launch-window buys', '', '| coin | reflection | basket | window buy elapsed s | total bps charged | penalty | formula match |', '|---|---|---|---|---|---|---|',
    ...coins.map((c, i) => `| ${i} \`${c.token}\` | ${c.reflection} | ${c.basket.length} assets | ${c.window?.elapsed ?? '-'} | ${c.window?.totalBps ?? '-'} | ${c.window?.penalty ?? '-'} | ${c.window?.formulaMatch ?? '-'} |`), '',
    '## Curve trades', '', '```', JSON.stringify(state.phases.trades, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2), '```', '',
    '## Graduations', '', '```', JSON.stringify(state.phases.graduate, null, 2), '```', '',
    '## Pool trades (hook)', '', '```', JSON.stringify(state.phases.pool, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2), '```', '',
    '## Rewards', '', '```', JSON.stringify(state.phases.rewards, null, 2), '```', '',
    '## Invariant checks', '', '| check | ok | detail |', '|---|---|---|', ...checks.map((c) => `| ${c.check} | ${c.ok ? 'PASS' : 'FAIL'} | ${c.detail ?? ''} |`), '',
    '## Errors', '', ...(state.errors.length ? state.errors.map((e) => `- ${e.phase}/${e.label}: ${e.error}`) : ['none']), '',
    `Timings (ms): ${JSON.stringify(state.timings)}`, ''].join('\n');
  fs.writeFileSync(REPORT_BASE + '.md', md);
  log(`report written: ${REPORT_BASE}.md; failed checks ${failed.length}; errors ${state.errors.length}`);
  if (failed.length) process.exitCode = 1;
}
main().catch((e) => { recordError('fatal', 'main', e); save(); console.error(e); process.exitCode = 1; });
