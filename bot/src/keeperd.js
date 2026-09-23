// Production keeper daemon for Census launches: legacy v2/V3 (LaunchFactoryV2 + DividendVault +
// Uniswap V3 locker) and V4 (LaunchFactoryV4 + CensusCurveV4 + CensusV4Hook + CensusRewardVault).
// Either product is enabled by its addresses; both may run in ONE process, each with its own launch
// registry and discovery cursor, sharing the signer, the managed-transaction path and the state file.
//
// One process, one signer, one transaction in flight at a time. Every cycle it:
//   1. DISCOVERS launches (factory LaunchedV2 / LaunchedV4) and graduations (curve Graduated) from
//      chain logs, resuming from a durable cursor per product;
//   2. COLLECTS accrued fees: legacy -> locker.collectFees(tokenId) for graduated positions;
//      V4 -> hook.claimFor(quote, vault) once hook.claimable(quote, vault) >= COLLECT_MIN_WEI
//      (permissionless; the same call is also pushed for the creator and the treasury);
//   3. CONVERTS (legacy only) vault-held launch-token fees into the quote asset (operator/keeper-only,
//      quoter-priced minimum output at SLIPPAGE_BPS). A V4 vault has no conversion routine: it never
//      holds or trades the launch token;
//   4. DISTRIBUTES each vault's unallocated quote into its basket (0x when every external leg is
//      quotable, else Uniswap with quoter minimums — same planners as src/keeper0x.js). A V4 basket
//      holds only the quote asset and/or allow-listed tokenised stocks (never the launch token; the
//      vault buys nothing on the curve or in the V4 pool): the quote entry is 0, every other entry
//      is priced by the planners; distributeVia0x carries swapData only for stock entries. A stale
//      vault whose basket still names the launch token is skipped with a one-time alert;
//   5. PUSHES earned rewards to holders via vault.claimFor (the team decision that rewards are
//      delivered automatically), tracking holder balances from token Transfer logs, bounded per cycle
//      and resumed round-robin. V4 launches with reflection off (vault == 0) get no vault work.
//
// Authority: steps 3-4 need the signer to be the vault's `operator()` OR the platform keeper
// registered on the curve (`CensusCurve.keeper()` / `CensusCurveV4.keeper()`). On V4 vaults
// `operator()` simply returns the curve keeper — the creator is never an operator (security checklist
// 2026-09-23, F1). Vaults the signer is not authorized for are skipped for those steps (logged once);
// collection and pushes are permissionless and always run.
//
// V4 startup wiring (verifyV4Wiring): hook.registrar() must be curve.graduator(), router.hook() must
// be HOOK_ADDRESS (and hook.manager() POOL_MANAGER_ADDRESS when set) or the daemon refuses to start;
// curve.keeper() must be the signer — a warning in dry run, a refusal when live.
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
// Env:  legacy  FACTORY_V2_ADDRESS + CURVE_ADDRESS + LOCKER_ADDRESS (+ QUOTER_ADDRESS)
//       V4      CURVE_V4_ADDRESS + FACTORY_V4_ADDRESS + HOOK_ADDRESS + V4_ROUTER_ADDRESS +
//               POOL_MANAGER_ADDRESS (+ QUOTER_ADDRESS / ZEROX_API_KEY to price stock entries)
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

