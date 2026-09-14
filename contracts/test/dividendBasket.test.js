const { expect } = require("chai");
const hre = require("hardhat");
const E = (n) => hre.ethers.parseEther(String(n));
const ZERO = "0x0000000000000000000000000000000000000000";

// Proves the "unified model": a coin quoted in a NON-WETH asset (e.g. HOOD) can still pay holders a
// multi-stock dividend basket. The DividendVault swaps its quote fee asset into each basket stock via the
// per-stock V3 path, then holders claim pro-rata. (Contract was already general; this pins that HOOD is
// no different from WETH here — the only thing that changes is the swap path, built in the frontend.)
describe("DividendVault — HOOD-quoted coin pays a stock basket (unified model)", () => {
  async function setup() {
    const [deployer, holderA, holderB] = await hre.ethers.getSigners();
    const ERC20 = await hre.ethers.getContractFactory("MockERC20");

    const hood = await ERC20.deploy("Robinhood", "HOOD"); await hood.waitForDeployment(); // the quote/fee asset
    const stockA = await ERC20.deploy("NVIDIA", "NVDA"); await stockA.waitForDeployment();
    const stockB = await ERC20.deploy("Apple", "AAPL"); await stockB.waitForDeployment();
    const token = await ERC20.deploy("Zap Coin", "ZAP"); await token.waitForDeployment();
    const router = await (await hre.ethers.getContractFactory("MockSwapRouter")).deploy(); await router.waitForDeployment();

    // Router inventory to pay out both swaps (1:1).
    await (await stockA.mint(await router.getAddress(), E(1_000))).wait();
    await (await stockB.mint(await router.getAddress(), E(1_000))).wait();

    // HOOD-quoted vault with a 60/40 NVDA/AAPL basket; paths route HOOD -> stock (mock reads first/last).
    const A = await stockA.getAddress(), B = await stockB.getAddress(), H = await hood.getAddress();
    const pathA = hre.ethers.solidityPacked(["address", "uint24", "address"], [H, 10000, A]);
    const pathB = hre.ethers.solidityPacked(["address", "uint24", "address"], [H, 10000, B]);
    const Vault = await hre.ethers.getContractFactory("DividendVault");
    const vault = await Vault.deploy(H, await router.getAddress(), 3000, [A, B], [6000, 4000], [pathA, pathB], ZERO);
    await vault.waitForDeployment();

    // Holders: 60 / 40 of the coin. Vault wired to the token, deployer is the distribution operator.
    await (await token.mint(holderA.address, E(60))).wait();
    await (await token.mint(holderB.address, E(40))).wait();
    await (await vault.init(await token.getAddress(), [], deployer.address)).wait();

    return { deployer, holderA, holderB, hood, stockA, stockB, token, vault };
  }

  it("swaps the HOOD fee into the basket and pays holders pro-rata", async () => {
    const { holderA, holderB, hood, stockA, stockB, vault } = await setup();

    // 10 HOOD of holder fees arrive at the vault, then distribute() swaps 60% -> NVDA, 40% -> AAPL.
    await (await hood.mint(await vault.getAddress(), E(10))).wait();
    await (await vault.distribute([E(6), E(4)])).wait();

    // holderA holds 60% of supply -> 60% of each stock line (60% of 6 NVDA, 60% of 4 AAPL).
    expect(await vault.withdrawableOf(holderA.address, await stockA.getAddress())).to.equal(E(3.6));
    expect(await vault.withdrawableOf(holderA.address, await stockB.getAddress())).to.equal(E(2.4));
    expect(await vault.withdrawableOf(holderB.address, await stockA.getAddress())).to.equal(E(2.4));
    expect(await vault.withdrawableOf(holderB.address, await stockB.getAddress())).to.equal(E(1.6));

    // Claim pays the real stock tokens out of the vault.
    await (await vault.connect(holderA).claim()).wait();
    expect(await stockA.balanceOf(holderA.address)).to.equal(E(3.6));
    expect(await stockB.balanceOf(holderA.address)).to.equal(E(2.4));
  });

  it("still supports 'holders earn HOOD' — a basket member equal to the quote is a passthrough", async () => {
    // basket = [HOOD] with an empty path: distribute() credits it straight through, no swap.
    const [deployer, holderA] = await hre.ethers.getSigners();
    const ERC20 = await hre.ethers.getContractFactory("MockERC20");
    const hood = await ERC20.deploy("Robinhood", "HOOD"); await hood.waitForDeployment();
    const token = await ERC20.deploy("Zap Coin", "ZAP"); await token.waitForDeployment();
    const router = await (await hre.ethers.getContractFactory("MockSwapRouter")).deploy(); await router.waitForDeployment();
    const H = await hood.getAddress();
    const Vault = await hre.ethers.getContractFactory("DividendVault");
    const vault = await Vault.deploy(H, await router.getAddress(), 3000, [H], [10000], ["0x"], ZERO);
    await vault.waitForDeployment();
    await (await token.mint(holderA.address, E(100))).wait();
    await (await vault.init(await token.getAddress(), [], deployer.address)).wait();

    await (await hood.mint(await vault.getAddress(), E(5))).wait();
    await (await vault.distribute([0])).wait();
    expect(await vault.withdrawableOf(holderA.address, H)).to.equal(E(5)); // 100% holder gets all 5 HOOD
  });
});
