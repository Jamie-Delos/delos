// Privy: email / social sign-up with an embedded wallet, alongside "Connect wallet" for people who
// already have one. Loaded lazily by main.tsx only when VITE_PRIVY_APP_ID is set, so without it the
// SDK never reaches the browser. Wagmi keeps working unchanged: @privy-io/wagmi drives wagmi's
// connector state from Privy, so every page's useAccount / useWriteContract / useSignMessage talks to
// whichever wallet is active — an extension or the embedded wallet.
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { PrivyProvider, useConnectWallet, useCreateWallet, useExportWallet, useLogin, useLogout, useModalStatus, usePrivy, useWallets, type PrivyClientConfig, type User } from "@privy-io/react-auth";
import { WagmiProvider, createConfig, useSetActiveWallet } from "@privy-io/wagmi";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { http, useAccount, useConnections, useDisconnect } from "wagmi";
import { CHAIN, PRIVY_APP_ID, PRIVY_CLIENT_ID, PRIVY_LOGIN_METHODS } from "./config";
import { AuthContext, type AuthImpl, type ConnectResult } from "./lib/auth";

const privyWagmiConfig = createConfig({ chains: [CHAIN], transports: { [CHAIN.id]: http() } });

type LoginMethod = NonNullable<PrivyClientConfig["loginMethods"]>[number];
const loginMethods = PRIVY_LOGIN_METHODS as LoginMethod[];

const privyConfig: PrivyClientConfig = {
  appearance: {
    theme: "#07130d", // Census ground
    accentColor: "#b4f03d", // the one accent
    logo: `${window.location.origin}/delos-mark.svg`,
    landingHeader: "Sign up to Delos",
    loginMessage: `We create a wallet on ${CHAIN.name} for you. You can export its key any time.`,
    showWalletLoginFirst: false,
    walletChainType: "ethereum-only",
    walletList: ["detected_ethereum_wallets", "metamask", "phantom", "rabby_wallet", "robinhood_wallet", "coinbase_wallet", "wallet_connect"],
  },
  loginMethods,
  embeddedWallets: {
    ethereum: { createOnLogin: "users-without-wallets" },
    showWalletUIs: true, // every signature/transaction from the embedded wallet shows a confirmation
  },
  defaultChain: CHAIN,
  supportedChains: [CHAIN],
};

// "exited_auth_flow" and friends: the user closed the modal — not an error worth showing.
const isExit = (e: unknown) => /exit|cancel|closed|reject/i.test(String(e ?? ""));

function sessionMethod(user: User | null): string | null {
  if (!user) return null;
  if (user.email?.address) return `email ${user.email.address}`;
  if (user.google?.email) return `Google (${user.google.email})`;
  if (user.apple?.email) return `Apple (${user.apple.email})`;
  if (user.twitter?.username) return `X (@${user.twitter.username})`;
  if (user.phone?.number) return `phone ${user.phone.number}`;
  return "Privy";
}

