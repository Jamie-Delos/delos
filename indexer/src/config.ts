import "dotenv/config";

const addr = (v: string | undefined, d: string) => (v ?? d).toLowerCase() as `0x${string}`;

export const cfg = {
  databaseUrl: process.env.DATABASE_URL ?? "",
  rpcUrl: process.env.RPC_URL ?? "https://rpc.testnet.chain.robinhood.com",
  chainId: Number(process.env.CHAIN_ID ?? 46630),
  curve: addr(process.env.CURVE_ADDRESS, "0x76969310D2300e934c9ba731105a6420d920ee60"),
  factory: addr(process.env.FACTORY_ADDRESS, "0xAfcDA11cdcB1EC228bAcB2d29Fc7eb0C45905358"),
  factoryV2: addr(process.env.FACTORY_V2_ADDRESS, "0x96420b4248c42ef19eb87D3254569Ea730cadF59"),
  weth: addr(process.env.WETH_ADDRESS, "0x823F4ef19CCE787C7D10483896eE0102F48A88eb"),
  startBlock: BigInt(process.env.START_BLOCK ?? 0),
  pollMs: Number(process.env.POLL_MS ?? 4000),
  logPage: BigInt(process.env.LOG_PAGE ?? 5000),
  port: Number(process.env.PORT ?? 8080),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  ethUsd: Number(process.env.ETH_USD ?? 3000),
};
