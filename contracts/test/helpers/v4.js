const { ethers } = require('hardhat');
const { findHookSalt } = require('../../scripts/lib/hookSalt');
async function deploy(name, ...args) {
  const c = await (await ethers.getContractFactory(name)).deploy(...args);
  await c.waitForDeployment(); return c;
}
// Deploys the hook through the production CensusHookDeployer with a mined salt (same path as deployV4.js).
async function deployHook(manager, registrar, protocol) {
  const miner = await deploy('CensusHookDeployer');
  const factory = await ethers.getContractFactory('CensusV4Hook');
  const code = (await factory.getDeployTransaction(manager, registrar, protocol)).data;
  const { salt, address } = findHookSalt(miner.target, code);
  await (await miner.deploy(salt, code)).wait();
  return factory.attach(address);
}
function sqrt(n) {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}
module.exports = { deploy, deployHook, sqrt };
