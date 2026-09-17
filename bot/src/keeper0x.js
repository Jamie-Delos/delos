// v2 DividendVault keeper — convert a vault's accumulated WETH fees into its stock basket, then credit
// holders on-chain. Two engines, flip between them with MODE (no redeploy — both live in the vault):
//   MODE=auto     (default) try 0x per leg; if 0x is available for every stock use distributeVia0x,
//                 otherwise fall back to Uniswap distribute(). Flips to 0x automatically once 0x
//                 enables the tokenised stocks — nothing else changes.
//   MODE=zerox    force the 0x path (distributeVia0x).
//   MODE=uniswap  force the Uniswap path (distribute()).
//
//   node src/keeper0x.js               DRY RUN — reads the vault, plans, signs nothing (default).
//   DRY_RUN=false node src/keeper0x.js LIVE — the operator wallet executes the chosen path.
//   node src/keeper0x.js probe         No vault needed — quote WETH -> stocks to check 0x availability.
//
// 0x path safety lives in the contract: the vault only ever approves/calls the pinned AllowanceHolder,
// approves the exact amount then resets to 0, credits the measured balance delta, and reverts unless it
// clears minOut. Uniswap path uses a QuoterV2 quote minus SLIPPAGE_BPS as its on-chain minOut.
require("dotenv").config();
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = Number(process.env.CHAIN_ID || 4663);
const DRY_RUN = process.env.DRY_RUN !== "false"; // default TRUE — never sign unless explicitly off
const MODE = (process.env.MODE || "auto").toLowerCase(); // auto | zerox | uniswap
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
const WETH = process.env.WETH || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const QUOTER_ADDRESS = process.env.QUOTER_ADDRESS; // Uniswap V3 QuoterV2, for Uniswap-path minOut
const ZEROX_API_BASE = process.env.ZEROX_API_BASE || "https://api.0x.org";
const ZEROX_API_KEY = process.env.ZEROX_API_KEY;
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 100); // 1% default
if (!Number.isInteger(SLIPPAGE_BPS) || SLIPPAGE_BPS < 0 || SLIPPAGE_BPS >= 10000) throw new Error("SLIPPAGE_BPS must be 0..9999");

