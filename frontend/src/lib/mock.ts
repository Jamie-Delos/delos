// Placeholder catalogue + activity so the UI looks populated like the design. Swapped for real
// on-chain data (Launched events, pool state, an indexer) in a later phase.
export interface Coin {
  address: string;
  emoji: string;
  name: string;
  symbol: string;
  creator: string;
  age: string;
  mcap: number;
  price: number;
  change24: number;
  replies: number;
  desc: string;
  trending?: boolean;
  koth?: boolean;
}

export const COINS: Coin[] = [
  { address: "0x7a3f00000000000000000000000000000000d9c2", emoji: "🐮", name: "Bullko", symbol: "BULLKO", creator: "0xBVWhAU", age: "39m", mcap: 15200, price: 0.0000152, change24: 142, replies: 64, desc: "the most bullish cow on robinhood chain. moo or be moo'd.", trending: true, koth: true },
  { address: "0x0000000000000000000000000000000000basedd", emoji: "🅱️", name: "BASEDD House", symbol: "BASEDD", creator: "0x1f9c22", age: "1h", mcap: 5100000, price: 0.0051, change24: 61, replies: 158, desc: "streamer collective. based house assemble.", trending: true },
  { address: "0x0000000000000000000000000000000000rasmr1", emoji: "🥴", name: "rasmr", symbol: "RASMR", creator: "0x9ab331", age: "2h", mcap: 8900000, price: 0.0089, change24: -12, replies: 129, desc: "rasmr launches official. whisper it.", trending: true },
  { address: "0x0000000000000000000000000000000monitor01", emoji: "🕵️", name: "Monitoring the Situation", symbol: "MONITOR", creator: "0x77aa02", age: "3h", mcap: 1200000, price: 0.0012, change24: 33, replies: 218, desc: "ct monitoring the situation from the shadows.", trending: true },
  { address: "0x0000000000000000000000000000000000giga11", emoji: "🗿", name: "Gigachad", symbol: "GIGA", creator: "0xKp0tR2", age: "12m", mcap: 83600, price: 0.0000836, change24: 88, replies: 41, desc: "yes." },
  { address: "0x0000000000000000000000000000000000melon1", emoji: "🍉", name: "Watermelon", symbol: "MELON", creator: "0x3480bc", age: "22m", mcap: 42000, price: 0.000042, change24: -5, replies: 12, desc: "juicy. seedless. going up." },
  { address: "0x0000000000000000000000000000000000neko11", emoji: "🐈", name: "Neko", symbol: "NEKO", creator: "0x51abaa", age: "44m", mcap: 9800, price: 0.0000098, change24: 210, replies: 7, desc: "cat coin. nine lives, one chart." },
];

// Tokenized-stock pairing menu (mock subset of the 130+ live on Robinhood Chain). Real build reads
// the liquid set from the on-chain registry.
export interface Stock { ticker: string; name: string; color: string; }
export const STOCKS: Stock[] = [
  { ticker: "NVDA", name: "NVIDIA", color: "#76b900" },
  { ticker: "TSLA", name: "Tesla", color: "#e82127" },
  { ticker: "AAPL", name: "Apple", color: "#a2aaad" },
  { ticker: "MSFT", name: "Microsoft", color: "#00a4ef" },
  { ticker: "GOOGL", name: "Alphabet", color: "#4285f4" },
  { ticker: "AMZN", name: "Amazon", color: "#ff9900" },
  { ticker: "META", name: "Meta", color: "#0866ff" },
  { ticker: "SPCX", name: "SpaceX (private)", color: "#005288" },
  { ticker: "COST", name: "Costco", color: "#e31837" },
  { ticker: "MRVL", name: "Marvell", color: "#00a3e0" },
  { ticker: "MSTR", name: "Strategy", color: "#f7931a" },
  { ticker: "GME", name: "GameStop", color: "#ed1c24" },
  { ticker: "SPY", name: "S&P 500 ETF", color: "#5eead4" },
  { ticker: "QQQ", name: "Nasdaq-100 ETF", color: "#8b5cf6" },
  { ticker: "GLD", name: "Gold ETF", color: "#f4d47a" },
  { ticker: "LLY", name: "Eli Lilly", color: "#d52b1e" },
];

export const HOLDERS = [
  { color: "#2dd4bf", label: "locked pool (bonding)", pct: 78.4 },
  { color: "#5eead4", label: "dev wallet", pct: 4.2, dev: true },
  { color: "#6ee7b0", label: "0x9ab…331", pct: 3.1 },
  { color: "#aab2c0", label: "0x77a…a02", pct: 2.6 },
  { color: "#7b8494", label: "others (214)", pct: 11.7 },
];

export const THREAD = [
  { avatar: "🐮", name: "bullrunner", dev: true, age: "38m", body: "liquidity locked forever ser. aped my own bag. wagmi 🐮" },
  { avatar: "🥶", name: "paperhands", dev: false, age: "31m", body: "sold the top, buying back lower (cope)" },
  { avatar: "🚀", name: "moonboi", dev: false, age: "12m", body: "wen graduation" },
];

const NAMES = ["Bullko", "GIGA", "NEH", "Wibbidi", "rasmr", "MELON", "NEKO"];
const ADDRS = ["Kp0tR2", "Ap3Rtz", "Gny7UM", "BVWhAU", "9xQ2ee", "3480bc"];
const rnd = (arr: string[], i: number) => arr[i % arr.length];

// Deterministic pseudo-random tape events (index-seeded to avoid Math.random in some runtimes).
export function makeEvent(i: number) {
  const kind = ["buy", "sell", "create"][i % 3] as "buy" | "sell" | "create";
  const who = rnd(ADDRS, i * 3 + 1);
  const tok = rnd(NAMES, i * 5 + 2);
  const amt = (((i * 733) % 1900) / 10000 + 0.01).toFixed(4);
  const mc = (((i * 271) % 900) + 30).toFixed(1);
  const text =
    kind === "create" ? `${who} created ${tok}` :
    kind === "buy" ? `${who} bought ${amt} ETH of ${tok}` :
    `${who} sold ${amt} ETH of ${tok}`;
  return { id: i, kind, text, mc: `$${mc}K` };
}
