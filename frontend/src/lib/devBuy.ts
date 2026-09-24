// Exact initial V4 curve arithmetic (CensusCurveV4.register / quoteBuyFor). The launch-time
// creator buy is exempt from the three-second penalty, but pays 2% base + reflection.
export function estimateDevBuy(args: {
  totalSupply: bigint; virtualQuote: bigint; graduationQuote: bigint;
  grossQuoteIn: bigint; reflectionBps: number;
}) {
  const { totalSupply: supply, virtualQuote: virtual, graduationQuote: graduation, grossQuoteIn: input, reflectionBps } = args;
  if (supply <= 0n || virtual <= 0n || graduation <= 0n || input <= 0n) return null;
  const feeBps = 200 + reflectionBps;
  if (feeBps >= 10000) return null;
  const cap = graduation * 10000n / BigInt(10000 - feeBps);
  const spent = input < cap ? input : cap;
  const fee = spent * BigInt(feeBps) / 10000n;
  const net = spent - fee;
  const offset = ((supply * virtual) / graduation * virtual) / (graduation + 2n * virtual);
  const tokens = (supply + offset) * net / (virtual + net);
  if (offset <= 0n || tokens <= 0n || tokens >= supply) return null;
  return { tokens, fee, spent, refund: input - spent, sharePercent: Number(tokens * 1000000n / supply) / 10000 };
}
