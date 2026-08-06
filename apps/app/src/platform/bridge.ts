import type { PlatformBridge } from '@cozypad/contracts';
import { createCapacitorBridge, getCapacitorPlugins } from './capacitorBridge';

let cached: PlatformBridge | null = null;

/**
 * 依執行環境選擇平台實作：
 * Electron preload 注入的 bridge → 手機原生 SSH plugin。
 */
export function getBridge(): PlatformBridge {
  if (cached !== null) return cached;

  if (window.cozypad !== undefined) {
    cached = window.cozypad;
    return cached;
  }

  const plugins = getCapacitorPlugins();
  if (plugins !== null) {
    cached = createCapacitorBridge(
      plugins.ssh,
      plugins.store,
      plugins.download,
    );
    return cached;
  }

  throw new Error(
    'No platform bridge available: run CozyPad through Electron or the mobile shell.',
  );
}
