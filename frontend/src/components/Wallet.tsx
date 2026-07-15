import { useAccount, useConnect, useDisconnect, useSwitchChain, useChainId } from "wagmi";
import { CHAIN } from "../config";

export function Wallet() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const chainId = useChainId();

  if (!isConnected) {
    const injected = connectors[0];
    return (
      <button className="btn" disabled={isPending} onClick={() => connect({ connector: injected })}>
        {isPending ? "Connecting…" : "Connect Wallet"}
      </button>
    );
  }

  const wrongChain = chainId !== CHAIN.id;
  return (
    <div className="wallet">
      {wrongChain && (
        <button className="btn warn" onClick={() => switchChain({ chainId: CHAIN.id })}>
          Switch to {CHAIN.name}
        </button>
      )}
      <span className="addr">{address?.slice(0, 6)}…{address?.slice(-4)}</span>
      <button className="btn ghost" onClick={() => disconnect()}>Disconnect</button>
    </div>
  );
}
