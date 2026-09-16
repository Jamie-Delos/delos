// The tokenised-stock catalogue on Robinhood Chain, grouped by sector, for the Maxima rewards basket.
// Trimmed to stocks with Uniswap V3 liquidity the vault can actually route into (direct WETH, or via the
// USDG hub) — the wizard also filters by STOCK_ROUTES, where each ticker's address + swap route lives.

export interface Stock { ticker: string; name: string; }
export interface StockCategory { label: string; stocks: Stock[]; }
export const STOCK_CATEGORIES: StockCategory[] = [
  { label: "Mega-cap tech", stocks: [
    { ticker: "NVDA", name: "NVIDIA" }, { ticker: "AAPL", name: "Apple" }, { ticker: "MSFT", name: "Microsoft" },
    { ticker: "GOOGL", name: "Alphabet" }, { ticker: "META", name: "Meta" }, { ticker: "AMZN", name: "Amazon" },
    { ticker: "TSLA", name: "Tesla" }, { ticker: "NFLX", name: "Netflix" },
  ] },
  { label: "Semiconductors", stocks: [
    { ticker: "TSM", name: "TSMC" }, { ticker: "MU", name: "Micron" }, { ticker: "AMD", name: "AMD" },
    { ticker: "SNDK", name: "SanDisk" }, { ticker: "INTC", name: "Intel" }, { ticker: "QUBT", name: "Quantum Computing" },
  ] },
  { label: "Retail & meme", stocks: [
    { ticker: "MRVL", name: "Marvell" }, { ticker: "RDDT", name: "Reddit" }, { ticker: "DJT", name: "Trump Media" },
    { ticker: "GME", name: "GameStop" }, { ticker: "AMC", name: "AMC" }, { ticker: "RBLX", name: "Roblox" },
    { ticker: "SNAP", name: "Snap" }, { ticker: "COIN", name: "Coinbase" }, { ticker: "MSTR", name: "Strategy" },
    { ticker: "PLTR", name: "Palantir" }, { ticker: "HIMS", name: "Hims & Hers" }, { ticker: "RIVN", name: "Rivian" },
    { ticker: "CRCL", name: "Circle" }, { ticker: "LULU", name: "Lululemon" },
  ] },
  { label: "ETFs & commodities", stocks: [
    { ticker: "QQQ", name: "Nasdaq-100 ETF" }, { ticker: "SPY", name: "S&P 500 ETF" }, { ticker: "GLD", name: "Gold" },
    { ticker: "SLV", name: "Silver" }, { ticker: "USO", name: "Oil" }, { ticker: "SGOV", name: "T-Bills ETF" },
  ] },
  { label: "Pharma & health", stocks: [
    { ticker: "LLY", name: "Eli Lilly" }, { ticker: "PFE", name: "Pfizer" }, { ticker: "MRNA", name: "Moderna" },
    { ticker: "JNJ", name: "Johnson & Johnson" },
  ] },
  { label: "Aerospace & defense", stocks: [
    { ticker: "BA", name: "Boeing" }, { ticker: "RCAT", name: "Red Cat" },
  ] },
  { label: "Private & other", stocks: [
    { ticker: "SPCX", name: "SpaceX" }, { ticker: "FIG", name: "Figma" }, { ticker: "BABA", name: "Alibaba" },
    { ticker: "NET", name: "Cloudflare" }, { ticker: "DELL", name: "Dell" }, { ticker: "IBM", name: "IBM" },
    { ticker: "COST", name: "Costco" }, { ticker: "TTWO", name: "Take-Two" }, { ticker: "F", name: "Ford" },
    { ticker: "UPS", name: "UPS" }, { ticker: "USAR", name: "USA Rare Earth" },
  ] },
];
