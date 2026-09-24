// Authorize the optional atomic creator-buy factory on the EXISTING temporary V4 stack.
// Requires DEVBUY_TEAM_TEST=1. This does not change the old factory or existing coins.
const hre = require('hardhat');
const fs = require('node:fs');
const path = require('node:path');

const source = path.join(__dirname, '..', 'deployments.v4.robinhood-rehearsal.json');
const target = path.join(__dirname, '..', 'deployments.v4.robinhood-devbuy-teamtest.json');
const equal = (a, b) => a.toLowerCase() === b.toLowerCase();

async function main() {
  if (process.env.DEVBUY_TEAM_TEST !== '1' || hre.network.name !== 'robinhood') {
    throw new Error('This mainnet team-test action requires DEVBUY_TEAM_TEST=1 and --network robinhood');
  }
  if (fs.existsSync(target)) throw new Error(`Deployment record already exists: ${target}`);
  const record = JSON.parse(fs.readFileSync(source, 'utf8'));
  if (record.chainId !== 4663 || record.tag !== 'rehearsal') throw new Error('Expected the existing temporary Robinhood mainnet stack');
  const [signer] = await hre.ethers.getSigners();
  const provider = hre.ethers.provider;
  if (Number((await provider.getNetwork()).chainId) !== 4663 || !equal(signer.address, record.deployer)) throw new Error('Wrong chain or deployer key');
  if ((await provider.getBalance(signer.address)) < hre.ethers.parseEther('0.015')) throw new Error('Insufficient deployer gas balance');

  const old = await hre.ethers.getContractAt('LaunchFactoryV4', record.LaunchFactoryV4);
  const curve = await hre.ethers.getContractAt('CensusCurveV4', record.CensusCurveV4);
  if (!(await curve.factory(record.LaunchFactoryV4)) || !equal(await old.curve(), record.CensusCurveV4)) throw new Error('Existing factory not wired');
  if (!equal(await curve.deployer(), signer.address) || !equal(await old.v4Router(), record.CensusV4Router)) throw new Error('Deployer/router mismatch');
  if (Number(await curve.FEE_BPS()) !== 200 || Number(await curve.CURVE_PROTOCOL_BPS()) !== 9000) throw new Error('Unexpected curve economics');
  const ctor = [await old.weth(), await old.curve(), await old.router(), await old.stockSwapFee(), await old.allowanceHolder(), await old.v4Router()];

  const Vault = await hre.ethers.getContractFactory('CensusRewardVaultDeployer');
  const vault = await Vault.deploy();
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  const Factory = await hre.ethers.getContractFactory('LaunchFactoryV4');
  const factory = await Factory.deploy(...ctor, vaultAddress);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  const bind = await vault.setLaunchFactory(factoryAddress);
  await bind.wait();
  const authorize = await curve.setFactory(factoryAddress, true);
  await authorize.wait();

  if (!(await curve.factory(factoryAddress)) || !equal(await vault.launchFactory(), factoryAddress)
    || !equal(await factory.curve(), record.CensusCurveV4)
    || !equal(await factory.vaultDeployer(), vaultAddress)
    || !equal(await factory.v4Router(), record.CensusV4Router)
    || (await provider.getCode(factoryAddress)) === '0x') throw new Error('Post-deploy verification failed');
  const result = {
    network: 'robinhood', chainId: 4663, tag: 'team-test', deployedAt: new Date().toISOString(),
    oldFactory: record.LaunchFactoryV4, curve: record.CensusCurveV4,
    vaultDeployer: vaultAddress, devBuyFactory: factoryAddress, deployer: signer.address,
    tx: { vault: vault.deploymentTransaction().hash, factory: factory.deploymentTransaction().hash,
      bind: bind.hash, authorize: authorize.hash },
  };
  fs.writeFileSync(target, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
