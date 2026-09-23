// Mines a CREATE2 salt so the Census hook lands on an address carrying the flag bits the PoolManager
// reads (CensusV4Hook.REQUIRED_FLAGS = 0x20cc in the low 14 bits). Deterministic: the first salt that
// works is returned, so a re-run with the same deployer + init code reproduces the same address.
const { ethers } = require("ethers");

const REQUIRED_FLAGS = 0x20ccn;
const FLAG_MASK = (1n << 14n) - 1n;

function findHookSalt(deployerAddress, initCode, { start = 0, limit = 5_000_000 } = {}) {
  const hash = ethers.keccak256(initCode);
  for (let i = start; i < start + limit; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const address = ethers.getCreate2Address(deployerAddress, salt, hash);
    if ((BigInt(address) & FLAG_MASK) === REQUIRED_FLAGS) return { salt, address, iterations: i - start + 1 };
  }
  throw new Error(`hook salt search exhausted after ${limit} iterations`);
}

module.exports = { findHookSalt, REQUIRED_FLAGS };
