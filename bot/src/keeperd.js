// Production keeper daemon for Census v2 launches.
//
// One process, one signer, one transaction in flight at a time. Every cycle it:
//   1. DISCOVERS launches (factory LaunchedV2) and graduations (curve Graduated) from chain logs,
//      resuming from a durable cursor;
//   2. COLLECTS accrued LP fees from the locker for graduated positions (permissionless call);
//   3. CONVERTS vault-held launch-token fees into the quote asset (operator/keeper-only, quoter-priced
//      minimum output at SLIPPAGE_BPS);
//   4. DISTRIBUTES each vault's unallocated quote into its stock basket (0x when the whole basket
//      is quotable, else Uniswap with quoter minimums — same planners as src/keeper0x.js);
//   5. PUSHES earned dividends to holders via DividendVault.claimFor (the team decision that
//      rewards are delivered automatically), tracking holder balances from token Transfer logs,
//      bounded per cycle and resumed round-robin.
//
// Authority: steps 3-4 need the signer to be the vault's `operator()` OR the platform keeper
// registered on the curve (`CensusCurve.keeper()`, accepted by every vault). Vaults the signer is
// not authorized for are skipped for those steps (logged once); collection and pushes are
// permissionless and always run.
//
// Durability and safety:
//   - All progress lives in a JSON state file written atomically (tmp+rename): discovery cursors,
//     per-launch records, holder balances, the in-flight transaction, and run/alert counters. A
//     corrupt state file is a hard error (never silently reset: that would reuse a live nonce). A
//     lock file keeps two daemons off one state file.
//   - A transaction is recorded (kind, nonce, to, data, fees) BEFORE broadcast. On restart the
//     pending record is resolved first: mined -> done; broadcast never happened (no hash, nonce
//     unconsumed) -> cleared; superseded nonce -> cleared with a warning; stuck past
//     REPLACE_AFTER_MS -> replaced with a fee bump at the SAME nonce (bounded by MAX_FEE_GWEI),
//     keeping every replaced hash so a mined original is still recognised; still waiting -> nothing
//     new is sent.
//   - Log scans filter by topic and shrink the block range on RPC failures instead of stalling.
//   - The signer refuses to go live when its gas balance is under MIN_SIGNER_WEI (alert instead);
//     per-cycle actions are bounded by MAX_ACTIONS_PER_CYCLE and shared fairly across launches.
//   - DRY_RUN defaults to TRUE: full planning, no signatures (including no replacements).
//   - Every failure raises a webhook alert (deduplicated per key for ALERT_REPEAT_MS) and never
//     advances a cursor past unread logs.
//
// Run:  node src/keeperd.js            (dry run, single cycle: CYCLES=1)
//       DRY_RUN=false CYCLES=0 node src/keeperd.js   (live daemon; 0 = run forever)
"use strict";
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { planZeroEx, planUniswap, VAULT_ABI, QUOTER_ABI, applySlippage } = require("./keeper0x.js");

