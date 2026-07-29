import { useEffect, useMemo, useState } from 'react';
import type { TelemetrySnapshot } from '@cozypad/contracts';
import { getBridge } from '../platform/bridge';

interface MonitorWorkspaceProps {
  connected: boolean;
}

function Bar({ percent, tone }: { percent: number; tone?: 'warn' | 'hot' }) {
  return (
    <div className="bar">
      <div
        className={`bar-fill${tone ? ` bar-${tone}` : ''}`}
        style={{ width: `${Math.round(Math.min(100, Math.max(0, percent)))}%` }}
      />
    </div>
  );
}

function formatRuntime(seconds: number | null): string {
  if (seconds === null) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function MonitorWorkspace({ connected }: MonitorWorkspaceProps) {
  const bridge = useMemo(() => getBridge(), []);
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);

  useEffect(() => bridge.onTelemetry(setSnapshot), [bridge]);

  useEffect(() => {
    if (!connected) setSnapshot(null);
  }, [connected]);

  if (!connected) {
    return (
      <div className="placeholder">
        <p>Connect to start monitoring.</p>
        <p className="hint">連線後每 5 秒更新 CPU／記憶體／GPU（SPEC FR-03）。</p>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="placeholder">
        <p>Collecting telemetry…</p>
        <p className="hint">第一筆資料需要約一個取樣週期。</p>
      </div>
    );
  }

  const { cpu, memory, gpus } = snapshot;
  const gpuProcesses = gpus.flatMap((gpu) =>
    gpu.processes.map((process) => ({ gpuIndex: gpu.index, ...process })),
  );

  return (
    <div className="monitor-workspace">
      <div className="monitor-note hint">
        更新於 {new Date(snapshot.timestamp).toLocaleTimeString()}（
        {bridge.kind === 'mock' ? 'mock 資料源' : 'ssh 輪詢'}）
      </div>
      <div className="monitor-grid">
        <div className="card monitor-card">
          <h3>CPU</h3>
          {cpu ? (
            <>
              <div className="big-number">{Math.round(cpu.totalUsage)}%</div>
              <div className="core-grid">
                {cpu.cores.map((core) => (
                  <div key={core.index} className="core-row">
                    <span className="core-label">c{core.index}</span>
                    <Bar percent={core.usage} />
                    <span className="core-value">{Math.round(core.usage)}%</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="hint">無法讀取 /proc/stat。</p>
          )}
        </div>

        <div className="card monitor-card">
          <h3>Memory</h3>
          {memory ? (
            <>
              <div className="big-number">
                {(memory.usedMb / 1024).toFixed(1)} / {(memory.totalMb / 1024).toFixed(0)} GB
              </div>
              <Bar percent={(memory.usedMb / Math.max(1, memory.totalMb)) * 100} />
            </>
          ) : (
            <p className="hint">無法讀取 free。</p>
          )}
        </div>

        {gpus.map((gpu) => (
          <div key={gpu.uuid} className="card monitor-card">
            <h3>
              GPU {gpu.index} <span className="hint">{gpu.name}</span>
            </h3>
            <div className="gpu-row">
              <span>util</span>
              <Bar percent={gpu.usage} />
              <span className="core-value">{Math.round(gpu.usage)}%</span>
            </div>
            <div className="gpu-row">
              <span>vram</span>
              <Bar
                percent={(gpu.memoryUsedMb / Math.max(1, gpu.memoryTotalMb)) * 100}
                tone="warn"
              />
              <span className="core-value">
                {(gpu.memoryUsedMb / 1024).toFixed(1)}/
                {(gpu.memoryTotalMb / 1024).toFixed(0)}G
              </span>
            </div>
            <div className="gpu-row">
              <span>temp</span>
              <Bar
                percent={(gpu.temperature / 90) * 100}
                tone={gpu.temperature > 75 ? 'hot' : undefined}
              />
              <span className="core-value">{Math.round(gpu.temperature)}°C</span>
            </div>
          </div>
        ))}
        {gpus.length === 0 ? (
          <div className="card monitor-card">
            <h3>GPU</h3>
            <p className="hint">遠端沒有 nvidia-smi（或無 NVIDIA GPU）；其他監控不受影響。</p>
          </div>
        ) : null}

        {gpuProcesses.length > 0 ? (
          <div className="card monitor-card monitor-processes">
            <h3>GPU processes</h3>
            <table>
              <thead>
                <tr>
                  <th>GPU</th>
                  <th>PID</th>
                  <th>user</th>
                  <th>runtime</th>
                  <th>command</th>
                  <th>VRAM</th>
                </tr>
              </thead>
              <tbody>
                {gpuProcesses.map((process) => (
                  <tr key={`${process.gpuIndex}-${process.pid}`}>
                    <td className="mono">{process.gpuIndex}</td>
                    <td className="mono">{process.pid}</td>
                    <td>{process.username}</td>
                    <td className="mono">{formatRuntime(process.runtimeSeconds)}</td>
                    <td className="mono process-command" title={process.commandLine}>
                      {process.commandLine}
                    </td>
                    <td className="mono">{(process.usedMemoryMb / 1024).toFixed(1)}G</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
