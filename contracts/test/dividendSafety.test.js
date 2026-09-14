const {expect}=require('chai');
const {ethers}=require('hardhat');
const E=ethers.parseEther;
async function deploy(n,...a){const c=await(await ethers.getContractFactory(n)).deploy(...a);await c.waitForDeployment();return c;}
async function fixture(mixed=false){
  const [operator,...users]=await ethers.getSigners();
  const q=await deploy('MockERC20','Q','Q'),s=await deploy('MockERC20','S','S'),r=await deploy('MockSwapRouter'),zx=await deploy('MockZeroEx');
  const t=await deploy('LaunchToken','T','T',10007n,18,operator.address);
  const v=await deploy('DividendVault',q.target,r.target,3000,mixed?[q.target,s.target]:[q.target],mixed?[6000,4000]:[10000],mixed?['0x','0x']:['0x'],zx.target);
  await v.init(t.target,[],operator.address);await t.setDividendVault(v.target);
  const balances=[4000n,3000n,2000n,1007n];for(let i=0;i<4;i++)await t.transfer(users[i].address,balances[i]);
  return{operator,users,q,s,r,zx,t,v,balances};
}
describe('Dividend backing and transfer accounting',function(){
  this.timeout(180000);
  it('700 dust-sized distributions, transfers and claims match an independent entitlement ledger',async()=>{
    const {q,t,v,users,balances}=await fixture();
    const earned=[0n,0n,0n,0n],paid=[0n,0n,0n,0n],precision=10n**18n;
    let seed=1937,received=0n;
    for(let i=0;i<700;i++){
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      const who=(seed>>>8)%4,other=(who+1+(seed>>>16)%3)%4;
      if(seed%5===0){const amount=BigInt(1+(seed>>>12)%31);await q.mint(v.target,amount);received+=amount;await v.distribute([0]);const delta=amount*precision/10007n;for(let j=0;j<4;j++)earned[j]+=balances[j]*delta;}
      else if(seed%5===1){await v.connect(users[who]).claim();paid[who]=earned[who]/precision;expect(await q.balanceOf(users[who].address)).to.equal(paid[who]);}
      else {const amount=balances[who]===0n?0n:BigInt(seed%19)%(balances[who]+1n);await t.connect(users[who]).transfer(users[other].address,amount);balances[who]-=amount;balances[other]+=amount;}
      for(let j=0;j<4;j++)expect(await v.withdrawableOf(users[j].address,q.target)).to.equal(earned[j]/precision-paid[j]);
      expect(await v.availableQuote()).to.equal(0);
      expect(await v.reserved(q.target)).to.equal(received-paid.reduce((a,b)=>a+b,0n));
      expect(await q.balanceOf(v.target)).to.equal(await v.reserved(q.target));
    }
  });
  it('mixed quote/stock baskets only distribute new funds and release router approvals',async()=>{
    const {q,s,r,v}=await fixture(true);await q.mint(v.target,E('10'));await s.mint(r.target,E('10'));
    await v.distribute([E('6'),E('4')]);expect(await v.reserved(q.target)).to.equal(E('6'));expect(await v.reserved(s.target)).to.equal(E('4'));
    await v.distribute([0,0]);expect(await v.reserved(q.target)).to.equal(E('6'));
    await q.mint(v.target,E('5'));await v.distribute([E('3'),E('2')]);
    expect(await v.reserved(q.target)).to.equal(E('9'));expect(await v.reserved(s.target)).to.equal(E('6'));expect(await q.allowance(v.target,r.target)).to.equal(0);
  });
  it('0x supports a same-asset leg, enforces full weights and cannot spend old quote entitlements',async()=>{
    const {q,s,zx,v}=await fixture(true);await q.mint(v.target,E('10'));await s.mint(zx.target,E('10'));
    const data=zx.interface.encodeFunctionData('swap',[q.target,E('4'),s.target,E('4'),v.target]);
    await expect(v.distributeVia0x([0,E('4')],['0x',data],[0,E('4')])).to.be.reverted;
    await v.distributeVia0x([E('6'),E('4')],['0x',data],[E('6'),E('4')]);
    expect(await v.availableQuote()).to.equal(0);expect(await v.reserved(q.target)).to.equal(E('6'));
    await expect(v.distributeVia0x([E('6'),E('4')],['0x',data],[E('6'),E('4')])).to.be.reverted;
    expect(await q.allowance(v.target,zx.target)).to.equal(0);
  });
  it('rejects a corrupted route payload that delivers no requested payout even with a positive floor',async()=>{
    const {q,s,zx,v}=await fixture(true);await q.mint(v.target,E('10'));
    const data=zx.interface.encodeFunctionData('swap',[q.target,E('4'),s.target,0,v.target]);
    await expect(v.distributeVia0x([E('6'),E('4')],['0x',data],[E('6'),1])).to.be.reverted;
    expect(await v.reserved(q.target)).to.equal(0);expect(await q.balanceOf(v.target)).to.equal(E('10'));
  });
  it('retains a usable distribution operator',async()=>{const {v}=await fixture();await expect(v.setOperator(ethers.ZeroAddress)).to.be.reverted;});
});
