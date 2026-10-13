// In-browser CREATE2 grind for the Delos vanity address, mirroring contracts/scripts/lib/grindSalt.js.
// LaunchFactoryV4 deploys the token via CREATE2 with this salt and enforces
// (uint160(token) & VANITY_MASK) == VANITY_SUFFIX: `…de105` on Delos factories. The Census-era factories
// enforced `…c0de` over 0xFFFF and expose no constants, so a factory that answers neither view is c0de.
// We compute the same address off-chain so the launch can reserve + show it and pass the salt.
import { keccak256, encodeAbiParameters, concatHex, toHex, getAddress, hexToBytes, bytesToHex, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { LAUNCH_TOKEN_BYTECODE } from "./launchTokenBytecode";

export type Vanity = { suffix: bigint; mask: bigint; hex: string; expectedTries: number };
export const DELOS_VANITY: Vanity = { suffix: 0xde105n, mask: 0xfffffn, hex: "de105", expectedTries: 0x100000 };
export const CENSUS_VANITY: Vanity = { suffix: 0xc0den, mask: 0xffffn, hex: "c0de", expectedTries: 0x10000 };
const VANITY_ABI = parseAbi(["function VANITY_SUFFIX() view returns (uint160)", "function VANITY_MASK() view returns (uint160)"]);

const vanityCache = new Map<string, Promise<Vanity>>();
// The suffix a factory enforces, read once per factory. A factory without the views is Census-era (c0de).
export function vanityOf(client: PublicClient, factory: Address): Promise<Vanity> {
  const key = factory.toLowerCase();
  let p = vanityCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const [suffix, mask] = await Promise.all([
          client.readContract({ address: factory, abi: VANITY_ABI, functionName: "VANITY_SUFFIX" }),
          client.readContract({ address: factory, abi: VANITY_ABI, functionName: "VANITY_MASK" }),
        ]);
        if (mask > 0xffffffn) throw new Error("mask wider than 24 bits");
        const hexChars = Math.ceil(mask.toString(2).length / 4);
        return { suffix, mask, hex: suffix.toString(16).padStart(hexChars, "0"), expectedTries: Number(mask) + 1 };
      } catch {
        return CENSUS_VANITY;
      }
    })();
    vanityCache.set(key, p);
  }
  return p;
}

// `creator` is the address that will send the launch tx. The factory binds the vanity address to it
// (CREATE2 salt = keccak256(salt, creator)), so a mempool watcher cannot reproduce the address and
// hijack the launch — see CX-F1. We must grind for the same creator that will sign.
export type C0deArgs = { name: string; symbol: string; totalSupply: bigint; decimals: number; factory: Address; creator: Address; vanity: Vanity };

// keccak256(LaunchToken creation bytecode ++ abi.encode(constructor args)) — the CREATE2 init-code hash.
export function initCodeHash({ name, symbol, totalSupply, decimals, factory }: Omit<C0deArgs, "creator" | "vanity">): Hex {
  const encoded = encodeAbiParameters(
    [{ type: "string" }, { type: "string" }, { type: "uint256" }, { type: "uint8" }, { type: "address" }],
    [name, symbol, totalSupply, decimals, factory],
  );
  return keccak256(concatHex([LAUNCH_TOKEN_BYTECODE, encoded]));
}

export const hasVanity = (addr: string, v: Vanity): boolean => (BigInt(addr) & v.mask) === v.suffix;

// Grind salts until the deployed address carries the factory's suffix (de105: ~1 in 1,048,576, so about
// 1M tries and ~10 s; c0de: ~65k tries). Two keccaks per try over fixed byte buffers, no hex round-trips.
// Yields to the event loop periodically so the UI stays responsive, reporting progress via onProgress(tries).
export async function grindC0de(
  args: C0deArgs,
  opts: { max?: number; onProgress?: (tries: number) => void } = {},
): Promise<{ salt: Hex; address: Address; tries: number }> {
  const v = args.vanity;
  const max = opts.max ?? v.expectedTries * 16; // P(miss) = e^-16
  const pre = new Uint8Array(52); // salt (32) ++ creator (20)  -> effective CREATE2 salt, as the factory derives it
  pre.set(hexToBytes(args.creator), 32);
  const c2 = new Uint8Array(85); // 0xff ++ factory (20) ++ effective salt (32) ++ init code hash (32)
  c2[0] = 0xff; c2.set(hexToBytes(args.factory), 1); c2.set(hexToBytes(initCodeHash(args)), 53);
  const maskN = Number(v.mask), suffixN = Number(v.suffix);
  for (let i = 0; i < max; i++) {
    pre[28] = (i >>> 24) & 0xff; pre[29] = (i >>> 16) & 0xff; pre[30] = (i >>> 8) & 0xff; pre[31] = i & 0xff;
    c2.set(keccak256(pre, "bytes"), 21);
    const out = keccak256(c2, "bytes"); // bytes 12..32 are the address
    if ((((out[29] << 16) | (out[30] << 8) | out[31]) & maskN) === suffixN) {
      return { salt: toHex(i, { size: 32 }), address: getAddress(bytesToHex(out.slice(12))), tries: i };
    }
    if (i % 2500 === 0) { opts.onProgress?.(i); await new Promise((r) => setTimeout(r, 0)); }
  }
  throw new Error(`${v.hex} grind exhausted`);
}
