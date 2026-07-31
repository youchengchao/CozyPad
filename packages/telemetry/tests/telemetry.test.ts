import { describe, expect, it } from 'vitest';
import {
  CPU_SPLIT_MARKER,
  GPU_APP_SPLIT_MARKER,
  GPU_PS_SPLIT_MARKER,
  calculateCpuUsage,
  parseCpuMetric,
  parseGpuTelemetry,
  parseMemoryMetric,
  parseProcStat,
} from '../src/index';

const PROC_STAT_BEFORE = [
  'cpu  1000 50 300 5000 200 10 20 5 0 0',
  'cpu0 500 25 150 2500 100 5 10 2 0 0',
  'cpu1 500 25 150 2500 100 5 10 3 0 0',
  'intr 12345',
  'ctxt 999',
].join('\n');

const PROC_STAT_AFTER = [
  'cpu  1100 55 330 5400 210 11 22 6 0 0',
  'cpu0 550 27 165 2700 105 5 11 3 0 0',
  'cpu1 550 28 165 2700 105 6 11 3 0 0',
].join('\n');

describe('parseProcStat', () => {
  it('parses aggregate and per-core lines', () => {
    const stats = parseProcStat(PROC_STAT_BEFORE);
    expect(stats.get(-1)?.user).toBe(1000);
    expect(stats.get(0)?.idle).toBe(2500);
    expect(stats.get(1)?.steal).toBe(3);
    expect(stats.has(2)).toBe(false);
  });

  it('ignores malformed lines', () => {
    const stats = parseProcStat('cpu short\ncpufoo 1 2 3 4 5 6 7 8\n');
    expect(stats.size).toBe(0);
  });
});

describe('calculateCpuUsage', () => {
  it('computes usage from two samples', () => {
    const before = parseProcStat(PROC_STAT_BEFORE).get(-1)!;
    const after = parseProcStat(PROC_STAT_AFTER).get(-1)!;
    // totalDiff = 549, idleDiff = 410 → (549-410)/549 ≈ 25.3%
    expect(calculateCpuUsage(before, after)).toBeCloseTo(25.32, 1);
  });

  it('returns 0 when total does not advance', () => {
    const stat = parseProcStat(PROC_STAT_BEFORE).get(-1)!;
    expect(calculateCpuUsage(stat, stat)).toBe(0);
  });
});

describe('parseCpuMetric', () => {
  it('parses the two-sample command output', () => {
    const metric = parseCpuMetric(
      `${PROC_STAT_BEFORE}\n${CPU_SPLIT_MARKER}\n${PROC_STAT_AFTER}`,
    )!;
    expect(metric.totalUsage).toBeGreaterThan(0);
    expect(metric.cores).toHaveLength(2);
    expect(metric.cores[0]?.index).toBe(0);
  });

  it('returns null when the marker is missing', () => {
    expect(parseCpuMetric(PROC_STAT_BEFORE)).toBeNull();
  });
});

describe('parseMemoryMetric', () => {
  it('parses used,total in MB', () => {
    expect(parseMemoryMetric('18234,64213')).toEqual({ usedMb: 18234, totalMb: 64213 });
  });

  it('returns null on malformed output', () => {
    expect(parseMemoryMetric('command not found')).toBeNull();
  });
});

const GPU_UUID_0 = 'GPU-aaaa-bbbb';
const GPU_UUID_1 = 'GPU-cccc-dddd';

const GPU_OUTPUT = [
  `0, ${GPU_UUID_0}, NVIDIA GeForce RTX 4090, 36, 18432, 24564, 61`,
  `1, ${GPU_UUID_1}, NVIDIA GeForce RTX 4090, [N/A], 18201, 24564, 58`,
  GPU_APP_SPLIT_MARKER,
  `${GPU_UUID_0}, 41233, python, 18102`,
  `${GPU_UUID_0}, 41890, python, 2210`,
  GPU_PS_SPLIT_MARKER,
  '__PS__\t41233\tycchao\t7215\tpython train.py --config configs/base.yaml',
  '__PS__\t41890\t\t120\tpython eval.py',
  '__PS__\t1\troot\t99999\t/sbin/init',
].join('\n');

describe('parseGpuTelemetry', () => {
  it('parses GPUs and joins process metadata from ps', () => {
    const gpus = parseGpuTelemetry(GPU_OUTPUT);
    expect(gpus).toHaveLength(2);

    const first = gpus[0]!;
    expect(first.uuid).toBe(GPU_UUID_0);
    expect(first.usage).toBe(36);
    expect(first.memoryTotalMb).toBe(24564);
    expect(first.processes).toHaveLength(2);
    expect(first.processes[0]).toEqual({
      pid: 41233,
      username: 'ycchao',
      processName: 'python',
      commandLine: 'python train.py --config configs/base.yaml',
      usedMemoryMb: 18102,
      runtimeSeconds: 7215,
    });
  });

  it('treats [N/A] values as 0 and defaults missing ps user to unknown', () => {
    const gpus = parseGpuTelemetry(GPU_OUTPUT);
    expect(gpus[1]?.usage).toBe(0);
    const orphan = gpus[0]!.processes[1]!;
    expect(orphan.username).toBe('unknown');
  });

  it('returns empty for hosts without nvidia-smi', () => {
    expect(parseGpuTelemetry('')).toEqual([]);
    expect(parseGpuTelemetry('  \n')).toEqual([]);
  });

  it('skips the "No running processes found" line', () => {
    const output = [
      `0, ${GPU_UUID_0}, RTX, 10, 1, 2, 50`,
      GPU_APP_SPLIT_MARKER,
      'No running processes found',
      GPU_PS_SPLIT_MARKER,
    ].join('\n');
    expect(parseGpuTelemetry(output)[0]?.processes).toEqual([]);
  });
});
