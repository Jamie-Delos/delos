// Launchpad reward loop:
//   1. Claim accumulated creator fees from a locked V3 position (paid in WETH).
//   2. Swap that WETH into a chosen reward token on Uniswap V3.
//   3. Airdrop the reward token to holders of the launch token, proportional to holdings.
//
// Runs in DRY_RUN mode by default: it reads chain state and prints exactly what it WOULD do,
// but signs no transactions. Set DRY_RUN=false (and provide PRIVATE_KEY) to go live.
const { ethers } = require("ethers");
const cfg = require("./config");
const { ERC20_ABI, LOCKER_ABI, ROUTER_ABI, WETH_ABI, discoverHolders, computeAirdrop } = require("./lib");

function log(...a) { console.log(...a); }

async function main() {
  log(`\n=== Launchpad reward loop === ${cfg.DRY_RUN ? "[DRY RUN — no funds will move]" : "[LIVE]"}`);

  const provider = new ethers.JsonRpcProvider(cfg.RPC_URL);
  let wallet = null;
  if (!cfg.DRY_RUN) {
    if (!cfg.PRIVATE_KEY) throw new Error("PRIVATE_KEY required when DRY_RUN=false");
    wallet = new ethers.Wallet(cfg.PRIVATE_KEY, provider);
    log("Signer:", wallet.address);
  }
  const runner = wallet ?? provider;

  for (const name of ["LOCKER_ADDRESS", "TOKEN_ID", "LAUNCH_TOKEN", "REWARD_TOKEN"]) cfg.req(name);

  const locker = new ethers.Contract(cfg.LOCKER_ADDRESS, LOCKER_ABI, runner);
  const weth = new ethers.Contract(cfg.WETH, WETH_ABI, runner);
  const router = new ethers.Contract(cfg.SWAP_ROUTER, ROUTER_ABI, runner);
  const reward = new ethers.Contract(cfg.REWARD_TOKEN, ERC20_ABI, runner);
  const me = wallet ? wallet.address : (cfg.PRIVATE_KEY ? new ethers.Wallet(cfg.PRIVATE_KEY).address : ethers.ZeroAddress);

  // --- Step 1: claim fees -------------------------------------------------
  const wethBefore = await weth.balanceOf(me).catch(() => 0n);
  if (cfg.DRY_RUN) {
    const res = await locker.collectFees.staticCall(cfg.TOKEN_ID);
    log(`[1] collectFees(${cfg.TOKEN_ID}) would return amount0=${res[0]} amount1=${res[1]}`);
  } else {
    const tx = await locker.collectFees(cfg.TOKEN_ID);
    log(`[1] collectFees tx ${tx.hash}`);
    await tx.wait();
  }

  // WETH the creator received (in live mode). In dry run we just estimate from the static call view.
  const wethAfter = await weth.balanceOf(me).catch(() => 0n);
  const claimedWeth = cfg.DRY_RUN ? await estimateClaimWeth(locker) : wethAfter - wethBefore;
  log(`    creator WETH available to recycle: ${ethers.formatEther(claimedWeth)}`);
  if (claimedWeth <= 0n) { log("    nothing to recycle; done."); return; }

  // --- Step 2: swap WETH -> reward token ---------------------------------
  let rewardBought = 0n;
  const swapParams = {
    tokenIn: cfg.WETH, tokenOut: cfg.REWARD_TOKEN, fee: cfg.FEE, recipient: me,
    amountIn: claimedWeth, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
  };
  if (cfg.DRY_RUN) {
    log(`[2] would swap ${ethers.formatEther(claimedWeth)} WETH -> reward token (fee ${cfg.FEE})`);
  } else {
    await (await weth.approve(cfg.SWAP_ROUTER, claimedWeth)).wait();
    const rewardBefore = await reward.balanceOf(me);
    const tx = await router.exactInputSingle(swapParams);
    log(`[2] swap tx ${tx.hash}`);
    await tx.wait();
    rewardBought = (await reward.balanceOf(me)) - rewardBefore;
    log(`    bought ${rewardBought} reward-token base units`);
  }

  // --- Step 3: airdrop to launch-token holders ---------------------------
  log(`[3] discovering holders of ${cfg.LAUNCH_TOKEN} …`);
  const holders = await discoverHolders(provider, cfg.LAUNCH_TOKEN, cfg.FROM_BLOCK, cfg.BLOCK_CHUNK, cfg.MIN_HOLDER_BALANCE);
  log(`    ${holders.length} eligible holders`);

  // In dry run we don't actually hold reward tokens; show the split for the claimed amount instead.
  const potForDisplay = cfg.DRY_RUN ? claimedWeth : rewardBought;
  const airdrop = computeAirdrop(holders, potForDisplay);

  if (cfg.DRY_RUN) {
    log(`    would airdrop ${airdrop.length} transfers, e.g.:`);
    for (const row of airdrop.slice(0, 5)) log(`      ${row.address} <- ${row.amount}`);
    if (airdrop.length > 5) log(`      … +${airdrop.length - 5} more`);
    log("\nDRY RUN complete. Set DRY_RUN=false to execute for real.");
    return;
  }

  let sent = 0;
  for (const row of airdrop) {
    const tx = await reward.transfer(row.address, row.amount);
    await tx.wait();
    sent++;
    if (sent % 25 === 0) log(`    …${sent}/${airdrop.length} sent`);
  }
  log(`    airdropped to ${sent} holders. Done.`);
}

// Best-effort estimate of WETH claimable, using the static return of collectFees.
async function estimateClaimWeth(locker) {
  try {
    const res = await locker.collectFees.staticCall(cfg.TOKEN_ID);
    // We don't know here which of token0/token1 is WETH; report the max as an upper bound for display.
    return res[0] > res[1] ? res[0] : res[1];
  } catch {
    return 0n;
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message || e);
  process.exit(1);
});
