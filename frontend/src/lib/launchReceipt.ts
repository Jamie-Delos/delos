import { parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { factoryV4Abi } from "../abis";

export async function assertLaunchChain(client: PublicClient, chainId: number): Promise<void> {
  if (await client.getChainId() !== chainId) {
    throw new Error("The site's RPC is on the wrong network. The deployment configuration needs correcting.");
  }
}

// A timeout is unknown, never a failed launch. Callers keep the hash so they can resume checking
// without sending another transaction. A receipt with status=reverted is a definitive failure.
export async function confirmLaunch(client: PublicClient, hash: Hex, factory: Address, chainId: number) {
  await assertLaunchChain(client, chainId);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status === "reverted") return { status: "reverted" as const };
  const logs = receipt.logs.filter(log => log.address.toLowerCase() === factory.toLowerCase());
  const token = parseEventLogs({ abi: factoryV4Abi, eventName: "LaunchedV4", logs })[0]?.args.token;
  if (!token) throw new Error("No launch event was found. Check the transaction on the explorer before trying again.");
  return { status: "success" as const, token };
}
