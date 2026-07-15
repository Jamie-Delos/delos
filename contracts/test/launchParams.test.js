const { expect } = require("chai");
const { computeLaunchParams, isqrt } = require("../scripts/lib/launchParams");

const WETH = "0x4200000000000000000000000000000000000006";

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
});