// ---- V4 product (LaunchFactoryV4 / CensusCurveV4 / CensusV4Hook / CensusV4Router) ----
const FACTORY_V4_IFACE = new ethers.Interface([
  "event LaunchedV4(address indexed token, address indexed creator, address curve, address vault, uint16 reflectionBps, address quote)",
]);
const CURVE_V4_IFACE = new ethers.Interface([
  "event Graduated(address indexed coin, bytes32 indexed poolId, uint256 tokensIn, uint256 quoteIn, uint128 liquidity)",
  "function graduate(address coin)",
]);
const LAUNCH_V4_TOPIC = FACTORY_V4_IFACE.getEvent("LaunchedV4").topicHash;
const GRAD_V4_TOPIC = CURVE_V4_IFACE.getEvent("Graduated").topicHash;
const CURVE_V4_VIEW_ABI = [
  "function keeper() view returns (address)",
  "function isGraduated(address) view returns (bool)",
  "function graduationProgress(address) view returns (uint256)",
  "function graduator() view returns (address)",
  "function poolIds(address) view returns (bytes32)",
];
const HOOK_ABI = [
  "function registrar() view returns (address)",
  "function manager() view returns (address)",
  "function protocol() view returns (address)",
  "function claimable(address asset, address recipient) view returns (uint256)",
  "function claimFor(address asset, address recipient)",
];
const V4_ROUTER_ABI = ["function hook() view returns (address)"];

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
    // V4 product. CURVE_V4_ADDRESS switches the V4 cycle on; the rest are required with it.
    curveV4: env.CURVE_V4_ADDRESS || null,
    factoryV4: env.FACTORY_V4_ADDRESS || null,
    hook: env.HOOK_ADDRESS || null,
    v4Router: env.V4_ROUTER_ADDRESS || null,
    poolManager: env.POOL_MANAGER_ADDRESS || null,
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
  // Which product cycles run. Legacy needs its whole trio; V4 is keyed on the curve address.
  cfg.legacy = Boolean(cfg.factory && cfg.curve && cfg.locker);
  cfg.v4 = Boolean(cfg.curveV4);
  if (!Number.isInteger(cfg.slippageBps) || cfg.slippageBps < 0 || cfg.slippageBps >= 10000) throw new Error("SLIPPAGE_BPS must be 0..9999");
  if (cfg.logChunk <= 0n) throw new Error("KEEPER_LOG_CHUNK must be positive");
  return cfg;
}

