// Per-network launch standard. `priceWethPerToken` means "quote units per whole token" — the quote
// is ETH on ETH-gas chains and USDC on Arc. Calibrated so every launch starts ~$3.6k mcap and
// graduates ~$60k mcap in the quote's dollar terms, leaving ~$11k of locked buy-side depth.
const DEFAULT = {
  quoteDecimals: 18,
  fee: 10000, // 1% tier
  launchPriceWethPerToken: 1.2e-9, // ETH quote (~$3000/ETH): ~1.2 ETH mcap ≈ $3.6k
  graduationPriceWethPerToken: 2.0e-8, // ~20 ETH mcap ≈ $60k
};

const PER_NETWORK = {
  // Arc: quote = WUSDC ≈ $1, 18 decimals. Same dollar targets → prices are ~3000× the ETH ones.
  arc: {
    quoteDecimals: 18,
    fee: 10000,
    launchPriceWethPerToken: 3.6e-6, // ~3,600 USDC mcap ≈ $3.6k
    graduationPriceWethPerToken: 6.0e-5, // ~60,000 USDC mcap ≈ $60k
  },
};

module.exports = function standardFor(netName) {
  return { ...DEFAULT, ...(PER_NETWORK[netName] || {}) };
};
