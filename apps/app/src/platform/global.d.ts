import type { PlatformBridge } from '@cozypad/contracts';

declare global {
  interface Window {
    /** Electron preload 或 Capacitor 注入的 bridge；瀏覽器模式下不存在。 */
    cozypad?: PlatformBridge;
  }
}

export {};
