import type { CpuMetric } from '@cozypad/contracts';
import { CPU_SPLIT_MARKER } from './commands';

export interface CpuStat {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
}

function statTotal(stat: CpuStat): number {
  return (
    stat.user +
    stat.nice +
    stat.system +
    stat.idle +
    stat.iowait +
    stat.irq +
    stat.softirq +
    stat.steal
  );
}

function statIdleAll(stat: CpuStat): number {
  return stat.idle + stat.iowait;
}

/** index -1 代表整體（`cpu` 行），其餘為 `cpuN`。 */
export function parseProcStat(text: string): Map<number, CpuStat> {
  const result = new Map<number, CpuStat>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('cpu')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 8) continue;

    const label = parts[0]!;
    let index: number | null = null;
    if (label === 'cpu') index = -1;
    else if (/^cpu\d+$/.test(label)) index = Number(label.slice(3));
    if (index === null || Number.isNaN(index)) continue;

    const readInt = (position: number): number => {
      const value = parts[position];
      if (value === undefined) return 0;
      const parsed = Number.parseInt(value, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    };

    result.set(index, {
      user: readInt(1),
      nice: readInt(2),
      system: readInt(3),
      idle: readInt(4),
      iowait: readInt(5),
      irq: readInt(6),
      softirq: readInt(7),
      steal: readInt(8),
    });
  }
  return result;
}

export function calculateCpuUsage(before: CpuStat, after: CpuStat): number {
  const totalDiff = statTotal(after) - statTotal(before);
  const idleDiff = statIdleAll(after) - statIdleAll(before);
  if (totalDiff <= 0) return 0;
  const usage = ((totalDiff - idleDiff) / totalDiff) * 100;
  return Math.min(100, Math.max(0, usage));
}

/** 解析 CPU_COMMAND 的輸出（兩次 /proc/stat 取樣）。格式不符時回傳 null。 */
export function parseCpuMetric(output: string): CpuMetric | null {
  const parts = output.split(CPU_SPLIT_MARKER);
  if (parts.length < 2) return null;

  const before = parseProcStat(parts[0]!);
  const after = parseProcStat(parts[1]!);

  const totalBefore = before.get(-1);
  const totalAfter = after.get(-1);
  const totalUsage =
    totalBefore === undefined || totalAfter === undefined
      ? 0
      : calculateCpuUsage(totalBefore, totalAfter);

  const indexes = [...after.keys()].filter((key) => key >= 0).sort((a, b) => a - b);
  const cores = [];
  for (const index of indexes) {
    const beforeStat = before.get(index);
    const afterStat = after.get(index);
    if (beforeStat === undefined || afterStat === undefined) continue;
    cores.push({ index, usage: calculateCpuUsage(beforeStat, afterStat) });
  }

  return { totalUsage, cores };
}
