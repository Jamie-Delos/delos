/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FACTORY_ADDRESS?: string;
  readonly VITE_LOCKER_ADDRESS?: string;
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_WETH?: string;
  readonly VITE_SWAP_ROUTER?: string;
  readonly VITE_QUOTE_SYMBOL?: string;
  readonly VITE_QUOTE_DECIMALS?: string;
  readonly VITE_SWAP_DEADLINE?: string;
  readonly VITE_LAUNCH_PRICE?: string;
  readonly VITE_GRAD_PRICE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
