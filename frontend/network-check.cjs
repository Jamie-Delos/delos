// A build must not combine Vercel mainnet settings with a local testnet .env.
const MAINNET = {
  VITE_WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  VITE_SWAP_ROUTER: '0xCaf681a66D020601342297493863E78C959E5cb2',
  VITE_V3_FACTORY: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
  VITE_CONVERSION_QUOTER: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7',
};
function checkNetwork(env) {
  const failures = [];
  if (Number(env.VITE_CHAIN_ID ?? 4663) !== 4663) failures.push('This build must target Robinhood mainnet (VITE_CHAIN_ID=4663).');
  if (/testnet|sepolia|localhost|127\.0\.0\.1/i.test(env.VITE_RPC_URL ?? '')) failures.push('VITE_RPC_URL must be a Robinhood mainnet RPC.');
  for (const [key, expected] of Object.entries(MAINNET)) {
    if (env[key] !== undefined && env[key].toLowerCase() !== expected.toLowerCase()) failures.push(`${key} does not match Robinhood mainnet.`);
  }
  return failures;
}
module.exports = { checkNetwork };
if (require.main === module) {
  (async () => {
    const { loadEnv } = await import('vite');
    // Vite reads .env.local and .env.production.local too; use its own loader/precedence.
    const failures = checkNetwork(loadEnv('production', process.cwd(), 'VITE_'));
    if (failures.length) throw new Error(failures.join('\n'));
    console.log('Network configuration: Robinhood mainnet (4663).');
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
