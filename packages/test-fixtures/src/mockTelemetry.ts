import type { TelemetrySnapshot } from '@cozypad/contracts';

function jitter(value: number, spread: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value + (Math.random() - 0.5) * spread));
}

/** mock 模式的 telemetry 來源；與 ShellTelemetry 相同的 start/stop 介面。 */
export class MockTelemetryGenerator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cpu = 24;
  private cores = [18, 35, 22, 41, 15, 28, 19, 33];
  private memUsed = 21400;
  private gpus = [
    { util: 36, memUsed: 18432, temp: 61 },
    { util: 34, memUsed: 18201, temp: 58 },
  ];

  constructor(private readonly intervalMs = 2000) {}

  start(profileId: string, emit: (snapshot: TelemetrySnapshot) => void): void {
    this.stop();
    const tick = () => {
      this.cpu = jitter(this.cpu, 10, 5, 95);
      this.cores = this.cores.map((core) => jitter(core, 18, 2, 100));
      this.memUsed = jitter(this.memUsed, 1200, 16000, 40000);
      this.gpus = this.gpus.map((gpu) => ({
        util: jitter(gpu.util, 12, 20, 99),
        memUsed: jitter(gpu.memUsed, 300, 16000, 23000),
        temp: jitter(gpu.temp, 3, 45, 84),
      }));
      emit({
        profileId,
        timestamp: new Date().toISOString(),
        cpu: {
          totalUsage: this.cpu,
          cores: this.cores.map((usage, index) => ({ index, usage })),
        },
        memory: { usedMb: this.memUsed, totalMb: 64213 },
        gpus: this.gpus.map((gpu, index) => ({
          index,
          uuid: `GPU-mock-${index}`,
          name: 'NVIDIA GeForce RTX 4090 (mock)',
          usage: gpu.util,
          memoryUsedMb: gpu.memUsed,
          memoryTotalMb: 24564,
          temperature: gpu.temp,
          processes: [
            {
              pid: 41233,
              username: 'cozy',
              processName: 'python',
              commandLine: 'python train.py --config configs/base.yaml',
              usedMemoryMb: gpu.memUsed - 330,
              runtimeSeconds: 7215,
            },
          ],
        })),
      });
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
