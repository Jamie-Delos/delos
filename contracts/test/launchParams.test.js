const { expect } = require("chai");
const { computeLaunchParams, computeGraduationTick, isqrt } = require("../scripts/lib/launchParams");
const standardFor = require("../scripts/standards");

const WETH = "0x4200000000000000000000000000000000000006";
const WUSDC = "0x911b4000D3422F482F4062a913885f7b035382Df"; // Arc quote (18-dec)

describe("launchParams (off-chain tick math)", () => {
  it("isqrt matches known values", () => {
    expect(isqrt(0n)).to.equal(0n);
    expect(isqrt(1n)).to.equal(1n);
    expect(isqrt(15n)).to.equal(3n);
    expect(isqrt(16n)).to.equal(4n);
    expect(isqrt((1n << 192n))).to.equal(1n << 96n);
  });

  it("token sorting below WETH => token0 => range above start price", () => {
    const token = "0x0000000000000000000000000000000000000abc"; // < WETH numerically
    const p = computeLaunchParams({ token, weth: WETH, tokenDecimals: 18, fee: 3000, priceWethPerToken: 1e-8 });
    expect(p.tokenIsToken0).to.equal(true);
    expect(p.tickLower).to.be.lessThan(p.tickUpper);
    expect(BigInt(p.sqrtPriceX96)).to.be.greaterThan(0n);
  });

  it("token sorting above WETH => token1 => range below start price", () => {
    const token = "0xffffffffffffffffffffffffffffffffffffffff"; // > WETH numerically
    const p = computeLaunchParams({ token, weth: WETH, tokenDecimals: 18, fee: 3000, priceWethPerToken: 1e-8 });
    expect(p.tokenIsToken0).to.equal(false);
    expect(p.tickLower).to.be.lessThan(p.tickUpper);
  });

  it("ticks are aligned to the fee tier spacing", () => {
    const token = "0x0000000000000000000000000000000000000abc";
    const p = computeLaunchParams({ token, weth: WETH, tokenDecimals: 18, fee: 3000, priceWethPerToken: 1e-8 });
    expect(p.tickLower % 60).to.equal(0);
    expect(p.tickUpper % 60).to.equal(0);
  });

  it("Arc standard (USDC quote) produces valid single-sided params", () => {
    const std = standardFor("arc");
    const token = "0x0000000000000000000000000000000000000abc";
    const p = computeLaunchParams({ token, weth: WUSDC, tokenDecimals: 18, quoteDecimals: std.quoteDecimals, fee: std.fee, priceWethPerToken: std.launchPriceWethPerToken });
    const g = computeGraduationTick({ token, weth: WUSDC, tokenDecimals: 18, quoteDecimals: std.quoteDecimals, graduationPriceWethPerToken: std.graduationPriceWethPerToken });
    expect(p.tokenIsToken0).to.equal(true);
    expect(p.tickLower).to.be.lessThan(p.tickUpper);
    expect(BigInt(p.sqrtPriceX96)).to.be.greaterThan(0n);
    // graduation price > launch price, and token is token0 => graduation tick is above the current tick
    expect(g).to.be.greaterThan(p.tickLower - 60);
  });

  it("quoteDecimals actually changes the encoded price (18 vs 6)", () => {
    const token = "0x0000000000000000000000000000000000000abc";
    const p18 = computeLaunchParams({ token, weth: WUSDC, tokenDecimals: 18, quoteDecimals: 18, fee: 10000, priceWethPerToken: 1e-6 });
    const p6 = computeLaunchParams({ token, weth: WUSDC, tokenDecimals: 18, quoteDecimals: 6, fee: 10000, priceWethPerToken: 1e-6 });
    expect(p18.sqrtPriceX96).to.not.equal(p6.sqrtPriceX96);
    expect(p6.tickLower).to.be.lessThan(p6.tickUpper);
  });
});