// ---------------------------------------------------------------------------
// durable state (atomic JSON file) + single-instance lock
// ---------------------------------------------------------------------------
// `cursor`/`launches`/`pushOffset` are the legacy registry; `v4` holds the V4 registry with its own
// cursor so the two products discover independently while sharing one pending record and nonce.
const freshState = () => ({ cursor: null, launches: {}, pending: null, pushOffset: {}, v4: { cursor: null, launches: {}, pushOffset: {} }, counters: { cycles: 0, sent: 0, alerts: 0 }, alertsSeen: {} });
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
  return { ...freshState(), ...parsed, v4: { ...freshState().v4, ...(parsed.v4 ?? {}) }, counters: { ...freshState().counters, ...(parsed.counters ?? {}) } };
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

  // ---- V4 discovery: LaunchedV4 (factory) + Graduated(coin, bytes32 poolId) (curve), own cursor ----
  async function discoverV4() {
    const head = await chain.blockNumber();
    const reg = state.v4;
    const from = reg.cursor !== null ? BigInt(reg.cursor) + 1n : cfg.startBlock;
    await scanLogs({ address: [cfg.factoryV4, cfg.curveV4], topics: [[LAUNCH_V4_TOPIC, GRAD_V4_TOPIC]] }, from, head, async (logs, to) => {
      for (const raw of logs) {
        if (raw.topics[0] === LAUNCH_V4_TOPIC && raw.address.toLowerCase() === cfg.factoryV4.toLowerCase()) {
          const ev = FACTORY_V4_IFACE.parseLog(raw);
          const token = ev.args.token.toLowerCase();
          if (!reg.launches[token]) {
            reg.launches[token] = {
              vault: ev.args.vault.toLowerCase(), creator: ev.args.creator.toLowerCase(), quote: ev.args.quote.toLowerCase(),
              reflectionBps: Number(ev.args.reflectionBps),
              createdBlock: raw.blockNumber.toString(), graduated: false, poolId: null,
              // Holder scans start AT the launch block so same-block bundle buyers are tracked too.
              holderCursor: (BigInt(raw.blockNumber) - 1n).toString(), holders: {},
            };
            log(`[discover:v4] launch ${token} vault ${reg.launches[token].vault} reflection ${reg.launches[token].reflectionBps}bps`);
          }
        }
        if (raw.topics[0] === GRAD_V4_TOPIC && raw.address.toLowerCase() === cfg.curveV4.toLowerCase()) {
          const ev = CURVE_V4_IFACE.parseLog(raw);
          const token = ev.args.coin.toLowerCase();
          const launch = reg.launches[token];
          if (launch) {
            launch.graduated = true;
            launch.poolId = String(ev.args.poolId).toLowerCase();
            log(`[discover:v4] graduated ${token} poolId ${launch.poolId}`);
          }
        }
      }
      reg.cursor = to.toString();
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

  // ---- V4 per-launch pipeline steps ----
  // The hook only accrues after graduation (the curve pays the vault directly before), so every hook
  // claim is gated on `graduated`. Claims are permissionless but still go through sendManaged.
  const hookIface = new ethers.Interface(HOOK_ABI);
  let hookTreasury = null; // hook.protocol(): the recorded treasury beneficiary, read once
  async function treasuryAddress() {
    if (!hookTreasury) hookTreasury = String(await chain.read(cfg.hook, HOOK_ABI, "protocol", [])).toLowerCase();
    return hookTreasury;
  }

  // Graduation happens inside the buy that fills the curve. If the pool seeding was rejected in that
  // transaction (GraduationDeferred) the curve is frozen at 100% and anyone may retry graduate(); the
  // keeper is that anyone, so no launch ever waits on a manual transaction.
  async function graduateStepV4(token, launch, budget) {
    if (launch.graduated || budget.used >= budget.max) return;
    const [done, progress] = await Promise.all([
      chain.read(cfg.curveV4, CURVE_V4_VIEW_ABI, "isGraduated", [token]),
      chain.read(cfg.curveV4, CURVE_V4_VIEW_ABI, "graduationProgress", [token]),
    ]);
    if (done) { launch.graduated = true; persist(); return; } // discovery will fill in the poolId
    if (BigInt(progress) < 10000n) return;
    try { await chain.simulate(cfg.curveV4, [...CURVE_V4_VIEW_ABI, "function graduate(address coin)"], "graduate", [token]); }
    catch (e) { await raise("warn", `graduation retry for ${token} still reverts; will retry next cycle`, { message: e.message }, `graduate:${token}`); return; }
    log(`[graduate:v4] ${token} filled but not graduated (deferred); retrying graduate()`);
    budget.used++;
    await sendManaged(`graduate:${token}`, cfg.curveV4, CURVE_V4_IFACE.encodeFunctionData("graduate", [token]));
  }

  async function collectStepV4(token, launch, budget) {
    if (!launch.graduated || launch.vault === ethers.ZeroAddress || budget.used >= budget.max) return;
    const amount = BigInt(await chain.read(cfg.hook, HOOK_ABI, "claimable", [launch.quote, launch.vault]));
    if (amount < cfg.collectMinWei) return;
    log(`[collect:v4] ${token} hook claimable ${amount} -> vault ${launch.vault}`);
    budget.used++;
    await sendManaged(`hookClaim:vault:${token}`, cfg.hook, hookIface.encodeFunctionData("claimFor", [launch.quote, launch.vault]));
  }

  // Creator/treasury claims are keyed per (quote, recipient) on the hook, so one push settles every
  // pool sharing that pair; `done` dedupes them within a cycle.
  async function hookClaimsStepV4(token, launch, budget, done) {
    if (!launch.graduated) return;
    const treasury = await treasuryAddress();
    for (const [label, who] of [["creator", launch.creator], ["treasury", treasury]]) {
      if (budget.used >= budget.max) return;
      const key = `${launch.quote}:${who}`;
      if (done.has(key)) continue;
      done.add(key);
      const amount = BigInt(await chain.read(cfg.hook, HOOK_ABI, "claimable", [launch.quote, who]));
      if (amount < cfg.collectMinWei) continue;
      log(`[collect:v4] ${token} hook claimable ${amount} -> ${label} ${who}`);
      budget.used++;
      await sendManaged(`hookClaim:${label}:${token}`, cfg.hook, hookIface.encodeFunctionData("claimFor", [launch.quote, who]));
    }
  }

  // minOut for a V4 basket: quote entry 0 (credited as-is, pinned so neither planner routes it);
  // every other entry (allow-listed tokenised stocks) from the shared 0x / Uniswap planners, exactly
  // as for a legacy vault. The vault never buys the launch token, so a basket that still names it can
  // only come from a stale deployment: such a launch is skipped for good with a one-time alert.
  // No convert/sell step exists on a V4 vault.
  async function distributeStepV4(token, launch, budget) {
    if (launch.vault === ethers.ZeroAddress || launch.launchTokenBasket || budget.used >= budget.max) return;
    const vault = chain.contract(launch.vault, [...VAULT_ABI, ...VAULT_EXTRA_ABI]);
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
    if (basket.some((a) => a.toLowerCase() === token)) {
      launch.launchTokenBasket = true; // persisted: never re-planned, alerted once
      await raise("error", "distribute skipped for good: V4 basket names the launch token (stale vault deployment; a current CensusRewardVault holds only the quote asset and allow-listed stocks)", { token, vault: launch.vault, basket }, `launch-token-basket:${token}`);
      return;
    }
    const pinned = { [String(quote).toLowerCase()]: 0n };
    const external = basket.filter((a) => pinned[a.toLowerCase()] === undefined);
    let plan;
    let zx = null;
    if (external.length > 0 && allowanceHolder !== ethers.ZeroAddress && process.env.ZEROX_API_KEY) {
      try { zx = await planZeroEx(vault, quote, basket, weights, dec, bal, pinned); } catch (e) { log(`[distribute:v4] 0x planning failed: ${e.message}`); }
    }
    if (zx?.allQuotable) {
      plan = { fn: "distributeVia0x", args: [zx.sellAmounts, zx.swapData, zx.minOut] };
    } else {
      const quoter = cfg.quoter ? chain.contract(cfg.quoter, QUOTER_ABI) : null;
      if (!quoter && external.length > 0) {
        await raise("warn", "distribute skipped: no 0x coverage and QUOTER_ADDRESS unset", { token }, "no-quoter-distribute");
        return;
      }
      const uni = await planUniswap(quoter, quote, Number(swapFee), basket, weights, paths, dec, bal, pinned);
      plan = { fn: "distribute", args: [uni.minOut] };
    }
    log(`[distribute:v4] ${token} ${plan.fn} spending ${bal}`);
    const data = new ethers.Interface(VAULT_ABI).encodeFunctionData(plan.fn, plan.args);
    budget.used++;
    await sendManaged(`${plan.fn}:${token}`, launch.vault, data);
  }

  // Shared by both products: `offsets` is the registry's round-robin map, `share` the holder bps
  // (legacy holdersBps / V4 reflectionBps); nothing is owed when it is zero.
  async function pushStep(token, launch, budget, pushLimit, offsets = state.pushOffset, share = launch.holdersBps) {
    if (launch.vault === ethers.ZeroAddress || share === 0) return;
    await refreshHolders(token, launch);
    const vault = chain.contract(launch.vault, [...VAULT_ABI, ...VAULT_EXTRA_ABI]);
    const basket = [];
    for (let i = 0; i < Number(await vault.basketLength()); i++) basket.push(await vault.basket(i));
    const holders = Object.keys(launch.holders).sort();
    if (holders.length === 0) return;
    const start = offsets[token] ?? 0;
    let pushed = 0;
    for (let i = 0; i < holders.length && pushed < pushLimit && budget.used < budget.max; i++) {
      const holder = holders[(start + i) % holders.length];
      offsets[token] = (start + i + 1) % holders.length;
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
      if (cfg.legacy) await discover();
      if (cfg.v4) await discoverV4();
    } catch (e) {
      await raise("error", "discovery/recovery failed; pipeline skipped this cycle", { message: e.message }, "cycle-failed");
      state.lastRun = { at: Date.now(), actions: 0, dryRun: cfg.dryRun, failed: true };
      persist();
      return;
    }
    const readKeeper = async (curve, abi) => {
      let k = null;
      try { k = String(await chain.read(curve, abi, "keeper", [])).toLowerCase(); } catch { k = null; }
      return k === ethers.ZeroAddress ? null : k;
    };
    const keeper = cfg.legacy ? await readKeeper(cfg.curve, CURVE_VIEW_ABI) : null;
    const keeperV4 = cfg.v4 ? await readKeeper(cfg.curveV4, CURVE_V4_VIEW_ABI) : null;
    // One ordered job list across both registries so the action budget is shared fairly.
    const jobs = [
      ...(cfg.legacy ? Object.entries(state.launches).map(([token, launch]) => ({ token, launch, v4: false })) : []),
      ...(cfg.v4 ? Object.entries(state.v4.launches).map(([token, launch]) => ({ token, launch, v4: true })) : []),
    ];
    const hookClaimsDone = new Set();
    for (let i = 0; i < jobs.length; i++) {
      const { token, launch, v4 } = jobs[i];
      // Fair share of the remaining action budget so one launch's holder list cannot starve the rest.
      const remainingLaunches = jobs.length - i;
      const pushLimit = Math.min(cfg.pushMaxPerCycle, Math.max(1, Math.floor((budget.max - budget.used) / remainingLaunches)));
      try {
        if (v4) {
          await graduateStepV4(token, launch, budget);
          await collectStepV4(token, launch, budget);
          if (launch.vault !== ethers.ZeroAddress && (await canOperate(token, launch, keeperV4))) await distributeStepV4(token, launch, budget);
          await hookClaimsStepV4(token, launch, budget, hookClaimsDone);
        } else {
          await collectStep(token, launch, budget);
          if (await canOperate(token, launch, keeper)) {
            await convertStep(token, launch, budget);
            await distributeStep(token, launch, budget);
          }
        }
      } catch (e) {
        await raise("error", `pipeline failed for ${token}`, { message: e.message }, `pipeline:${token}`);
      }
      // Pushes are permissionless and independent of the steps above: their own failure domain.
      try {
        if (v4) await pushStep(token, launch, budget, pushLimit, state.v4.pushOffset, launch.reflectionBps);
        else await pushStep(token, launch, budget, pushLimit);
      } catch (e) {
        await raise("error", `push failed for ${token}`, { message: e.message }, `push:${token}`);
      }
    }
    state.lastRun = { at: Date.now(), actions: budget.used, dryRun: cfg.dryRun };
    persist();
    log(`[cycle] done: ${budget.used} action(s)${cfg.dryRun ? " (dry run)" : ""}`);
  }

  return { cycle, state, resolvePending, sendManaged, discover, discoverV4, refreshHolders };
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

// V4 startup wiring. Throws on a mismatched hook/router/pool manager; a keeper mismatch throws when
// live and only warns in dry run (planning needs no authority). Returns what it read.
async function verifyV4Wiring(cfg, chain, log = console.log) {
  const lower = (v) => String(v).toLowerCase();
  const [registrar, graduator, routerHook] = await Promise.all([
    chain.read(cfg.hook, HOOK_ABI, "registrar", []),
    chain.read(cfg.curveV4, CURVE_V4_VIEW_ABI, "graduator", []),
    chain.read(cfg.v4Router, V4_ROUTER_ABI, "hook", []),
  ]);
  if (lower(registrar) !== lower(graduator)) throw new Error(`hook.registrar() ${registrar} does not match curve.graduator() ${graduator}: HOOK_ADDRESS/CURVE_V4_ADDRESS are not one deployment`);
  if (lower(routerHook) !== lower(cfg.hook)) throw new Error(`router.hook() ${routerHook} does not match HOOK_ADDRESS ${cfg.hook}`);
  if (cfg.poolManager) {
    const manager = await chain.read(cfg.hook, HOOK_ABI, "manager", []);
    if (lower(manager) !== lower(cfg.poolManager)) throw new Error(`hook.manager() ${manager} does not match POOL_MANAGER_ADDRESS ${cfg.poolManager}`);
  }
  const keeper = lower(await chain.read(cfg.curveV4, CURVE_V4_VIEW_ABI, "keeper", []));
  const signer = chain.address ? lower(chain.address) : null;
  if (keeper !== signer) {
    const msg = `curve.keeper() ${keeper} is not the signer ${signer ?? "(none)"}; V4 vault distributions are keeper-only and need CensusCurveV4.setKeeper(<signer>)`;
    if (!cfg.dryRun) throw new Error(msg);
    log(`[warn] ${msg} (dry run: planning only)`);
  }
  return { registrar: lower(registrar), routerHook: lower(routerHook), keeper };
}

async function main() {
  const cfg = loadConfig();
  const legacyKeys = { factory: "FACTORY_V2_ADDRESS", curve: "CURVE_ADDRESS", locker: "LOCKER_ADDRESS" };
  const v4Keys = { factoryV4: "FACTORY_V4_ADDRESS", hook: "HOOK_ADDRESS", v4Router: "V4_ROUTER_ADDRESS", poolManager: "POOL_MANAGER_ADDRESS" };
  const legacyAny = Object.keys(legacyKeys).some((k) => cfg[k]);
  if (legacyAny) for (const [k, name] of Object.entries(legacyKeys)) if (!cfg[k]) throw new Error(`Missing ${name} (legacy V3 cycle needs all of ${Object.values(legacyKeys).join(", ")})`);
  if (cfg.v4) for (const [k, name] of Object.entries(v4Keys)) if (!cfg[k]) throw new Error(`Missing ${name} (required with CURVE_V4_ADDRESS)`);
  if (!cfg.legacy && !cfg.v4) throw new Error("Nothing to run: set CURVE_V4_ADDRESS (V4) and/or FACTORY_V2_ADDRESS + CURVE_ADDRESS + LOCKER_ADDRESS (legacy V3)");
  const chain = makeChain(cfg);
  if ((await chain.chainId()) !== cfg.chainId) throw new Error("RPC chain does not match CHAIN_ID");
  if (cfg.legacy) {
    // The locker the curve registers positions with must be the one we collect from.
    const curveLocker = String(await chain.read(cfg.curve, CURVE_VIEW_ABI, "locker", [])).toLowerCase();
    if (curveLocker !== cfg.locker.toLowerCase()) throw new Error(`LOCKER_ADDRESS ${cfg.locker} does not match curve.locker() ${curveLocker}`);
  }
  if (cfg.v4) {
    const w = await verifyV4Wiring(cfg, chain);
    console.log(`[v4] hook ${cfg.hook} registrar ${w.registrar} router.hook ${w.routerHook} curve.keeper ${w.keeper}`);
  }
  const release = acquireLock(cfg.stateFile);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { release(); process.exit(0); });
  process.on("exit", release);
  const alert = cfg.alertWebhook
    ? (payload) => fetch(cfg.alertWebhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "census-keeperd", at: new Date().toISOString(), ...payload }), signal: AbortSignal.timeout(10000) })
    : null;
  const keeper = makeKeeper({ cfg, chain, alert });
  console.log(`=== census keeperd === ${cfg.dryRun ? "[DRY RUN]" : "[LIVE]"} products=${[cfg.legacy && "legacy-v3", cfg.v4 && "v4"].filter(Boolean).join("+")} signer=${chain.address ?? "none"} state=${cfg.stateFile} interval=${cfg.intervalMs}ms`);
  let n = 0;
  for (;;) {
    try { await keeper.cycle(); } catch (e) { console.error("[cycle] fatal:", e.message); if (alert) { try { await alert({ level: "error", message: "keeper cycle crashed", detail: { message: e.message } }); } catch { /* logged */ } } }
    n++;
    if (cfg.cycles > 0 && n >= cfg.cycles) break;
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
  }
}

module.exports = { loadConfig, loadState, saveState, acquireLock, makeKeeper, makeChain, verifyV4Wiring };
if (require.main === module) main().catch((e) => { console.error("FATAL:", e.message || e); process.exit(1); });
