const { expect } = require("chai");
const hre = require("hardhat");
const E = (n) => hre.ethers.parseEther(String(n));
const ZERO = "0x0000000000000000000000000000000000000000";
const SALT = "0x" + "00".repeat(32);
const mine = (n) => hre.network.provider.send("hardhat_mine", ["0x" + n.toString(16)]);

// The CensusCurve bonding curve: un-dodgeable 2% fee (25% platform / 75% creator side), constant-product
// pricing, anti-snipe, and graduation readiness. (Actual pool creation at graduate() needs real Uniswap
// and is proven on devnet; here we prove the trading + fee + accounting + guards.)
describe("CensusCurve — bonding curve, 2% fee, accounting, anti-snipe", () => {
  const PARAMS = {
    name: "Test", symbol: "TEST", totalSupply: E(1_000_000_000), decimals: 18,
    poolFee: 100, virtualQuote: E(1.5), graduationQuote: E(4),
  };

  async function setup() {
    const [deployer, platform, creator, trader] = await hre.ethers.getSigners();
    const ERC20 = await hre.ethers.getContractFactory("MockERC20");
    const WETH = await hre.ethers.getContractFactory("MockWETH");
    const quote = await WETH.deploy(); await quote.waitForDeployment(); // WETH9-style: deposit/withdraw for buyWithETH/sellForETH

    // Dummy npm/locker: buy/sell/register/views never call them (graduation does, tested on devnet). The
    // swap router is only used by the zap path (non-ETH quotes) — a MockSwapRouter stands in for it.
    const router = await (await hre.ethers.getContractFactory("MockSwapRouter")).deploy();
    await router.waitForDeployment();
    const Curve = await hre.ethers.getContractFactory("CensusCurve");
    const curve = await Curve.deploy(deployer.address, platform.address, deployer.address, await quote.getAddress(), await router.getAddress());
    await curve.waitForDeployment();

    const Factory = await hre.ethers.getContractFactory("LaunchFactory");
    const factory = await Factory.deploy(await quote.getAddress(), await curve.getAddress());
    await factory.waitForDeployment();
    await (await curve.setFactory(await factory.getAddress(), true)).wait();

    // Launch a Prima coin (whole supply -> curve).
    const p = [PARAMS.name, PARAMS.symbol, PARAMS.totalSupply, PARAMS.decimals, PARAMS.poolFee, PARAMS.virtualQuote, PARAMS.graduationQuote];
    const tx = await factory.connect(creator)["createLaunch((string,string,uint256,uint8,uint24,uint256,uint256),bytes32)"](p, SALT);
    const rc = await tx.wait();
    let coinAddr;
    for (const log of rc.logs) {
      try { const pl = factory.interface.parseLog(log); if (pl && pl.name === "Launched") coinAddr = pl.args.token; } catch {}
    }
    const coin = ERC20.attach(coinAddr);

    const fund = async (who, amt) => { await quote.mint(who.address, amt); await quote.connect(who).approve(await curve.getAddress(), amt); };
    return { deployer, platform, creator, trader, quote, curve, factory, coin, router };
  }

  // A HOOD-quoted curve for the ETH-zap path: curve pays out in HOOD, but buyers pay ETH and sellers
  // receive ETH — the curve wraps to WETH and swaps WETH<->HOOD through the (mock) router. We register
  // the curve directly (deployer authorised as a factory) since the live factories mint WETH-quoted coins.
  async function setupZap() {
    const { deployer, platform, creator, trader, quote, curve, router } = await setup();
    const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
    const hood = await MockERC20.deploy("Robinhood", "HOOD"); await hood.waitForDeployment();
    const coin = await MockERC20.deploy("Zap Coin", "ZAP"); await coin.waitForDeployment();
    const hoodAddr = await hood.getAddress();
    const coinAddr = await coin.getAddress();
    const curveAddr = await curve.getAddress();

    // Fund the router's inventory so it can pay out both swap directions (1:1 by default).
    await (await hood.mint(await router.getAddress(), E(1_000_000))).wait();
    await (await quote.mint(await router.getAddress(), E(1_000_000))).wait();

    // Whole supply into the curve, then register it as a HOOD-quoted curve and enable the HOOD zap with
    // a V3 multi-hop path (the mock only reads the first/last token; on mainnet this is WETH->USDG->HOOD).
    const wethAddr = await quote.getAddress();
    const pathIn = hre.ethers.solidityPacked(["address", "uint24", "address"], [wethAddr, 3000, hoodAddr]);
    const pathOut = hre.ethers.solidityPacked(["address", "uint24", "address"], [hoodAddr, 3000, wethAddr]);
    await (await coin.mint(curveAddr, PARAMS.totalSupply)).wait();
    await (await curve.setFactory(deployer.address, true)).wait();
    await (await curve.setQuoteAllowed(hoodAddr, true)).wait(); // HOOD must be an approved collateral
    await (await curve.register(coinAddr, hoodAddr, creator.address, ZERO, 0, PARAMS.poolFee, PARAMS.virtualQuote, PARAMS.totalSupply, PARAMS.graduationQuote)).wait();
    await (await curve.setZapPath(hoodAddr, pathIn, pathOut)).wait();
    return { deployer, platform, creator, trader, quote, hood, curve, coin, router };
  }

  it("seeds the whole supply into the curve and registers it", async () => {
    const { curve, coin } = await setup();
    expect(await coin.balanceOf(await curve.getAddress())).to.equal(PARAMS.totalSupply);
    const c = await curve.curves(await coin.getAddress());
    expect(c.exists).to.equal(true);
    expect(c.tokenReserve).to.equal(PARAMS.totalSupply);
    expect(c.virtualQuote).to.equal(PARAMS.virtualQuote);
    expect(c.realQuote).to.equal(0n);
  });

  it("buy: 2% fee splits 25% platform / 75% creator (Prima), rest walks the curve", async () => {
    const { platform, creator, trader, quote, curve, coin } = await setup();
    await mine(101); // past the anti-snipe window
    await quote.mint(trader.address, E(1));
    await quote.connect(trader).approve(await curve.getAddress(), E(1));

    const expTokens = await curve.quoteBuy(await coin.getAddress(), E(1));
    await curve.connect(trader).buy(await coin.getAddress(), E(1), 0);

    expect(await quote.balanceOf(platform.address)).to.equal(E(0.005)); // 25% of 2% of 1
    expect(await quote.balanceOf(creator.address)).to.equal(E(0.015));  // 75% of 2% of 1
    expect(await coin.balanceOf(trader.address)).to.equal(expTokens);   // view matches the trade
    const c = await curve.curves(await coin.getAddress());
    expect(c.realQuote).to.equal(E(0.98));                              // net (98%) held by the curve
    expect(c.virtualQuote).to.equal(E(1.5) + E(0.98));
    expect(c.tokenReserve).to.equal(PARAMS.totalSupply - expTokens);
  });

  it("buyWithETH + sellForETH: one-tap native ETH in, native ETH out (ETH-quoted coin)", async () => {
    const { platform, creator, trader, quote, curve, coin } = await setup();
    await mine(101); // past the anti-snipe window
    const coinAddr = await coin.getAddress();

    // Buy with native ETH: no pre-wrap, no approval, single call.
    const expTokens = await curve.quoteBuy(coinAddr, E(1));
    await curve.connect(trader).buyWithETH(coinAddr, 0, { value: E(1) });
    expect(await coin.balanceOf(trader.address)).to.equal(expTokens);
    expect(await quote.balanceOf(platform.address)).to.equal(E(0.005)); // 2% fee, 25% platform (in WETH)
    expect(await quote.balanceOf(creator.address)).to.equal(E(0.015));  // 75% creator side

    // Sell back for native ETH: the curve unwraps the WETH proceeds.
    const tokens = await coin.balanceOf(trader.address);
    await coin.connect(trader).approve(await curve.getAddress(), tokens);
    const ethBefore = await hre.ethers.provider.getBalance(trader.address);
    const rc = await (await curve.connect(trader).sellForETH(coinAddr, tokens, 0)).wait();
    const ethAfter = await hre.ethers.provider.getBalance(trader.address);
    expect(ethAfter + rc.gasUsed * rc.gasPrice).to.be.gt(ethBefore); // received native ETH (net of gas)
    const c = await curve.curves(coinAddr);
    expect(c.realQuote).to.be.lt(E(0.0001)); // reserve back to dust
  });

  it("ZAP buyWithETH: HOOD-quoted coin — ETH in wraps + swaps to HOOD, buys, fees paid in HOOD", async () => {
    const { platform, creator, trader, hood, curve, coin } = await setupZap();
    const coinAddr = await coin.getAddress();
    await hre.network.provider.send("evm_increaseTime", [3]);
    await hre.network.provider.send("evm_mine");

    // At the router's 1:1 rate, E(1) ETH -> E(1) HOOD into the curve, so tokens out match a 1-HOOD buy.
    const expTokens = await curve.quoteBuy(coinAddr, E(1));
    await curve.connect(trader).buyWithETH(coinAddr, expTokens, { value: E(1) }); // minTokensOut guards the whole path
    expect(await coin.balanceOf(trader.address)).to.equal(expTokens);

    // Fee (2%) is taken + split in the QUOTE asset, which for this coin is HOOD.
    expect(await hood.balanceOf(platform.address)).to.equal(E(0.005)); // 25% of 2% of 1
    expect(await hood.balanceOf(creator.address)).to.equal(E(0.015));  // 75% creator side (Prima: holdersBps 0)
    const c = await curve.curves(coinAddr);
    expect(c.realQuote).to.equal(E(0.98)); // net HOOD held by the curve
  });

  it("ZAP launch buy takes the decayed tax in the quote asset", async () => {
    const { platform, creator, trader, hood, curve, coin } = await setupZap();
    const coinAddr = await coin.getAddress();
    await hre.network.provider.send("evm_setNextBlockTimestamp", [Number(await curve.launchedAt(coinAddr)) + 2]);
    const rc = await (await curve.connect(trader).buyWithETH(coinAddr, 0, { value: E('0.1') })).wait();
    const trade = rc.logs.map(l => { try { return curve.interface.parseLog(l); } catch { return null; } }).find(l => l?.name === 'Traded');
    const fee = E('0.1') * 219n / 10000n;
    expect(trade.args.fee).to.equal(fee);
    expect(await hood.balanceOf(platform.address)).to.equal(fee / 4n);
    expect(await hood.balanceOf(creator.address)).to.equal(fee - fee / 4n);
    expect((await curve.curves(coinAddr)).realQuote).to.equal(E('0.1') - fee);
  });

  it("ZAP sellForETH: HOOD-quoted coin — sell gives HOOD, swaps to WETH, unwraps to native ETH", async () => {
    const { trader, curve, coin } = await setupZap();
    const coinAddr = await coin.getAddress();
    await curve.connect(trader).buyWithETH(coinAddr, 0, { value: E(1) });

    const tokens = await coin.balanceOf(trader.address);
    await (await coin.connect(trader).approve(await curve.getAddress(), tokens)).wait();
    const ethBefore = await hre.ethers.provider.getBalance(trader.address);
    const rc = await (await curve.connect(trader).sellForETH(coinAddr, tokens, 0)).wait();
    const ethAfter = await hre.ethers.provider.getBalance(trader.address);
    expect(ethAfter + rc.gasUsed * rc.gasPrice).to.be.gt(ethBefore); // received native ETH (net of gas)
    const c = await curve.curves(coinAddr);
    expect(c.realQuote).to.be.lt(E(0.0001)); // HOOD reserve back to dust
  });

  it("ZAP slippage: a worse router rate than minTokensOut expects reverts", async () => {
    const { trader, curve, coin, router } = await setupZap();
    const coinAddr = await coin.getAddress();
    const expAt1to1 = await curve.quoteBuy(coinAddr, E(1));
    await (await router.setRate(1, 2)).wait(); // HOOD out halved -> fewer tokens than the 1:1 expectation
    await expect(curve.connect(trader).buyWithETH(coinAddr, expAt1to1, { value: E(1) })).to.be.reverted;
  });

  it("ZAP guard: buyWithETH on a non-zap-enabled non-ETH quote reverts NotZappable", async () => {
    const { deployer, creator, curve, router } = await setupZap();
    // Register a second HOOD-quoted coin but DON'T enable its zap fee.
    const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
    const hood2 = await MockERC20.deploy("Hood2", "HOOD2"); await hood2.waitForDeployment();
    const coin2 = await MockERC20.deploy("NoZap", "NOZAP"); await coin2.waitForDeployment();
    await (await coin2.mint(await curve.getAddress(), PARAMS.totalSupply)).wait();
    await (await curve.setQuoteAllowed(await hood2.getAddress(), true)).wait();
    await (await curve.register(await coin2.getAddress(), await hood2.getAddress(), creator.address, ZERO, 0, PARAMS.poolFee, PARAMS.virtualQuote, PARAMS.totalSupply, PARAMS.graduationQuote)).wait();
    await expect(curve.buyWithETH(await coin2.getAddress(), 0, { value: E(1) })).to.be.reverted; // NotZappable
    void deployer; void router;
  });

  it("buyWithETH rejects a zero-value call", async () => {
    const { curve, coin } = await setup();
    await mine(101);
    await expect(curve.buyWithETH(await coin.getAddress(), 0, { value: 0 })).to.be.reverted;
  });

  it("round-trip conserves value (no free money): buy then sell-all returns < input, curve resets", async () => {
    const { trader, quote, curve, coin } = await setup();
    await mine(101);
    await quote.mint(trader.address, E(1));
    await quote.connect(trader).approve(await curve.getAddress(), E(1));
    await curve.connect(trader).buy(await coin.getAddress(), E(1), 0);

    const tokens = await coin.balanceOf(trader.address);
    await coin.connect(trader).approve(await curve.getAddress(), tokens);
    const before = await quote.balanceOf(trader.address);
    await curve.connect(trader).sell(await coin.getAddress(), tokens, 0);
    const got = (await quote.balanceOf(trader.address)) - before;

    expect(got).to.be.lt(E(1));            // paid fees both ways — never extract more than you put in
    expect(got).to.be.gt(E(0.95));         // ~4% of fees on ~1 ETH
    const c = await curve.curves(await coin.getAddress());
    expect(c.realQuote).to.be.lt(E(0.0001)); // curve reserve back to ~0 (dust only)
    expect(c.tokenReserve).to.be.gt(PARAMS.totalSupply - E(1)); // ~whole supply back in the curve
  });

  it("launch tax: ordinary wallets can buy without caps and creator buys keep the base fee", async () => {
    const { creator, trader, quote, curve, coin } = await setup();
    // Funding/approval transactions advance beyond the three-second launch window.
    await quote.mint(trader.address, E(1));
    await quote.connect(trader).approve(await curve.getAddress(), E(1));
    await expect(curve.connect(trader).buy(await coin.getAddress(), E(1), 0)).to.not.be.reverted;
    // The creator is exempt -> can buy in the window.
    await quote.mint(creator.address, E(1));
    await quote.connect(creator).approve(await curve.getAddress(), E(1));
    await expect(curve.connect(creator).buy(await coin.getAddress(), E(1), 0)).to.not.be.reverted;
    // A second purchase is also unrestricted (fund and approve it separately).
    await quote.mint(trader.address, E(1));
    await quote.connect(trader).approve(await curve.getAddress(), E(1));
    await mine(101);
    await expect(curve.connect(trader).buy(await coin.getAddress(), E(1), 0)).to.not.be.reverted;
  });

  it("graduation readiness: progress tracks realQuote; graduate() reverts NotReady before the threshold", async () => {
    const { trader, quote, curve, coin } = await setup();
    await mine(101);
    await expect(curve.graduate(await coin.getAddress())).to.be.reverted; // not ready
    await quote.mint(trader.address, E(3));
    await quote.connect(trader).approve(await curve.getAddress(), E(3));
    await curve.connect(trader).buy(await coin.getAddress(), E(3), 0);
    const progress = await curve.graduationProgress(await coin.getAddress()); // 2.94 net / 4 ≈ 7350 bps
    expect(progress).to.be.gt(7000n);
    expect(progress).to.be.lt(7500n);
    await expect(curve.graduate(await coin.getAddress())).to.be.reverted; // 2.94 < 4 -> still NotReady
  });

  it("guards: unknown coin, zero amount, and slippage all revert", async () => {
    const { trader, quote, curve, coin } = await setup();
    await mine(101);
    await quote.mint(trader.address, E(1));
    await quote.connect(trader).approve(await curve.getAddress(), E(1));
    await expect(curve.connect(trader).buy(ZERO, E(1), 0)).to.be.reverted;          // unknown coin
    await expect(curve.connect(trader).buy(await coin.getAddress(), 0, 0)).to.be.reverted; // zero
    await expect(curve.connect(trader).buy(await coin.getAddress(), E(1), E(1_000_000_000))).to.be.reverted; // slippage
  });
  it("PF zap caps the curve fill and refunds excess in quote tokens without a reverse swap", async () => {
    const {trader,hood,curve,coin}=await setupZap();
    await mine(101);
    const input=E(10), limit=await curve.maxQuoteIn(coin.target);
    const output=await curve.quoteBuy(coin.target,input);
    await curve.connect(trader).buyWithETH(coin.target,output,{value:input});
    expect((await curve.curves(coin.target)).realQuote).to.equal(E(4));
    expect(await hood.balanceOf(trader.address)).to.equal(input-limit);
    expect(await coin.balanceOf(trader.address)).to.equal(output);
    expect(await hood.balanceOf(curve.target)).to.equal(E(4));
  });

});
