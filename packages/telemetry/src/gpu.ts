import type { GpuMetric, GpuProcessMetric } from '@cozypad/contracts';
import { GPU_APP_SPLIT_MARKER, GPU_PS_SPLIT_MARKER } from './commands';
import { toDouble } from './memory';

interface GpuProcessMetadata {
  username: string;
  runtimeSeconds: number | null;
  commandLine: string;
}

/** 解析 GPU_COMMAND 的輸出：GPU CSV ＋ compute apps CSV ＋ ps join。 */
export function parseGpuTelemetry(output: string): GpuMetric[] {
  if (output.trim() === '') return [];

  const appSplit = output.split(GPU_APP_SPLIT_MARKER);
  const gpuText = appSplit[0] ?? '';
  const afterAppMarker = appSplit.length > 1 ? appSplit.slice(1).join(GPU_APP_SPLIT_MARKER) : '';
  const psSplit = afterAppMarker.split(GPU_PS_SPLIT_MARKER);
  const processText = psSplit[0] ?? '';
  const psText = psSplit.length > 1 ? psSplit.slice(1).join(GPU_PS_SPLIT_MARKER) : '';

  const processMetaByPid = new Map<number, GpuProcessMetadata>();
  for (const rawLine of psText.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || !line.startsWith('__PS__\t')) continue;
    const parts = line.split('\t');
    if (parts.length < 5) continue;
    const pid = Number.parseInt(parts[1]!.trim(), 10);
    if (Number.isNaN(pid)) continue;
    const runtime = Number.parseInt(parts[3]!.trim(), 10);
    processMetaByPid.set(pid, {
      username: parts[2]!.trim() === '' ? 'unknown' : parts[2]!.trim(),
      runtimeSeconds: Number.isNaN(runtime) ? null : runtime,
      commandLine: parts.slice(4).join('\t').trim(),
    });
  }

  const processesByUuid = new Map<string, GpuProcessMetric[]>();
  for (const rawLine of processText.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.toLowerCase().includes('no running processes')) continue;
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 4) continue;

    const uuid = parts[0]!;
    const pid = Number.parseInt(parts[1]!, 10) || 0;
    const processName = parts[2]!;
    const meta = processMetaByPid.get(pid);
    const commandLine =
      meta !== undefined && meta.commandLine.trim() !== '' ? meta.commandLine : processName;

    const process: GpuProcessMetric = {
      pid,
      username: meta?.username ?? 'unknown',
      processName,
      commandLine,
      usedMemoryMb: toDouble(parts[3]!),
      runtimeSeconds: meta?.runtimeSeconds ?? null,
    };
    const list = processesByUuid.get(uuid) ?? [];
    list.push(process);
    processesByUuid.set(uuid, list);
  }

  const items: GpuMetric[] = [];
  for (const rawLine of gpuText.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 7) continue;

    const uuid = parts[1]!;
    items.push({
      index: Number.parseInt(parts[0]!, 10) || items.length,
      uuid,
      name: parts[2]!,
      usage: toDouble(parts[3]!),
      memoryUsedMb: toDouble(parts[4]!),
      memoryTotalMb: toDouble(parts[5]!),
      temperature: toDouble(parts[6]!),
      processes: processesByUuid.get(uuid) ?? [],
    });
  }
  return items;
}
