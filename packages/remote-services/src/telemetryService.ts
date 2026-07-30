import type { TelemetrySnapshot } from '@cozypad/contracts';
import {
  CPU_COMMAND,
  GPU_COMMAND,
  MEMORY_COMMAND,
  parseCpuMetric,
  parseGpuTelemetry,
  parseMemoryMetric,
} from '@cozypad/telemetry';
import type { RemoteExec } from './shellRemoteFiles';

export interface TelemetrySource {
  start(profileId: string, emit: (snapshot: TelemetrySnapshot) => void): void;
  stop(): void;
}

/** 連線期間每 5 秒對遠端取樣（SPEC FR-03）；單次失敗不中斷輪詢。 */
export class ShellTelemetry implements TelemetrySource {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private readonly exec: RemoteExec,
    private readonly intervalMs = 5000,
  ) {}

  start(profileId: string, emit: (snapshot: TelemetrySnapshot) => void): void {
    this.stop();
    const poll = async (): Promise<void> => {
      if (this.polling) return;
      this.polling = true;
      try {
        const [cpuOutput, memoryOutput, gpuOutput] = await Promise.all([
          this.exec(CPU_COMMAND, 8000),
          this.exec(MEMORY_COMMAND, 5000),
          this.exec(GPU_COMMAND, 20000),
        ]);
        emit({
          profileId,
          timestamp: new Date().toISOString(),
          cpu: parseCpuMetric(cpuOutput),
          memory: parseMemoryMetric(memoryOutput),
          gpus: parseGpuTelemetry(gpuOutput),
        });
      } catch {
        // 連線中斷或指令逾時：保持輪詢，斷線事件會呼叫 stop()
      } finally {
        this.polling = false;
      }
    };
    void poll();
    this.timer = setInterval(() => void poll(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
