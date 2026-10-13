// grindSalt — find a CREATE2 salt so a LaunchToken deploys to the factory's vanity address.
//
// EVM addresses are hex, so the brand is spelled with hex-friendly letters. Delos factories enforce
// `…de105` (five hex chars: 1 in 1,048,576, so ~1M keccak tries, well under a minute here and ~10 s in
// a browser); the Census-era factories enforced `…c0de` (1 in 65,536). LaunchFactoryV4 exposes its own
// VANITY_SUFFIX / VANITY_MASK, so this reads them and falls back to c0de for a factory without the views.
// Off-chain = zero gas, and each launch is an independent grind — nothing "runs out".
const hre = require("hardhat");
const { ethers, artifacts } = hre;

const CENSUS_VANITY = { suffix: 0xc0den, mask: 0xffffn };
const DELOS_VANITY = { suffix: 0xde105n, mask: 0xfffffn };
const VANITY_ABI = ["function VANITY_SUFFIX() view returns (uint160)", "function VANITY_MASK() view returns (uint160)"];

/** The suffix a factory enforces. A factory without the constants is Census-era and wants c0de. */
async function vanityOf(factory, provider = ethers.provider) {
  try {
    const f = new ethers.Contract(factory, VANITY_ABI, provider);
    const [suffix, mask] = await Promise.all([f.VANITY_SUFFIX(), f.VANITY_MASK()]);
    return { suffix: BigInt(suffix), mask: BigInt(mask) };
  } catch {
    return CENSUS_VANITY;
  }
}

async function initCodeHash(factory, args) {
  const art = await artifacts.readArtifact("LaunchToken");
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "uint256", "uint8", "address"],
    [args.name, args.symbol, args.totalSupply, args.decimals, factory]
  );
  return ethers.keccak256(ethers.concat([art.bytecode, encoded]));
}

/** The address a (factory, token args, creator, salt) tuple deploys to — mirrors the factory exactly. */
async function predict(factory, args, creator, salt) {
  const effectiveSalt = ethers.solidityPackedKeccak256(["bytes32", "address"], [salt, creator]);
  return ethers.getCreate2Address(factory, effectiveSalt, await initCodeHash(factory, args));
}

/**
 * @param {string} factory  deployer = the factory address (also the token's `mintTo` arg)
 * @param {{name:string,symbol:string,totalSupply:bigint,decimals:number}} args token constructor args
 * @param {string} creator  the address that will call createLaunch — the salt is bound to it, so no
 *                          one else can reproduce this address (the factory uses keccak256(salt, creator)).
 * @param {{suffix?:bigint|number,mask?:bigint|number,limit?:number,provider?:object}} [opts]
 *        suffix/mask override the factory's own constants (both are read from the factory by default).
 * @returns {Promise<{salt:string,address:string,tries:number,vanity:{suffix:bigint,mask:bigint}}>} `salt` is the value to pass on-chain.
 */
async function grindSalt(factory, args, creator, opts = {}) {
  if (!creator) throw new Error("grindSalt: creator (the launching address) is required — the vanity salt is bound to it");
  const vanity = opts.suffix != null || opts.mask != null
    ? { suffix: BigInt(opts.suffix ?? DELOS_VANITY.suffix), mask: BigInt(opts.mask ?? DELOS_VANITY.mask) }
    : await vanityOf(factory, opts.provider);
  if (vanity.mask > 0xffffffn) throw new Error("grindSalt: masks wider than 24 bits are not supported");
  const limit = opts.limit ?? 50_000_000;
  const hash = ethers.getBytes(await initCodeHash(factory, args));

  // Lean loop: fixed byte buffers and two keccaks per try, no hex round-trips.
  const pre = new Uint8Array(52); // salt (32) ++ creator (20)  -> effective CREATE2 salt
  pre.set(ethers.getBytes(creator), 32);
  const c2 = new Uint8Array(85); // 0xff ++ factory (20) ++ effective salt (32) ++ init code hash (32)
  c2[0] = 0xff; c2.set(ethers.getBytes(factory), 1); c2.set(hash, 53);
  const maskN = Number(vanity.mask), suffixN = Number(vanity.suffix);
  for (let i = 0; i <= limit; i++) {
    pre[28] = (i >>> 24) & 0xff; pre[29] = (i >>> 16) & 0xff; pre[30] = (i >>> 8) & 0xff; pre[31] = i & 0xff;
    c2.set(ethers.getBytes(ethers.keccak256(pre)), 21);
    const h = ethers.keccak256(c2); // 0x + 64 hex chars; the address is the last 40
    if ((parseInt(h.slice(-6), 16) & maskN) === suffixN) {
      return { salt: ethers.zeroPadValue(ethers.toBeHex(i), 32), address: ethers.getAddress("0x" + h.slice(-40)), tries: i + 1, vanity };
    }
  }
  throw new Error(`grindSalt: no salt found for suffix 0x${vanity.suffix.toString(16)} within ${limit} tries`);
}

module.exports = { grindSalt, predict, vanityOf, DELOS_VANITY, CENSUS_VANITY };
