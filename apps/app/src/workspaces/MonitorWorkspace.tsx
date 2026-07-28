import { useEffect, useState } from 'react';

interface GpuStat {
  index: number;
  name: string;
  util: number;
  memUsed: number;
  memTotal: number;
  temp: number;
}

interface Telemetry {
  cpuOverall: number;
  cores: number[];
  memUsed: number;
  memTotal: number;
  gpus: GpuStat[];
}

const INITIAL: Telemetry = {
  cpuOverall: 24,
  cores: [18, 35, 22, 41, 15, 28, 19, 33],
  memUsed: 21.4,
  memTotal: 64,
  gpus: [
    { index: 0, name: 'NVIDIA RTX 4090', util: 36, memUsed: 18432, memTotal: 24576, temp: 61 },
    { index: 1, name: 'NVIDIA RTX 4090', util: 34, memUsed: 18201, memTotal: 24576, temp: 58 },
  ],
};

const PROCESSES = [
  { pid: 41233, user: 'ycchao', command: 'python train.py --config configs/base.yaml', vram: 18102 },
  { pid: 41890, user: 'ycchao', command: 'python eval.py --split val', vram: 2210 },
];

function jitter(value: number, spread: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value + (Math.random() - 0.5) * spread));
}

function useMockTelemetry(): Telemetry {
  const [telemetry, setTelemetry] = useState<Telemetry>(INITIAL);
  useEffect(() => {
    const interval = setInterval(() => {
      setTelemetry((current) => ({
        cpuOverall: jitter(current.cpuOverall, 10, 5, 95),
        cores: current.cores.map((core) => jitter(core, 18, 2, 100)),
        memUsed: jitter(current.memUsed, 1.2, 16, 40),
        memTotal: current.memTotal,
        gpus: current.gpus.map((gpu) => ({
          ...gpu,
          util: jitter(gpu.util, 12, 20, 99),
          memUsed: jitter(gpu.memUsed, 300, 16000, 23000),
          temp: jitter(gpu.temp, 3, 45, 84),
        })),
      }));
    }, 2000);
    return () => clearInterval(interval);
  }, []);
  return telemetry;
}

function Bar({ percent, tone }: { percent: number; tone?: 'warn' | 'hot' }) {
  return (
    <div className="bar">
      <div
        className={`bar-fill${tone ? ` bar-${tone}` : ''}`}
        style={{ width: `${Math.round(percent)}%` }}
      />
    </div>
  );
}

export function MonitorWorkspace() {
  const telemetry = useMockTelemetry();

  return (
    <div className="monitor-workspace">
      <div className="monitor-note hint">mock telemetry — 真實資料在 Phase 6 由 telemetry parser 供應（5 秒輪詢）</div>
      <div className="monitor-grid">
        <div className="card monitor-card">
          <h3>CPU</h3>
          <div className="big-number">{Math.round(telemetry.cpuOverall)}%</div>
          <div className="core-grid">
            {telemetry.cores.map((core, index) => (
              <div key={index} className="core-row">
                <span className="core-label">c{index}</span>
                <Bar percent={core} />
                <span className="core-value">{Math.round(core)}%</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card monitor-card">
          <h3>Memory</h3>
          <div className="big-number">
            {telemetry.memUsed.toFixed(1)} / {telemetry.memTotal} GB
          </div>
          <Bar percent={(telemetry.memUsed / telemetry.memTotal) * 100} />
        </div>

        {telemetry.gpus.map((gpu) => (
          <div key={gpu.index} className="card monitor-card">
            <h3>
              GPU {gpu.index} <span className="hint">{gpu.name}</span>
            </h3>
            <div className="gpu-row">
              <span>util</span>
              <Bar percent={gpu.util} />
              <span className="core-value">{Math.round(gpu.util)}%</span>
            </div>
            <div className="gpu-row">
              <span>vram</span>
              <Bar percent={(gpu.memUsed / gpu.memTotal) * 100} tone="warn" />
              <span className="core-value">
                {(gpu.memUsed / 1024).toFixed(1)}/{(gpu.memTotal / 1024).toFixed(0)}G
              </span>
            </div>
            <div className="gpu-row">
              <span>temp</span>
              <Bar percent={(gpu.temp / 90) * 100} tone={gpu.temp > 75 ? 'hot' : undefined} />
              <span className="core-value">{Math.round(gpu.temp)}°C</span>
            </div>
          </div>
        ))}

        <div className="card monitor-card monitor-processes">
          <h3>GPU processes</h3>
          <table>
            <thead>
              <tr>
                <th>PID</th>
                <th>user</th>
                <th>command</th>
                <th>VRAM</th>
              </tr>
            </thead>
            <tbody>
              {PROCESSES.map((process) => (
                <tr key={process.pid}>
                  <td className="mono">{process.pid}</td>
                  <td>{process.user}</td>
                  <td className="mono process-command">{process.command}</td>
                  <td className="mono">{(process.vram / 1024).toFixed(1)}G</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