const VAULT_ABI = [
  "function basketLength() view returns (uint256)",
  "function basket(uint256) view returns (address)",
  "function weights(uint256) view returns (uint16)",
  "function paths(uint256) view returns (bytes)",
  "function quote() view returns (address)",
  "function swapFee() view returns (uint24)",
  "function operator() view returns (address)",
  "function allowanceHolder() view returns (address)",
  "function availableQuote() view returns (uint256)",
  "function distribute(uint256[] minOut) returns (uint256)",
  "function distributeVia0x(uint256[] sellAmounts, bytes[] swapData, uint256[] minOut) returns (uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];
const QUOTER_ABI = [
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

// Override with PROBE_STOCKS="SYM:0xaddr,SYM:0xaddr" to test arbitrary tokens (e.g. a stablecoin control).
const PROBE_STOCKS = process.env.PROBE_STOCKS
  ? process.env.PROBE_STOCKS.split(",").map((s) => { const [sym, addr] = s.split(":"); return { sym, addr }; })
  : [
      { sym: "NVDA", addr: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" },
      { sym: "TSLA", addr: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" },
      { sym: "MSFT", addr: "0xe93237C50D904957Cf27E7B1133b510C669c2e74" },
    ];

const log = (...a) => console.log(...a);
const applySlippage = (out) => (out * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;

if (typeof fetch !== "function") {
  throw new Error("global fetch not found — run on Node 18+ (this project already targets modern Node)");
}

async function zeroEx(endpoint, params) {
  if (!ZEROX_API_KEY) throw new Error("Missing ZEROX_API_KEY (put it in bot/.env, never commit it)");
  const u = new URL(`${ZEROX_API_BASE}/swap/allowance-holder/${endpoint}`);
  u.searchParams.set("chainId", String(CHAIN_ID));
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  const res = await fetch(u, { headers: { "0x-api-key": ZEROX_API_KEY, "0x-version": "v2" }, signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`0x ${endpoint} ${res.status}: ${body.reason || body.message || JSON.stringify(body).slice(0, 240)}`);
  return body;
}

function routeSummary(q) {
  const fills = q?.route?.fills;
  if (!Array.isArray(fills) || fills.length === 0) return "n/a";
  return fills.map((f) => `${f.source} ${Math.round(Number(f.proportionBps || 0) / 100)}%`).join(" + ");
}

async function probe() {
  log(`\n=== 0x probe — chainId ${CHAIN_ID} via ${ZEROX_API_BASE} ===`);
  const sellAmount = BigInt(process.env.PROBE_SELL || "10000000000000000"); // 0.01 WETH
  log(`selling ${ethers.formatEther(sellAmount)} WETH into each token (indicative price)\n`);
  let ok = 0;
  for (const s of PROBE_STOCKS) {
    try {
      const q = await zeroEx("price", { sellToken: WETH, buyToken: s.addr, sellAmount });
      if (q.liquidityAvailable === false) { log(`  ${s.sym.padEnd(5)} no liquidity`); continue; }
      log(`  ${s.sym.padEnd(5)} buyAmount ${q.buyAmount}  (min ${q.minBuyAmount ?? "-"})  via ${routeSummary(q)}`);
      ok++;
    } catch (e) {
      log(`  ${s.sym.padEnd(5)} ERROR ${e.message}`);
    }
  }
  log(`\n${ok}/${PROBE_STOCKS.length} tokens quotable on 0x.`);
}

// Try a 0x quote for every leg. Returns per-leg calldata + whether ALL legs are available on 0x.
async function planZeroEx(vault, quote, basket, weights, dec, bal) {
  const sellAmounts = [], swapData = [], minOut = [], notes = [];
  const target = (await vault.allowanceHolder()).toLowerCase();
  let allQuotable = true, anyQuotable = false;
  for (let i = 0; i < basket.length; i++) {
    const sell = (bal * BigInt(weights[i])) / 10000n;
    if (sell === 0n) { sellAmounts.push(0n); swapData.push("0x"); minOut.push(0n); continue; }
    if (quote.toLowerCase() === basket[i].toLowerCase()) {
      sellAmounts.push(sell); swapData.push("0x"); minOut.push(sell); anyQuotable = true;
      notes.push(`${basket[i].slice(0, 8)} same-asset payout (no swap)`); continue;
    }
    try {
      const q = await zeroEx("quote", { sellToken: quote, buyToken: basket[i], sellAmount: sell, taker: vault.target ?? VAULT_ADDRESS, slippageBps: SLIPPAGE_BPS });
      if (q.liquidityAvailable === false || !q.transaction?.data) throw new Error("no liquidity");
      if (q.transaction.to?.toLowerCase() !== target || q.issues?.allowance?.spender && q.issues.allowance.spender.toLowerCase() !== target) throw new Error("unexpected 0x target/spender");
      if (q.sellToken?.toLowerCase() !== quote.toLowerCase() || q.buyToken?.toLowerCase() !== basket[i].toLowerCase() || BigInt(q.sellAmount) !== sell) throw new Error("quote asset/amount mismatch");
      if (BigInt(q.minBuyAmount) <= 0n || BigInt(q.transaction.value || 0) !== 0n) throw new Error("unsafe quote bounds/value");
      sellAmounts.push(sell); swapData.push(q.transaction.data); minOut.push(BigInt(q.minBuyAmount));
      notes.push(`${basket[i].slice(0, 8)} ~${ethers.formatUnits(q.buyAmount, dec[i])} via ${routeSummary(q)}`);
      anyQuotable = true;
    } catch (e) {
      sellAmounts.push(0n); swapData.push("0x"); minOut.push(0n);
      notes.push(`${basket[i].slice(0, 8)} 0x unavailable (${e.message})`);
      allQuotable = false;
    }
  }
  return { sellAmounts, swapData, minOut, allQuotable, anyQuotable, notes };
}

// Uniswap-path minOut per leg, using the vault's own stored routes via a QuoterV2 static call.
async function planUniswap(quoter, quote, swapFee, basket, weights, paths, dec, bal) {
  const minOut = [], notes = [];
  for (let i = 0; i < basket.length; i++) {
    const portion = (bal * BigInt(weights[i])) / 10000n;
    if (portion === 0n) { minOut.push(0n); continue; }
    if (quote.toLowerCase() === basket[i].toLowerCase()) {
      minOut.push(portion); notes.push(`${basket[i].slice(0, 8)} same-asset payout (no swap)`); continue;
    }
    if (!quoter) { minOut.push(0n); notes.push(`${basket[i].slice(0, 8)} minOut=0 (no QUOTER_ADDRESS)`); continue; }
    let out;
    if (paths[i] && paths[i] !== "0x" && paths[i].length > 2) {
      out = (await quoter.quoteExactInput.staticCall(paths[i], portion))[0];
    } else {
      out = (await quoter.quoteExactInputSingle.staticCall({ tokenIn: quote, tokenOut: basket[i], amountIn: portion, fee: swapFee, sqrtPriceLimitX96: 0 }))[0];
    }
    const mo = applySlippage(out);
    if (mo <= 0n) throw new Error("Uniswap output rounds to zero");
    minOut.push(mo);
    notes.push(`${basket[i].slice(0, 8)} ~${ethers.formatUnits(out, dec[i])} floor ${ethers.formatUnits(mo, dec[i])}`);
  }
  return { minOut, notes };
}

async function main() {
  log(`\n=== v2 DividendVault keeper === ${DRY_RUN ? "[DRY RUN — nothing signed]" : "[LIVE]"}  mode=${MODE}`);
  if (!VAULT_ADDRESS) throw new Error("Missing VAULT_ADDRESS");
  if (!["auto", "zerox", "uniswap"].includes(MODE)) throw new Error(`MODE must be auto|zerox|uniswap (got ${MODE})`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  if (Number((await provider.getNetwork()).chainId) !== CHAIN_ID) throw new Error("RPC chain does not match CHAIN_ID");
  let wallet = null;
  if (!DRY_RUN) {
    if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY required when DRY_RUN=false");
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    log("Signer:", wallet.address);
  }
  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet ?? provider);

  const [quote, swapFee, operator, allowanceHolder, len] = await Promise.all([
    vault.quote(), vault.swapFee(), vault.operator(), vault.allowanceHolder(), vault.basketLength(),
  ]);
  log(`vault ${VAULT_ADDRESS}`);
  log(`quote ${quote}  operator ${operator}  allowanceHolder ${allowanceHolder}`);
  if (!DRY_RUN && wallet.address.toLowerCase() !== operator.toLowerCase()) {
    throw new Error(`signer ${wallet.address} is not the vault operator ${operator}`);
  }

  const bal = await vault.availableQuote();
  log(`unallocated quote balance (base units): ${bal}`);
  if (bal === 0n) { log("nothing to distribute; done."); return; }

  const basket = [], weights = [], paths = [], dec = [];
  for (let i = 0; i < Number(len); i++) {
    basket.push(await vault.basket(i));
    weights.push(Number(await vault.weights(i)));
    paths.push(await vault.paths(i));
    dec.push(await new ethers.Contract(basket[i], ERC20_ABI, provider).decimals().catch(() => 18));
  }

  // ---- choose the engine ----
  let use0x = false, zx = null;
  if (MODE === "zerox" || MODE === "auto") {
    if (allowanceHolder === ethers.ZeroAddress) {
      if (MODE === "zerox") throw new Error("vault has no allowanceHolder — 0x path disabled");
      log("0x path disabled on this vault (no allowanceHolder) — using Uniswap.");
    } else {
      zx = await planZeroEx(vault, quote, basket, weights, dec, bal);
      zx.notes.forEach((n) => log("  0x:", n));
      if (MODE === "zerox") {
        if (!zx.allQuotable) throw new Error("0x must quote the complete basket; partial allocations are disabled");
        use0x = true;
      } else { // auto: prefer 0x only if it covers the whole basket
        use0x = zx.allQuotable;
        log(use0x ? "  auto -> 0x (all legs available)" : "  auto -> Uniswap (0x unavailable for some legs)");
      }
    }
  }

  let plan;
  if (use0x) {
    const total = zx.sellAmounts.reduce((s, x) => s + x, 0n);
    plan = { fn: "distributeVia0x", args: [zx.sellAmounts, zx.swapData, zx.minOut], spend: total };
  } else {
    const quoter = QUOTER_ADDRESS ? new ethers.Contract(QUOTER_ADDRESS, QUOTER_ABI, provider) : null;
    if (!quoter && !DRY_RUN && basket.some(s => s.toLowerCase() !== quote.toLowerCase())) throw new Error("Uniswap path needs QUOTER_ADDRESS for slippage protection");
    const uni = await planUniswap(quoter, quote, swapFee, basket, weights, paths, dec, bal);
    uni.notes.forEach((n) => log("  uni:", n));
    plan = { fn: "distribute", args: [uni.minOut], spend: bal };
  }

  log(`\nEngine: ${plan.fn === "distributeVia0x" ? "0x" : "Uniswap"}. Spending ${ethers.formatEther(plan.spend)} WETH across the basket.`);
  if (DRY_RUN) { log(`[DRY RUN] would call ${plan.fn}(). Set DRY_RUN=false (signer = operator) to execute.`); return; }
  const tx = await vault[plan.fn](...plan.args);
  log(`${plan.fn} tx ${tx.hash}`);
  const rc = await tx.wait();
  log(`done in block ${rc.blockNumber}. basket bought and credited to holders.`);
}

// Reused by the production keeper daemon (src/keeperd.js); the CLI below only runs when invoked directly.
module.exports = { planZeroEx, planUniswap, zeroEx, VAULT_ABI, QUOTER_ABI, ERC20_ABI, applySlippage };

const cmd = process.argv[2];
if (require.main === module) {
  (cmd === "probe" ? probe() : main()).catch((e) => { console.error("FATAL:", e.message || e); process.exit(1); });
}
