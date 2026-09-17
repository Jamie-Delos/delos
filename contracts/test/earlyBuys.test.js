const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const E = ethers.parseEther;

async function deploy(name, ...args) {
  const contract = await (await ethers.getContractFactory(name)).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function setup(maxima) {
  const [owner, platform, creator, buyer] = await ethers.getSigners();
  const weth = await deploy('MockWETH');
  const router = await deploy('MockSwapRouter');
  const curve = await deploy('CensusCurve', owner.address, platform.address, owner.address, weth.target, router.target);
  const factory = maxima
    ? await deploy('LaunchFactoryV2', weth.target, curve.target, router.target, 3000, ethers.ZeroAddress)
    : await deploy('LaunchFactory', weth.target, curve.target);
  await curve.setFactory(factory.target, true);
  const params = ['Early buy test', 'EARLY', E('1000000000'), 18, 10000, E('1.5'), E('4')];
  const receipt = await (await (maxima
    ? factory.connect(creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),address[],uint16[],bytes[],bytes32,address,uint16,address[])'](
      params, [weth.target], [10000], ['0x'], ethers.ZeroHash, weth.target, 10000, [])
    : factory.connect(creator)['createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32)'](params, ethers.ZeroHash))).wait();
  const launch = receipt.logs.map(log => { try { return factory.interface.parseLog(log); } catch { return null; } })
    .find(log => log?.name === (maxima ? 'LaunchedV2' : 'Launched'));
  const token = await ethers.getContractAt('LaunchToken', launch.args.token);
  return { curve, token, buyer, creator };
}

for (const maxima of [false, true]) describe(`${maxima ? 'Maxima' : 'Prima'} early purchases`, function () {
  it('allows a purchase above 1% during the early window', async () => {
    const { curve, token, buyer } = await setup(maxima);
    expect(await token.maxBuy()).to.equal(0n);
    await curve.connect(buyer).buyWithETH(token.target, 0, { value: E('0.02') });
    expect(await token.balanceOf(buyer.address)).to.be.gt(E('10000000'));
    expect(await token.balanceOf(buyer.address)).to.be.lt(E('20000000'));
    expect(BigInt(await ethers.provider.getBlockNumber())).to.be.lte(await token.restrictionEndBlock());
  });

  it('does not accumulate a purchase allowance across buy/sell/buy transactions', async () => {
    const { curve, token, buyer } = await setup(maxima);
    await curve.connect(buyer).buyWithETH(token.target, 0, { value: E('0.02') });
    const firstPurchase = await token.balanceOf(buyer.address);
    await token.connect(buyer).approve(curve.target, firstPurchase);
    await curve.connect(buyer).sellForETH(token.target, firstPurchase, 0);
    expect(await token.balanceOf(buyer.address)).to.equal(0n);
    await curve.connect(buyer).buyWithETH(token.target, 0, { value: E('0.02') });
    expect(firstPurchase + await token.balanceOf(buyer.address)).to.be.gt(E('20000000'));
    expect(BigInt(await ethers.provider.getBlockNumber())).to.be.lte(await token.restrictionEndBlock());
  });

  it('retains the separate wallet limit, creator exemption and automatic expiry', async () => {
    const { curve, token, buyer, creator } = await setup(maxima);
    await expect(curve.connect(buyer).buyWithETH(token.target, 0, { value: E('0.1') }))
      .to.be.revertedWithCustomError(token, 'MaxWalletExceeded');
    await curve.connect(creator).buyWithETH(token.target, 0, { value: E('0.1') });
    expect(await token.balanceOf(creator.address)).to.be.gt(E('20000000'));
    await network.provider.send('hardhat_mine', ['0x65']);
    await curve.connect(buyer).buyWithETH(token.target, 0, { value: E('0.1') });
    expect(await token.balanceOf(buyer.address)).to.be.gt(E('20000000'));
  });
});
