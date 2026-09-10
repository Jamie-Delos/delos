// grindSalt — find a CREATE2 salt so a LaunchToken deploys to a `…c0de` address.
//
// EVM vanity ≠ Solana: addresses are hex (0-9 a-f), so "census" is unspellable; `c0de` (CODE) is
// our pump-style signifier. The factory deploys the token via CREATE2 and reverts unless the
// address ends in 0xC0DE, so this must be run off-chain first (client/browser or a launch script).
// 4 hex chars = 1-in-65,536, so ~65k keccak tries (sub-second). Off-chain = zero gas, and each
// launch is an independent grind — nothing "runs out".
const hre = require("hardhat");
const { ethers, artifacts } = hre;

/**
 * @param {string} factory  deployer = the factory address (also the token's `mintTo` arg)
 * @param {{name:string,symbol:string,totalSupply:bigint,decimals:number}} args token constructor args
 * @param {{suffix?:number,mask?:number,limit?:number}} [opts]
 * @returns {Promise<{salt:string,address:string,tries:number}>}
 */
async function grindSalt(factory, args, opts = {}) {
  const suffix = BigInt(opts.suffix ?? 0xc0de);
  const mask = BigInt(opts.mask ?? 0xffff);
  const limit = opts.limit ?? 20_000_000;

  const art = await artifacts.readArtifact("LaunchToken");
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "uint256", "uint8", "address"],
    [args.name, args.symbol, args.totalSupply, args.decimals, factory]
  );
  const initCodeHash = ethers.keccak256(ethers.concat([art.bytecode, encoded]));

  for (let i = 0; i <= limit; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(factory, salt, initCodeHash);
    if ((BigInt(addr) & mask) === suffix) return { salt, address: addr, tries: i + 1 };
  }
  throw new Error(`grindSalt: no salt found for suffix 0x${suffix.toString(16)} within ${limit} tries`);
}

module.exports = { grindSalt };
