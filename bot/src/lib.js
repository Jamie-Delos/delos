const { ethers } = require("ethers");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
];
const LOCKER_ABI = ["function collectFees(uint256 tokenId) returns (uint256 amount0,uint256 amount1)"];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];
const WETH_ABI = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"];

// Rebuild every holder's balance by replaying Transfer logs in chunked ranges (public-RPC safe).
async function discoverHolders(provider, tokenAddr, fromBlock, chunk, minBalance) {
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
  const latest = BigInt(await provider.getBlockNumber());
  const transfer = token.filters.Transfer();
  const balances = new Map();

  for (let start = fromBlock; start <= latest; start += chunk) {
    const end = start + chunk - 1n > latest ? latest : start + chunk - 1n;
    const logs = await token.queryFilter(transfer, start, end);
    for (const log of logs) {
      const { from, to, value } = log.args;
      if (from !== ethers.ZeroAddress) balances.set(from, (balances.get(from) ?? 0n) - value);
      if (to !== ethers.ZeroAddress) balances.set(to, (balances.get(to) ?? 0n) + value);
    }
  }

  const holders = [];
  for (const [addr, bal] of balances) {
    if (bal > 0n && bal >= minBalance) holders.push({ address: addr, balance: bal });
  }
  holders.sort((a, b) => (b.balance > a.balance ? 1 : -1));
  return holders;
}

// Proportionally split `total` across holders by balance weight. Remainder dust goes to the top holder.
function computeAirdrop(holders, total) {
  const totalWeight = holders.reduce((s, h) => s + h.balance, 0n);
  if (totalWeight === 0n) return [];
  let distributed = 0n;
  const rows = holders.map((h) => {
    const amount = (total * h.balance) / totalWeight;
    distributed += amount;
    return { address: h.address, amount };
  });
  const remainder = total - distributed;
  if (remainder > 0n && rows.length > 0) rows[0].amount += remainder;
  return rows.filter((r) => r.amount > 0n);
}

module.exports = { ERC20_ABI, LOCKER_ABI, ROUTER_ABI, WETH_ABI, discoverHolders, computeAirdrop };
