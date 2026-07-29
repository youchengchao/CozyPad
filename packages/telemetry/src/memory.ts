import type { MemoryMetric } from '@cozypad/contracts';

export function toDouble(value: string): number {
  const parsed = Number.parseFloat(value.trim());
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 解析 MEMORY_COMMAND 的輸出：`used,total`（MB）。 */
export function parseMemoryMetric(output: string): MemoryMetric | null {
  const parts = output.split(',');
  if (parts.length < 2) return null;
  return { usedMb: toDouble(parts[0]!), totalMb: toDouble(parts[1]!) };
}