function PrivyAuthBridge({ children }: { children: ReactNode }) {
  const { ready, authenticated, user } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { exportWallet } = useExportWallet();
  const { logout } = useLogout();
  const { address } = useAccount();
  const connections = useConnections();
  const { disconnectAsync } = useDisconnect();

  // One modal at a time: each call parks its resolver here until Privy reports success or exit.
  const pending = useRef<((r: ConnectResult) => void) | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settle = (r: ConnectResult) => {
    if (watchdog.current) { clearTimeout(watchdog.current); watchdog.current = null; }
    const p = pending.current; pending.current = null; p?.(r);
  };
  const preferEmbedded = useRef(false);

  // Never leave a button stuck on "Connecting…": if Privy's modal hasn't opened within 15s the call fails
  // with a retryable message, and if the modal closes without Privy reporting back, the call settles.
  const { isOpen: modalOpen } = useModalStatus();
  const wasOpen = useRef(false);
  const modalOpenRef = useRef(modalOpen);
  modalOpenRef.current = modalOpen;
  useEffect(() => {
    if (modalOpen) wasOpen.current = true;
    else if (wasOpen.current) {
      wasOpen.current = false;
      // Give Privy's own onSuccess/onError a beat to arrive first.
      setTimeout(() => { if (pending.current) settle({ ok: false, error: "" }); }, 400);
    }
  }, [modalOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const armWatchdog = () => {
    if (watchdog.current) clearTimeout(watchdog.current);
    watchdog.current = setTimeout(() => {
      if (pending.current && !modalOpenRef.current) settle({ ok: false, error: "The wallet window didn't open — check your connection and try again." });
    }, 15000);
  };

  const { connectWallet } = useConnectWallet({
    onSuccess: ({ wallet }) => {
      settle({ ok: true, error: "" }); // first, so the modal-close watcher can't report a cancel
      // The wallet just connected becomes the one wagmi (and so every page) uses.
      const connected = wallets.find((w) => w.address.toLowerCase() === wallet.address.toLowerCase());
      if (connected) setActiveWallet(connected).catch(() => { /* wagmi keeps its current wallet */ });
    },
    onError: (e) => settle({ ok: false, error: isExit(e) ? "" : "Couldn't connect that wallet — try again." }),
  });

  const { login } = useLogin({
    onComplete: () => { preferEmbedded.current = true; settle({ ok: true, error: "" }); },
    onError: (e) => settle({ ok: false, error: isExit(e) ? "" : "Sign up didn't complete — try again." }),
  });

  // After a sign-up the embedded wallet appears a moment later; make it the active wallet when it does.
  useEffect(() => {
    if (!preferEmbedded.current || !walletsReady) return;
    const embedded = wallets.find((w) => w.walletClientType === "privy");
    if (!embedded) return;
    preferEmbedded.current = false;
    setActiveWallet(embedded).catch(() => { /* stays on the previous wallet */ });
  }, [wallets, walletsReady, setActiveWallet]);

  // Safety net: the SDK config asks Privy to create the wallet at sign-up, but if the dashboard's own
  // setting wins, a signed-in user could end up with no wallet at all. Give Privy a moment, then create it.
  const { createWallet } = useCreateWallet();
  const creating = useRef(false);
  useEffect(() => {
    if (!ready || !authenticated || !walletsReady || !user || creating.current) return;
    if (user.linkedAccounts.some((a) => a.type === "wallet")) return;
    const t = setTimeout(() => {
      creating.current = true;
      preferEmbedded.current = true;
      createWallet().catch(() => { /* already created by the modal flow */ }).finally(() => { creating.current = false; });
    }, 2500);
    return () => clearTimeout(t);
  }, [ready, authenticated, walletsReady, user, createWallet]);

  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const activeIsEmbedded = !!embedded && !!address && embedded.address.toLowerCase() === address.toLowerCase();

  const impl = useMemo<AuthImpl>(() => ({
    provider: "privy",
    ready,
    connectWallet: () => new Promise<ConnectResult>((resolve) => {
      if (!ready) { resolve({ ok: false, error: "Wallet connect is still loading — try again in a moment." }); return; }
      settle({ ok: false, error: "" });
      pending.current = resolve;
      armWatchdog();
      connectWallet({ walletChainType: "ethereum-only", description: `Connect a wallet on ${CHAIN.name}` });
    }),
    signUp: () => new Promise<ConnectResult>((resolve) => {
      if (!ready) { resolve({ ok: false, error: "Sign up is still loading — try again in a moment." }); return; }
      if (authenticated) { preferEmbedded.current = true; resolve({ ok: true, error: "" }); return; }
      settle({ ok: false, error: "" });
      pending.current = resolve;
      armWatchdog();
      login({ loginMethods });
    }),
    signOut: async () => {
      // Extensions (MetaMask, Phantom, Rabby…) can't be disconnected programmatically and keep reporting
      // their account, so Privy would re-detect them at once. Disconnecting through wagmi marks each
      // connector "disconnected" in storage, which Privy's wagmi adapter honours until the user connects
      // again. WalletConnect and Coinbase sessions can really be closed, so close those too.
      for (const c of connections) { try { await disconnectAsync({ connector: c.connector }); } catch { /* already gone */ } }
      for (const w of wallets) {
        if (w.walletClientType === "privy" || w.connectorType === "injected") continue;
        try { w.disconnect(); } catch { /* session already closed */ }
      }
      if (authenticated) await logout();
    },
    session: { method: authenticated ? sessionMethod(user) : null, embedded: activeIsEmbedded },
    exportWallet: authenticated && embedded ? async () => { await exportWallet({ address: embedded.address }); } : null,
  }), [ready, authenticated, user, wallets, connections, embedded, activeIsEmbedded, connectWallet, login, logout, disconnectAsync, exportWallet]); // eslint-disable-line react-hooks/exhaustive-deps

  return <AuthContext.Provider value={impl}>{children}</AuthContext.Provider>;
}

export function PrivyRoot({ queryClient, children }: { queryClient: QueryClient; children: ReactNode }) {
  return (
    <PrivyProvider appId={PRIVY_APP_ID} clientId={PRIVY_CLIENT_ID} config={privyConfig}>
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={privyWagmiConfig}>
          <PrivyAuthBridge>{children}</PrivyAuthBridge>
        </WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
