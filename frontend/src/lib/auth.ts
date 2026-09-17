// The one interface every "Connect wallet" / "Sign up" button talks to. Two implementations fill it:
//   - wallets only (census.tsx WalletsAuthProvider): our EIP-6963 picker, no sign-up — the default;
//   - Privy (privy.tsx, loaded only when VITE_PRIVY_APP_ID is set): external wallets through Privy's
//     modal, plus email/social sign-up that creates an embedded wallet on Robinhood Chain.
// Pages never import Privy directly, so the SDK stays out of the main bundle when it isn't configured.
import { createContext } from "react";

export type ConnectResult = { ok: boolean; error: string }; // error "" = the user just closed the modal

export type AuthSession = {
  method: string | null; // how the user signed in ("email jo…@gmail.com", "Google", …); null for a bare wallet
  embedded: boolean; // the active account is the embedded wallet Privy created at sign-up
};

export type AuthImpl = {
  provider: "wallets" | "privy";
  ready: boolean;
  connectWallet: () => Promise<ConnectResult>;
  signUp: (() => Promise<ConnectResult>) | null; // null when sign-up isn't configured
  signOut: () => Promise<void>;
  session: AuthSession;
  exportWallet: (() => Promise<void>) | null; // embedded wallets only: the user takes their own key
};

export const AuthContext = createContext<AuthImpl | null>(null);