// ---------------------------------------------------------------------------
// interfaces
// ---------------------------------------------------------------------------
const FACTORY_IFACE = new ethers.Interface([
  "event LaunchedV2(address indexed token, address indexed creator, address curve, address vault, uint16 holdersBps)",
]);
const CURVE_IFACE = new ethers.Interface([
  "event Graduated(address indexed coin, address pool, uint256 tokenId, uint256 tokensIn, uint256 quoteIn)",
]);
const TOKEN_IFACE = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const LAUNCH_TOPIC = FACTORY_IFACE.getEvent("LaunchedV2").topicHash;
const GRAD_TOPIC = CURVE_IFACE.getEvent("Graduated").topicHash;
const TRANSFER_TOPIC = TOKEN_IFACE.getEvent("Transfer").topicHash;
const LOCKER_ABI = [
  "function collectFees(uint256 tokenId) returns (uint256 amount0, uint256 amount1)",
];
const VAULT_EXTRA_ABI = [
  "function token() view returns (address)",
  "function operator() view returns (address)",
  "function excluded(address) view returns (bool)",
  "function withdrawableOf(address holder, address stock) view returns (uint256)",
  "function convertLaunchFees(uint256 amountIn, uint24 poolFee, uint256 minQuoteOut) returns (uint256)",
  "function claimFor(address holder)",
];
const CURVE_VIEW_ABI = [
  "function curves(address) view returns (address quote,address creator,address vault,uint16 holdersBps,uint24 poolFee,uint256 virtualQuote,uint256 tokenReserve,uint256 realQuote,uint256 graduationQuote,bool graduated,bool exists)",
  "function keeper() view returns (address)",
  "function locker() view returns (address)",
];
const ERC20_VIEW_ABI = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------
function loadConfig(env = process.env) {
  const num = (k, d) => Number(env[k] ?? d);
  const big = (k, d) => BigInt(env[k] ?? d);
  const cfg = {
    rpcUrl: env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
    chainId: num("CHAIN_ID", 4663),
    dryRun: env.DRY_RUN !== "false",
    privateKey: env.PRIVATE_KEY,
    factory: env.FACTORY_V2_ADDRESS,
    curve: env.CURVE_ADDRESS,
    locker: env.LOCKER_ADDRESS,
    quoter: env.QUOTER_ADDRESS || null,
    startBlock: big("KEEPER_START_BLOCK", "0"),
    logChunk: big("KEEPER_LOG_CHUNK", "5000"),
    stateFile: env.KEEPER_STATE_FILE || path.join(process.cwd(), "keeperd.state.json"),
    intervalMs: num("KEEPER_INTERVAL_MS", 60_000),
    // Dry runs default to a single cycle (inspect the plan and exit); live defaults to forever.
    cycles: env.CYCLES !== undefined ? Number(env.CYCLES) : env.DRY_RUN !== "false" ? 1 : 0,
    slippageBps: num("SLIPPAGE_BPS", 100),
    collectMinWei: big("COLLECT_MIN_WEI", "1000000000000000"), // 0.001 quote units
    convertMinTokens: big("CONVERT_MIN_TOKENS", "1000000000000000000"), // 1 token
    distributeMinWei: big("DISTRIBUTE_MIN_WEI", "10000000000000000"), // 0.01 quote
    pushMinWei: big("PUSH_MIN_WEI", "1000000000000"), // per-holder minimum worth pushing
    pushMaxPerCycle: num("PUSH_MAX_PER_CYCLE", 25),
    maxActionsPerCycle: num("MAX_ACTIONS_PER_CYCLE", 10),
    minSignerWei: big("MIN_SIGNER_WEI", "50000000000000000"), // 0.05 native for gas
    maxFeeGwei: num("MAX_FEE_GWEI", 50),
    replaceAfterMs: num("REPLACE_AFTER_MS", 180_000),
    txWaitMs: num("TX_WAIT_MS", 90_000),
    alertWebhook: env.ALERT_WEBHOOK_URL || null,
    alertRepeatMs: num("ALERT_REPEAT_MS", 3_600_000), // identical alert keys are re-sent at most this often
  };
  if (!Number.isInteger(cfg.slippageBps) || cfg.slippageBps < 0 || cfg.slippageBps >= 10000) throw new Error("SLIPPAGE_BPS must be 0..9999");
  if (cfg.logChunk <= 0n) throw new Error("KEEPER_LOG_CHUNK must be positive");
  return cfg;
}

// ---------------------------------------------------------------------------
// durable state (atomic JSON file) + single-instance lock
// ---------------------------------------------------------------------------
const freshState = () => ({ cursor: null, launches: {}, pending: null, pushOffset: {}, counters: { cycles: 0, sent: 0, alerts: 0 }, alertsSeen: {} });
function loadState(file) {
  if (!fs.existsSync(file)) return freshState();
  // A corrupt state file must stop the daemon: silently starting fresh would drop the in-flight
  // record (nonce reuse against a live transaction) and reset the discovery cursor.
  const raw = fs.readFileSync(file, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw, (_, v) => (typeof v === "string" && /^bigint:\d+$/.test(v) ? BigInt(v.slice(7)) : v));
  } catch (e) {
    throw new Error(`keeper state file ${file} is corrupt (${e.message}); restore it from backup before starting`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`keeper state file ${file} has an unexpected shape; refusing to start`);
  return { ...freshState(), ...parsed, counters: { ...freshState().counters, ...(parsed.counters ?? {}) } };
}
function saveState(file, state) {
  const body = JSON.stringify(state, (_, v) => (typeof v === "bigint" ? `bigint:${v}` : v), 2);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } }
