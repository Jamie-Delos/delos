/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FACTORY_ADDRESS?: string;
  readonly VITE_LOCKER_ADDRESS?: string;
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_WETH?: string;
  readonly VITE_SWAP_ROUTER?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
