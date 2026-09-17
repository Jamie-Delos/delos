// Launchpad buyback-and-burn:
//   1. Pull the protocol's WETH out of the FeeVault (the 20% post-graduation cut).
//   2. Swap that WETH into $TOKEN on Uniswap V3.
//   3. Burn the $TOKEN by sending it to the dead address.
//
// Runs in DRY_RUN mode by default: reads balances and prints what it WOULD do, signs nothing.
// Only fires when the vault's WETH balance is at/above BUYBACK_MIN_WETH (gas-saving threshold).
const { ethers } = require("ethers");
const cfg = require("./config");
const { ROUTER_ABI, WETH_ABI, ERC20_ABI } = require("./lib");

const DEAD = "0x000000000000000000000000000000000000dEaD";
const FEE_VAULT_ABI = ["function withdrawAll(address token,address to)"];

async function main() {
  // RETIRED for live use (CX-G1, flagged in Neil's audit): the swap below uses amountOutMinimum: 0 — no
  // slippage protection, full MEV exposure. Live runs are refused; route buybacks through a keeper that
  // supplies a real minimum-out instead. Dry-run inspection (DRY_RUN unset) is still allowed.
  if (!cfg.DRY_RUN) throw new Error("RETIRED: this buyback swaps with amountOutMinimum:0 (no slippage protection). Do not run it live — use a keeper path that sets a real minimum-out.");
  console.log(`\n=== Launchpad buyback & burn === ${cfg.DRY_RUN ? "[DRY RUN — no funds will move]" : "[LIVE]"}`);

  const provider = new ethers.JsonRpcProvider(cfg.RPC_URL);
  let wallet = null;
  if (!cfg.DRY_RUN) {
    if (!cfg.PRIVATE_KEY) throw new Error("PRIVATE_KEY required when DRY_RUN=false");
    wallet = new ethers.Wallet(cfg.PRIVATE_KEY, provider);
    console.log("Signer (must be FeeVault owner):", wallet.address);
  }
  const runner = wallet ?? provider;

  for (const name of ["FEE_VAULT_ADDRESS", "ECOSYSTEM_TOKEN"]) cfg.req(name);

  const weth = new ethers.Contract(cfg.WETH, WETH_ABI, runner);
  const vault = new ethers.Contract(cfg.FEE_VAULT_ADDRESS, FEE_VAULT_ABI, runner);
  const router = new ethers.Contract(cfg.SWAP_ROUTER, ROUTER_ABI, runner);
  const ecoToken = new ethers.Contract(cfg.ECOSYSTEM_TOKEN, ERC20_ABI, runner);

  const vaultWeth = await weth.balanceOf(cfg.FEE_VAULT_ADDRESS);
  console.log(`Vault WETH balance: ${ethers.formatEther(vaultWeth)} (threshold ${ethers.formatEther(cfg.BUYBACK_MIN_WETH)})`);
  if (vaultWeth < cfg.BUYBACK_MIN_WETH) {
    console.log("Below threshold — nothing to do.");
    return;
  }

  const me = wallet ? wallet.address : "<owner>";
  if (cfg.DRY_RUN) {
    console.log(`[1] would withdraw ${ethers.formatEther(vaultWeth)} WETH from vault to ${me}`);
    console.log(`[2] would swap it WETH -> $TOKEN (fee ${cfg.FEE})`);
    console.log(`[3] would send the $TOKEN to ${DEAD} (burn)`);
    console.log("\nDRY RUN complete. Set DRY_RUN=false to execute.");
    return;
  }

  // 1. Withdraw all WETH from the vault to the signer.
  await (await vault.withdrawAll(cfg.WETH, wallet.address)).wait();
  const bal = await weth.balanceOf(wallet.address);

  // 2. Swap WETH -> $TOKEN.
  await (await weth.approve(cfg.SWAP_ROUTER, bal)).wait();
  const ecoTokenBefore = await ecoToken.balanceOf(wallet.address);
  await (await router.exactInputSingle({
    tokenIn: cfg.WETH, tokenOut: cfg.ECOSYSTEM_TOKEN, fee: cfg.FEE, recipient: wallet.address,
    amountIn: bal, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
  })).wait();
  const bought = (await ecoToken.balanceOf(wallet.address)) - ecoTokenBefore;
  console.log(`Bought ${bought} $TOKEN base units`);

  // 3. Burn.
  await (await ecoToken.transfer(DEAD, bought)).wait();
  console.log(`Burned ${bought} $TOKEN -> ${DEAD}. Done.`);
}

main().catch((e) => {
  console.error("FATAL:", e.message || e);
  process.exit(1);
});
