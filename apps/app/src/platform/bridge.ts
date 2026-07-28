import type { PlatformBridge } from '@cozypad/contracts';
import { createMockBridge } from './mockBridge';

let cached: PlatformBridge | null = null;

/** shell 注入的 bridge 優先；沒有（純瀏覽器開發）就用 mock。 */
export function getBridge(): PlatformBridge {
  cached ??= window.cozypad ?? createMockBridge();
  return cached;
}
