/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_FACTORY_V4_ADDRESS?: string;
  readonly VITE_CURVE_V4_ADDRESS?: string;
  readonly VITE_V4_ROUTER?: string;
  readonly VITE_V4_HOOK?: string;
  readonly VITE_POOL_MANAGER?: string;
  readonly VITE_STATE_VIEW?: string;
  readonly VITE_V4_QUOTER?: string;
  readonly VITE_REHEARSAL_GRADUATION_ETH?: string; // rehearsal builds only: tiny graduation target (e.g. "0.02"); never set in production
  readonly VITE_TEST_STOCKS?: string; // testnet only: "TICKER:0xaddress,..." test stock contracts for the basket picker
  readonly VITE_QUOTER?: string;
  readonly VITE_FACTORY_ADDRESS?: string;
  readonly VITE_FACTORY_V2_ADDRESS?: string;
  readonly VITE_LOCKER_ADDRESS?: string;
  readonly VITE_CURVE_ADDRESS?: string;
  readonly VITE_WETH?: string;
  readonly VITE_SWAP_ROUTER?: string;
  readonly VITE_V3_FACTORY?: string;
  readonly VITE_ETH_PRICE_POOL?: string;
  readonly VITE_INDEXER_URL?: string;
  readonly VITE_FROM_BLOCK?: string;
  readonly VITE_ZEROX_PROXY?: string;
  readonly VITE_PRIVY_APP_ID?: string;
  readonly VITE_PRIVY_CLIENT_ID?: string;
  readonly VITE_PRIVY_LOGIN_METHODS?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
