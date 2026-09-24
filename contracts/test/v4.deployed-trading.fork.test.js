// Read mainnet state, execute transactions ONLY inside Hardhat. No wallet keys are used.
const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const run = process.env.CENSUS_DEPLOYED_FORK === '1' ? describe : describe.skip;
run('Deployed graduated HHJ: ETH -> WETH -> Census pool -> WETH -> ETH', function () {
  this.timeout(180000);
  it('executes a protected buy and sell with the 2% hook fee split 30/70', async () => {
    if (network.name !== 'hardhat') throw Error('This test may only run on the local Hardhat network');
    const rpc = new ethers.JsonRpcProvider('https://rpc.mainnet.chain.robinhood.com');
    const blockNumber = process.env.CENSUS_FORK_BLOCK ? Number(process.env.CENSUS_FORK_BLOCK) : await rpc.getBlockNumber();
    rpc.destroy();
    console.log('Fork block:', blockNumber);
    await network.provider.send('hardhat_reset', [{ forking: {
      jsonRpcUrl: 'https://rpc.mainnet.chain.robinhood.com', blockNumber,
    } }]);
    const [user] = await ethers.getSigners();
    const wethAddress = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
    const coinAddress = '0xBf1423d09Dbbf54121e7F943C7E20D1C164EC0De';
    const router = await ethers.getContractAt('CensusV4Router', '0xb087d45099D9e275c67693eD1a215c66B4907BA6');
    const hook = await ethers.getContractAt('CensusV4Hook', '0xCaA6477f3116126ebD4A7f03B2B7631c70cF20cC');
    const coin = await ethers.getContractAt('LaunchToken', coinAddress);
    const weth = new ethers.Contract(wethAddress, ['function deposit() payable','function withdraw(uint256)','function approve(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)'], user);
    const key = {currency0: wethAddress, currency1: coinAddress, fee:0, tickSpacing:60, hooks:hook.target};
    const quoter = new ethers.Contract('0x8dc178efb8111bb0973dd9d722ebeff267c98f94', ['function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)'], user);
    const input = ethers.parseEther('0.001');
    await (await weth.deposit({value:input})).wait();
    await (await weth.approve(router.target,input)).wait();
    const [quotedBuy] = await quoter.quoteExactInputSingle.staticCall({poolKey:key,zeroForOne:true,exactAmount:input,hookData:'0x'});
    const request = {key,zeroForOne:true,amountIn:input,minOut:quotedBuy*98n/100n,sqrtPriceLimitX96:4295128740n,recipient:user.address,deadline:BigInt((await ethers.provider.getBlock('latest')).timestamp+1200)};
    const receipt = await (await router.swapExactInput(request)).wait();
    const bought = await coin.balanceOf(user.address);
    expect(bought).to.equal(quotedBuy);
    const fees = receipt.logs.filter(l => l.address.toLowerCase() === hook.target.toLowerCase()).map(l => {try{return hook.interface.parseLog(l);}catch{return null;}}).filter(e=>e?.name==='FeeAccrued');
    expect(fees).to.have.length(1);
    expect(fees[0].args.protocolFee + fees[0].args.creatorFee).to.equal(input*2n/100n);
    expect(fees[0].args.protocolFee).to.equal(input*6n/1000n);
    expect(fees[0].args.creatorFee).to.equal(input*14n/1000n);
    expect(fees[0].args.holderFee).to.equal(0n);
    await (await coin.approve(router.target,bought)).wait();
    const [quotedSell] = await quoter.quoteExactInputSingle.staticCall({poolKey:key,zeroForOne:false,exactAmount:bought,hookData:'0x'});
    const sale = await (await router.swapExactInput({...request,zeroForOne:false,amountIn:bought,minOut:quotedSell*98n/100n,sqrtPriceLimitX96:1461446703485210103287273052203988822378723970341n})).wait();
    const proceeds = await weth.balanceOf(user.address);
    expect(proceeds).to.equal(quotedSell);
    expect(await coin.balanceOf(user.address)).to.equal(0n);
    const sellFee = sale.logs.map(l=>{try{return hook.interface.parseLog(l);}catch{return null;}}).find(e=>e?.name==='FeeAccrued');
    expect(sellFee.args.protocolFee+sellFee.args.creatorFee).to.equal(sellFee.args.quoteVolume*2n/100n);
    await (await weth.withdraw(proceeds)).wait();
    expect(await weth.balanceOf(user.address)).to.equal(0n);
    console.log(`Local fork only: bought ${ethers.formatEther(bought)} HHJ; sold for ${ethers.formatEther(proceeds)} ETH; fee split verified.`);

    // Fund a standard payment asset locally, then exercise the same V3 exactInput conversion the UI uses.
    const usdAddress = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
    const usd = new ethers.Contract(usdAddress, ['function balanceOf(address) view returns(uint256)','function approve(address,uint256) returns(bool)'], user);
    const conversion = new ethers.Contract('0xCaf681a66D020601342297493863E78C959E5cb2', ['function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns(uint256 amountOut)'], user);
    await (await weth.deposit({value:input})).wait();
    await (await weth.approve(conversion.target,input)).wait();
    const fundRequest = {path:ethers.solidityPacked(['address','uint24','address'],[wethAddress,100,usdAddress]),recipient:user.address,amountIn:input,amountOutMinimum:1n};
    const usdExpected = await conversion.exactInput.staticCall(fundRequest);
    await (await conversion.exactInput({...fundRequest,amountOutMinimum:usdExpected*99n/100n})).wait();
    const paymentAmount = await usd.balanceOf(user.address);
    await (await usd.approve(conversion.target,paymentAmount)).wait();
    const conversionRequest = {path:ethers.solidityPacked(['address','uint24','address'],[usdAddress,100,wethAddress]),recipient:user.address,amountIn:paymentAmount,amountOutMinimum:1n};
    const wethExpected = await conversion.exactInput.staticCall(conversionRequest);
    await (await conversion.exactInput({...conversionRequest,amountOutMinimum:wethExpected*99n/100n})).wait();
    expect(await weth.balanceOf(user.address)).to.equal(wethExpected);
    expect(await usd.balanceOf(user.address)).to.equal(0n);
    console.log('Local fork only: USDG conversion through the deployed V3 router passed.');
  });
});
