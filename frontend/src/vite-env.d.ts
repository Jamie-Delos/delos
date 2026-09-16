/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_RPC_URL?: string;
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
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
