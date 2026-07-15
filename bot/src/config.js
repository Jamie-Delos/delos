require("dotenv").config();

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

module.exports = {
  DRY_RUN: process.env.DRY_RUN !== "false", // default TRUE — never touch funds unless explicitly off
  RPC_URL: process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
  PRIVATE_KEY: process.env.PRIVATE_KEY,

  LOCKER_ADDRESS: process.env.LOCKER_ADDRESS,
  // Uniswap V3 on Robinhood Chain (chainId 4663).
  SWAP_ROUTER: process.env.SWAP_ROUTER || "0xCaf681a66D020601342297493863E78C959E5cb2",
  WETH: process.env.WETH || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",

  TOKEN_ID: process.env.TOKEN_ID,
  LAUNCH_TOKEN: process.env.LAUNCH_TOKEN,
  REWARD_TOKEN: process.env.REWARD_TOKEN,
  FEE: Number(process.env.FEE || 3000),

  FROM_BLOCK: BigInt(process.env.FROM_BLOCK || 0),
  BLOCK_CHUNK: BigInt(process.env.BLOCK_CHUNK || 10000),
  MIN_HOLDER_BALANCE: BigInt(process.env.MIN_HOLDER_BALANCE || 0),

  // buyback & burn
  FEE_VAULT_ADDRESS: process.env.FEE_VAULT_ADDRESS,
  ECOSYSTEM_TOKEN: process.env.ECOSYSTEM_TOKEN,
  BUYBACK_MIN_WETH: BigInt(process.env.BUYBACK_MIN_WETH || "100000000000000000"), // 0.1 WETH default

  req,
};
