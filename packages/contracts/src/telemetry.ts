import { z } from 'zod';

export const CpuCoreMetricSchema = z.object({
  index: z.number().int(),
  usage: z.number(),
});
export type CpuCoreMetric = z.infer<typeof CpuCoreMetricSchema>;

export const CpuMetricSchema = z.object({
  totalUsage: z.number(),
  cores: z.array(CpuCoreMetricSchema),
});
export type CpuMetric = z.infer<typeof CpuMetricSchema>;

export const MemoryMetricSchema = z.object({
  usedMb: z.number(),
  totalMb: z.number(),
});
export type MemoryMetric = z.infer<typeof MemoryMetricSchema>;

export const GpuProcessMetricSchema = z.object({
  pid: z.number().int(),
  username: z.string(),
  processName: z.string(),
  commandLine: z.string(),
  usedMemoryMb: z.number(),
  runtimeSeconds: z.number().int().nullable(),
});
export type GpuProcessMetric = z.infer<typeof GpuProcessMetricSchema>;

export const GpuMetricSchema = z.object({
  index: z.number().int(),
  uuid: z.string(),
  name: z.string(),
  usage: z.number(),
  memoryUsedMb: z.number(),
  memoryTotalMb: z.number(),
  temperature: z.number(),
  processes: z.array(GpuProcessMetricSchema),
});
export type GpuMetric = z.infer<typeof GpuMetricSchema>;

export const TelemetrySnapshotSchema = z.object({
  profileId: z.string().min(1),
  timestamp: z.string(),
  cpu: CpuMetricSchema.nullable(),
  memory: MemoryMetricSchema.nullable(),
  /** 遠端沒有 nvidia-smi 時為空陣列（SPEC FR-03：不得阻止其他功能）。 */
  gpus: z.array(GpuMetricSchema),
});
export type TelemetrySnapshot = z.infer<typeof TelemetrySnapshotSchema>;