/// Exclusive lock next to the state file; a stale lock (dead pid) is reclaimed.
function acquireLock(stateFile) {
  const lock = `${stateFile}.lock`;
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const other = Number(fs.readFileSync(lock, "utf8"));
    if (Number.isInteger(other) && other !== process.pid && pidAlive(other)) throw new Error(`another keeperd (pid ${other}) holds ${lock}`);
    fs.writeFileSync(lock, String(process.pid));
  }
  const release = () => { try { if (Number(fs.readFileSync(lock, "utf8")) === process.pid) fs.unlinkSync(lock); } catch { /* gone */ } };
  return release;
}

// ---------------------------------------------------------------------------
// keeper
// ---------------------------------------------------------------------------
function makeKeeper({ cfg, chain, log = console.log, alert = null }) {
  const state = loadState(cfg.stateFile);
  const persist = () => saveState(cfg.stateFile, state);
  const cap = BigInt(cfg.maxFeeGwei) * 10n ** 9n;
  const signer = chain.address ? chain.address.toLowerCase() : null;

  // Alerts are deduplicated per key so a persistent condition does not storm the webhook.
  const raise = async (level, message, detail, key = message) => {
    const now = Date.now();
    const last = state.alertsSeen[key] ?? 0;
    const repeat = now - last < cfg.alertRepeatMs;
    if (!repeat) { state.alertsSeen[key] = now; state.counters.alerts++; }
    log(`[alert:${level}]${repeat ? " (repeat, suppressed)" : ""} ${message}`, detail ?? "");
    persist();
    if (alert && !repeat) { try { await alert({ level, message, detail }); } catch { log("[alert] webhook delivery failed"); } }
  };

  // Log scans shrink their range on RPC failure (result caps, timeouts) instead of retrying the
  // same failing chunk forever; the range grows back after successes.
  const minChunk = cfg.logChunk / 16n > 0n ? cfg.logChunk / 16n : 1n;
  let chunk = cfg.logChunk;
  async function scanLogs(filter, from, head, onLogs) {
    while (from <= head) {
      const to = from + chunk - 1n > head ? head : from + chunk - 1n;
      let logs;
      try {
        logs = await chain.getLogs({ ...filter, fromBlock: from, toBlock: to });
      } catch (e) {
        if (chunk > minChunk && to > from) {
          chunk = chunk / 2n < minChunk ? minChunk : chunk / 2n;
          log(`[scan] getLogs ${from}-${to} failed (${e.message}); retrying with chunk ${chunk}`);
          continue;
        }
        await raise("error", "log scan failed at the minimum chunk size", { from: from.toString(), to: to.toString(), message: e.message }, "scan-failed");
        throw e;
      }
      await onLogs(logs, to);
      if (chunk < cfg.logChunk) chunk = chunk * 2n > cfg.logChunk ? cfg.logChunk : chunk * 2n;
      from = to + 1n;
    }
  }

  // ---- managed transactions: at most one in flight, recorded before broadcast ----
  const bump = (v, floor) => { const b = (BigInt(v) * 125n) / 100n + 1n; const f = floor === undefined ? b : (b > BigInt(floor) ? b : BigInt(floor)); return f > cap ? cap : f; };

  async function resolvePending() {
    const p = state.pending;
    if (!p) return true;
    // Every hash this record ever had (original + replacements) resolves it when mined.
    for (const h of [p.hash, ...(p.replaced ?? [])].filter(Boolean)) {
      const receipt = await chain.receipt(h);
      if (receipt) {
        log(`[tx] ${p.kind} ${h} mined in block ${receipt.blockNumber} status=${receipt.status}${h !== p.hash ? " (a replaced hash)" : ""}`);
        if (receipt.status !== 1) await raise("error", `${p.kind} transaction reverted`, { hash: h });
        state.pending = null;
        persist();
        return true;
      }
    }
    const accountNonce = await chain.nonce();
    if (accountNonce > p.nonce) {
      // Someone/something else consumed the nonce (manual intervention or an unindexed mine).
      await raise("warn", `${p.kind} nonce ${p.nonce} superseded; clearing pending record`, { hash: p.hash }, `superseded:${p.nonce}`);
      state.pending = null;
      persist();
      return true;
    }
    if (!p.hash) {
      // Intent was recorded but the broadcast threw (fee below base, RPC error, crash between the
      // two persists): the nonce is unconsumed, so nothing is in flight. Clear and carry on.
      await raise("warn", `${p.kind} was never broadcast at nonce ${p.nonce}; clearing pending record`, { to: p.to }, `unbroadcast:${p.nonce}`);
      state.pending = null;
      persist();
      return true;
    }
    if (Date.now() - p.sentAt >= cfg.replaceAfterMs) {
      if (cfg.dryRun) { log(`[dry] ${p.kind} stuck at nonce ${p.nonce}; a live run would replace it`); return false; }
      const fees = await chain.feeData();
      const base = fees.maxFeePerGas ?? 0n;
      const maxFeePerGas = bump(p.maxFeePerGas, base);
      // Replacement rules require BOTH fee fields to rise; re-supplying the tip avoids "underpriced".
      const maxPriorityFeePerGas = bump(p.maxPriorityFeePerGas ?? 0n, fees.maxPriorityFeePerGas ?? 0n);
      if (maxFeePerGas <= BigInt(p.maxFeePerGas)) {
        await raise("error", `${p.kind} stuck at nonce ${p.nonce} and MAX_FEE_GWEI reached; manual action needed`, { hash: p.hash }, `stuck:${p.nonce}`);
        return false;
      }
      const hash = await chain.send({ to: p.to, data: p.data, nonce: p.nonce, maxFeePerGas, maxPriorityFeePerGas, gasLimit: BigInt(p.gasLimit) });
      log(`[tx] ${p.kind} replaced at nonce ${p.nonce}: ${hash} (fee ${maxFeePerGas})`);
      state.pending = { ...p, hash, replaced: [...(p.replaced ?? []), p.hash], maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: maxPriorityFeePerGas.toString(), sentAt: Date.now(), replacements: (p.replacements ?? 0) + 1 };
      persist();
      return false; // still in flight
    }
    return false; // still waiting
  }

  async function sendManaged(kind, to, data) {
    if (cfg.dryRun) { log(`[dry] would send ${kind} -> ${to}`); return { dry: true }; }
    if (!(await resolvePending())) { log(`[tx] ${kind} deferred: another transaction is in flight`); return { deferred: true }; }
    const balance = await chain.balance();
    if (balance < cfg.minSignerWei) {
      await raise("error", "signer gas balance below MIN_SIGNER_WEI; refusing to send", { balance: balance.toString() }, "low-balance");
      return { blocked: true };
    }
    const fees = await chain.feeData();
    const maxFeePerGas = (fees.maxFeePerGas ?? cap) > cap ? cap : (fees.maxFeePerGas ?? cap);
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;
    const nonce = await chain.nonce();
    const gasLimit = await chain.estimateGas({ to, data });
    // Record intent BEFORE broadcast: a crash between these lines is recovered by the nonce check.
    state.pending = { kind, to, data, nonce, gasLimit: gasLimit.toString(), maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: maxPriorityFeePerGas.toString(), hash: null, replaced: [], sentAt: Date.now() };
    persist();
    let hash;
    try {
      hash = await chain.send({ to, data, nonce, maxFeePerGas, maxPriorityFeePerGas, gasLimit });
    } catch (e) {
      // Left as pending{hash:null}; the next resolvePending clears it once the nonce is confirmed unconsumed.
      await raise("error", `${kind} broadcast failed`, { nonce, message: e.message }, `broadcast:${kind}`);
      return { failed: true };
    }
    state.pending.hash = hash;
    state.counters.sent++;
    persist();
    log(`[tx] ${kind} sent: ${hash} (nonce ${nonce})`);
    const mined = await chain.waitMined(hash, cfg.txWaitMs);
    if (mined) {
      if (mined.status !== 1) await raise("error", `${kind} transaction reverted`, { hash });
      else log(`[tx] ${kind} mined in block ${mined.blockNumber}`);
      state.pending = null;
      persist();
      return { mined: mined.status === 1 };
    }
    log(`[tx] ${kind} not mined within ${cfg.txWaitMs}ms; left pending for recovery`);
    return { pending: true };
  }

  // ---- discovery ----
  async function discover() {
    const head = await chain.blockNumber();
    const from = state.cursor !== null ? BigInt(state.cursor) + 1n : cfg.startBlock;
    await scanLogs({ address: [cfg.factory, cfg.curve], topics: [[LAUNCH_TOPIC, GRAD_TOPIC]] }, from, head, async (logs, to) => {
      for (const raw of logs) {
        if (raw.topics[0] === LAUNCH_TOPIC && raw.address.toLowerCase() === cfg.factory.toLowerCase()) {
          const ev = FACTORY_IFACE.parseLog(raw);
          const token = ev.args.token.toLowerCase();
          if (!state.launches[token]) {
            const c = await chain.read(cfg.curve, CURVE_VIEW_ABI, "curves", [token]);
            state.launches[token] = {
              vault: ev.args.vault.toLowerCase(), holdersBps: Number(ev.args.holdersBps),
              quote: c.quote.toLowerCase(), poolFee: Number(c.poolFee), // pinned from the curve, never operator-chosen
              createdBlock: raw.blockNumber.toString(), graduated: false, lockerTokenId: null,
              // Holder scans start AT the launch block so same-block bundle buyers are tracked too.
              holderCursor: (BigInt(raw.blockNumber) - 1n).toString(), holders: {},
            };
            log(`[discover] launch ${token} vault ${state.launches[token].vault}`);
          }
        }
        if (raw.topics[0] === GRAD_TOPIC && raw.address.toLowerCase() === cfg.curve.toLowerCase()) {
          const ev = CURVE_IFACE.parseLog(raw);
          const token = ev.args.coin.toLowerCase();
          const launch = state.launches[token];
          if (launch) {
            launch.graduated = true;
            launch.lockerTokenId = ev.args.tokenId.toString();
            launch.pool = ev.args.pool.toLowerCase();
            log(`[discover] graduated ${token} lockerTokenId ${launch.lockerTokenId}`);
          }
        }
      }
      state.cursor = to.toString();
      persist();
    });
  }

  // ---- holder tracking from token Transfer logs (durable per-token cursor) ----
  async function refreshHolders(token, launch) {
    const head = await chain.blockNumber();
    await scanLogs({ address: [token], topics: [[TRANSFER_TOPIC]] }, BigInt(launch.holderCursor) + 1n, head, async (logs, to) => {
      for (const raw of logs) {
        if (raw.topics[0] !== TRANSFER_TOPIC) continue;
        const ev = TOKEN_IFACE.parseLog(raw);
        const [f, t, v] = [ev.args.from.toLowerCase(), ev.args.to.toLowerCase(), BigInt(ev.args.value)];
        if (f !== ethers.ZeroAddress) launch.holders[f] = ((launch.holders[f] ? BigInt(launch.holders[f]) : 0n) - v).toString();
        if (t !== ethers.ZeroAddress) launch.holders[t] = ((launch.holders[t] ? BigInt(launch.holders[t]) : 0n) + v).toString();
        if (launch.holders[f] === "0") delete launch.holders[f];
      }
      launch.holderCursor = to.toString();
      persist();
    });
  }

  // ---- authority: may this signer run the vault's conversions/distributions? ----
  async function canOperate(token, launch, keeper) {
    if (cfg.dryRun && !signer) return true; // planning only
    const operator = String(await chain.read(launch.vault, VAULT_EXTRA_ABI, "operator", [])).toLowerCase();
    const ok = signer === operator || (keeper && signer === keeper);
    if (!ok && !launch.noticedUnauthorized) {
      launch.noticedUnauthorized = true;
      log(`[auth] ${token}: signer is neither the vault operator (${operator}) nor the curve keeper; convert/distribute skipped, collect/push still run`);
    }
    if (ok) launch.noticedUnauthorized = false;
    return ok;
  }

  // ---- per-launch pipeline steps ----
  async function collectStep(token, launch, budget) {
    if (!launch.graduated || !launch.lockerTokenId || budget.used >= budget.max) return;
    const amounts = await chain.simulate(cfg.locker, LOCKER_ABI, "collectFees", [launch.lockerTokenId]);
    const worthIt = amounts[0] >= cfg.collectMinWei || amounts[1] >= cfg.collectMinWei;
    if (!worthIt) return;
    log(`[collect] ${token} fees ${amounts[0]}/${amounts[1]}`);
    const data = new ethers.Interface(LOCKER_ABI).encodeFunctionData("collectFees", [launch.lockerTokenId]);
    budget.used++;
    await sendManaged(`collectFees:${token}`, cfg.locker, data);
  }

  async function convertStep(token, launch, budget) {
    if (!launch.graduated || launch.vault === ethers.ZeroAddress || budget.used >= budget.max) return;
    const bal = await chain.read(token, ERC20_VIEW_ABI, "balanceOf", [launch.vault]);
    if (BigInt(bal) < cfg.convertMinTokens) return;
    if (!cfg.quoter) { await raise("warn", "convertLaunchFees skipped: QUOTER_ADDRESS unset (no slippage floor)", { token }, "no-quoter"); return; }
    const out = await chain.quoteSingle(cfg.quoter, token, launch.quote, BigInt(bal), launch.poolFee);
    const minOut = applySlippage(BigInt(out));
    if (minOut <= 0n) return;
    log(`[convert] ${token} selling ${bal} launch-token fees, floor ${minOut}`);
    const data = new ethers.Interface(VAULT_EXTRA_ABI).encodeFunctionData("convertLaunchFees", [BigInt(bal), launch.poolFee, minOut]);
    budget.used++;
    await sendManaged(`convertLaunchFees:${token}`, launch.vault, data);
  }

  async function distributeStep(token, launch, budget) {
    if (launch.vault === ethers.ZeroAddress || budget.used >= budget.max) return;
    const vault = chain.contract(launch.vault, VAULT_ABI);
    const bal = BigInt(await vault.availableQuote());
    if (bal < cfg.distributeMinWei) return;
    const [len, quote, swapFee, allowanceHolder] = await Promise.all([
      vault.basketLength(), vault.quote(), vault.swapFee(), vault.allowanceHolder(),
    ]);
    const basket = [], weights = [], paths = [], dec = [];
    for (let i = 0; i < Number(len); i++) {
      basket.push(await vault.basket(i));
      weights.push(Number(await vault.weights(i)));
      paths.push(await vault.paths(i));
      dec.push(18);
    }
    let plan;
    let zx = null;
    if (allowanceHolder !== ethers.ZeroAddress && process.env.ZEROX_API_KEY) {
      try { zx = await planZeroEx(vault, quote, basket, weights, dec, bal); } catch (e) { log(`[distribute] 0x planning failed: ${e.message}`); }
    }
    if (zx?.allQuotable) {
      plan = { fn: "distributeVia0x", args: [zx.sellAmounts, zx.swapData, zx.minOut] };
    } else {
      const quoter = cfg.quoter ? chain.contract(cfg.quoter, QUOTER_ABI) : null;
      if (!quoter && basket.some((s) => s.toLowerCase() !== quote.toLowerCase())) {
        await raise("warn", "distribute skipped: no 0x coverage and QUOTER_ADDRESS unset", { token }, "no-quoter-distribute");
        return;
      }
      const uni = await planUniswap(quoter, quote, Number(swapFee), basket, weights, paths, dec, bal);
      plan = { fn: "distribute", args: [uni.minOut] };
    }
    log(`[distribute] ${token} ${plan.fn} spending ${bal}`);
    const data = new ethers.Interface(VAULT_ABI).encodeFunctionData(plan.fn, plan.args);
    budget.used++;
    await sendManaged(`${plan.fn}:${token}`, launch.vault, data);
  }

  async function pushStep(token, launch, budget, pushLimit) {
    if (launch.vault === ethers.ZeroAddress || launch.holdersBps === 0) return;
    await refreshHolders(token, launch);
    const vault = chain.contract(launch.vault, [...VAULT_ABI, ...VAULT_EXTRA_ABI]);
    const basket = [];
    for (let i = 0; i < Number(await vault.basketLength()); i++) basket.push(await vault.basket(i));
    const holders = Object.keys(launch.holders).sort();
    if (holders.length === 0) return;
    const start = state.pushOffset[token] ?? 0;
    let pushed = 0;
    for (let i = 0; i < holders.length && pushed < pushLimit && budget.used < budget.max; i++) {
      const holder = holders[(start + i) % holders.length];
      state.pushOffset[token] = (start + i + 1) % holders.length;
      if (await vault.excluded(holder)) continue;
      let owed = 0n;
      for (const s of basket) owed += BigInt(await vault.withdrawableOf(holder, s));
      if (owed < cfg.pushMinWei) continue;
      log(`[push] ${token} claimFor ${holder} (owed ${owed})`);
      const data = new ethers.Interface(VAULT_EXTRA_ABI).encodeFunctionData("claimFor", [holder]);
      budget.used++;
      pushed++;
      await sendManaged(`claimFor:${token}`, launch.vault, data);
    }
    persist();
  }

  async function cycle() {
    state.counters.cycles++;
    const budget = { used: 0, max: cfg.maxActionsPerCycle };
    try {
      await resolvePending();
      await discover();
    } catch (e) {
      await raise("error", "discovery/recovery failed; pipeline skipped this cycle", { message: e.message }, "cycle-failed");
      state.lastRun = { at: Date.now(), actions: 0, dryRun: cfg.dryRun, failed: true };
      persist();
      return;
    }
    let keeper = null;
    try { keeper = String(await chain.read(cfg.curve, CURVE_VIEW_ABI, "keeper", [])).toLowerCase(); } catch { keeper = null; }
    if (keeper === ethers.ZeroAddress) keeper = null;
    const entries = Object.entries(state.launches);
    for (let i = 0; i < entries.length; i++) {
      const [token, launch] = entries[i];
      // Fair share of the remaining action budget so one launch's holder list cannot starve the rest.
      const remainingLaunches = entries.length - i;
      const pushLimit = Math.min(cfg.pushMaxPerCycle, Math.max(1, Math.floor((budget.max - budget.used) / remainingLaunches)));
      try {
        await collectStep(token, launch, budget);
        if (await canOperate(token, launch, keeper)) {
          await convertStep(token, launch, budget);
          await distributeStep(token, launch, budget);
        }
      } catch (e) {
        await raise("error", `pipeline failed for ${token}`, { message: e.message }, `pipeline:${token}`);
      }
      // Pushes are permissionless and independent of the steps above: their own failure domain.
      try {
        await pushStep(token, launch, budget, pushLimit);
      } catch (e) {
        await raise("error", `push failed for ${token}`, { message: e.message }, `push:${token}`);
      }
    }
    state.lastRun = { at: Date.now(), actions: budget.used, dryRun: cfg.dryRun };
    persist();
    log(`[cycle] done: ${budget.used} action(s)${cfg.dryRun ? " (dry run)" : ""}`);
  }

  return { cycle, state, resolvePending, sendManaged, discover, refreshHolders };
}

