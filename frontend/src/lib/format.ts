export const short = (a?: string) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");

export function usd(n: number): string {
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

export function price(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.0001) return "$" + n.toExponential(2);
  return "$" + n.toPrecision(3);
}

export const pct = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(0) + "%";
