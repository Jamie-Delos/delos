// In-browser CREATE2 grind for the Census "…c0de" vanity address, mirroring contracts/scripts/lib/grindSalt.js.
// The factory deploys the token via CREATE2 with this salt and enforces (uint160(token) & 0xFFFF) == 0xC0DE;
// we compute the same address off-chain so the launch can reserve + show it and pass the salt.
import { keccak256, encodeAbiParameters, encodePacked, concatHex, toHex, slice, getAddress, type Address, type Hex } from "viem";
import { LAUNCH_TOKEN_BYTECODE } from "./launchTokenBytecode";

// `creator` is the address that will send the launch tx. The factory binds the vanity address to it
// (CREATE2 salt = keccak256(salt, creator)), so a mempool watcher cannot reproduce the address and
// hijack the launch — see CX-F1. We must grind for the same creator that will sign.
export type C0deArgs = { name: string; symbol: string; totalSupply: bigint; decimals: number; factory: Address; creator: Address };

// keccak256(LaunchToken creation bytecode ++ abi.encode(constructor args)) — the CREATE2 init-code hash.
export function initCodeHash({ name, symbol, totalSupply, decimals, factory }: C0deArgs): Hex {
  const encoded = encodeAbiParameters(
    [{ type: "string" }, { type: "string" }, { type: "uint256" }, { type: "uint8" }, { type: "address" }],
    [name, symbol, totalSupply, decimals, factory],
  );
  return keccak256(concatHex([LAUNCH_TOKEN_BYTECODE, encoded]));
}

// Standard CREATE2: address = keccak256(0xff ++ deployer ++ salt ++ initCodeHash)[12:].
function create2(deployer: Address, salt: Hex, hash: Hex): Address {
  return getAddress(slice(keccak256(concatHex(["0xff", deployer, salt, hash])), 12));
}

export const isC0de = (addr: string): boolean => (BigInt(addr) & 0xffffn) === 0xc0den;

// Grind salts until the deployed address ends in c0de (~1 in 65,536, so ~65k tries on average). Yields to
// the event loop periodically so the UI stays responsive, reporting progress via onProgress(tries).
export async function grindC0de(
  args: C0deArgs,
  opts: { max?: number; onProgress?: (tries: number) => void } = {},
): Promise<{ salt: Hex; address: Address; tries: number }> {
  const hash = initCodeHash(args);
  const max = opts.max ?? 5_000_000;
  for (let i = 0; i < max; i++) {
    const salt = toHex(i, { size: 32 });
    // Mirror the factory: the on-chain CREATE2 salt is keccak256(abi.encodePacked(salt, creator)).
    const effectiveSalt = keccak256(encodePacked(["bytes32", "address"], [salt, args.creator]));
    const address = create2(args.factory, effectiveSalt, hash);
    if (isC0de(address)) return { salt, address, tries: i };
    if (i % 2500 === 0) { opts.onProgress?.(i); await new Promise((r) => setTimeout(r, 0)); }
  }
  throw new Error("c0de grind exhausted");
}