// ---------------------------------------------------------------------------
// real chain adapter (ethers v6)
// ---------------------------------------------------------------------------
function makeChain(cfg) {
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  const wallet = cfg.privateKey ? new ethers.Wallet(cfg.privateKey, provider) : null;
  if (!cfg.dryRun && !wallet) throw new Error("PRIVATE_KEY required when DRY_RUN=false");
  return {
    provider,
    signer: wallet,
    address: wallet ? wallet.address : null,
    chainId: async () => Number((await provider.getNetwork()).chainId),
    blockNumber: async () => BigInt(await provider.getBlockNumber()),
    getLogs: (f) => provider.getLogs({ ...f, fromBlock: Number(f.fromBlock), toBlock: Number(f.toBlock) }),
    read: (addr, abi, fn, args) => new ethers.Contract(addr, abi, provider)[fn](...args),
    simulate: (addr, abi, fn, args) => new ethers.Contract(addr, abi, wallet ?? provider)[fn].staticCall(...args),
    contract: (addr, abi) => new ethers.Contract(addr, abi, wallet ?? provider),
    quoteSingle: async (quoter, tokenIn, tokenOut, amountIn, fee) =>
      (await new ethers.Contract(quoter, QUOTER_ABI, provider).quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 }))[0],
    balance: () => provider.getBalance(wallet.address),
    nonce: () => provider.getTransactionCount(wallet.address, "latest").then(BigInt).then(Number),
    feeData: () => provider.getFeeData(),
    estimateGas: (tx) => wallet.estimateGas(tx),
    send: async (tx) => (await wallet.sendTransaction({ ...tx, chainId: cfg.chainId })).hash,
    receipt: (hash) => provider.getTransactionReceipt(hash),
    waitMined: async (hash, ms) => provider.waitForTransaction(hash, 1, ms).catch(() => null),
  };
}

async function main() {
  const cfg = loadConfig();
  for (const k of ["factory", "curve", "locker"]) if (!cfg[k]) throw new Error(`Missing ${k.toUpperCase()}${k === "factory" ? "_V2" : ""}_ADDRESS`);
  const chain = makeChain(cfg);
  if ((await chain.chainId()) !== cfg.chainId) throw new Error("RPC chain does not match CHAIN_ID");
  // The locker the curve registers positions with must be the one we collect from.
  const curveLocker = String(await chain.read(cfg.curve, CURVE_VIEW_ABI, "locker", [])).toLowerCase();
  if (curveLocker !== cfg.locker.toLowerCase()) throw new Error(`LOCKER_ADDRESS ${cfg.locker} does not match curve.locker() ${curveLocker}`);
  const release = acquireLock(cfg.stateFile);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { release(); process.exit(0); });
  process.on("exit", release);
  const alert = cfg.alertWebhook
    ? (payload) => fetch(cfg.alertWebhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "census-keeperd", at: new Date().toISOString(), ...payload }), signal: AbortSignal.timeout(10000) })
    : null;
  const keeper = makeKeeper({ cfg, chain, alert });
  console.log(`=== census keeperd === ${cfg.dryRun ? "[DRY RUN]" : "[LIVE]"} signer=${chain.address ?? "none"} state=${cfg.stateFile} interval=${cfg.intervalMs}ms`);
  let n = 0;
  for (;;) {
    try { await keeper.cycle(); } catch (e) { console.error("[cycle] fatal:", e.message); if (alert) { try { await alert({ level: "error", message: "keeper cycle crashed", detail: { message: e.message } }); } catch { /* logged */ } } }
    n++;
    if (cfg.cycles > 0 && n >= cfg.cycles) break;
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
  }
}

module.exports = { loadConfig, loadState, saveState, acquireLock, makeKeeper, makeChain };
if (require.main === module) main().catch((e) => { console.error("FATAL:", e.message || e); process.exit(1); });
