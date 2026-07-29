import { useEffect, useMemo, useState } from 'react';
import type { GpuMetric, TelemetrySnapshot } from '@cozypad/contracts';
import { getBridge } from '../platform/bridge';

interface MonitorWorkspaceProps {
  connected: boolean;
  host: string | null;
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

function StatCard({
  title,
  subtitle,
  value,
  percent,
  tone,
}: {
  title: string;
  subtitle: string;
  value: string;
  percent: number;
  tone?: 'warn' | 'hot';
}) {
  return (
    <div className="card stat-card">
      <span className="stat-title">{title}</span>
      <span className="stat-value">{value}</span>
      <Bar percent={percent} tone={tone} />
      <span className="stat-subtitle">{subtitle}</span>
    </div>
  );
}

function formatRuntime(seconds: number | null): string {
  if (seconds === null) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function gpuAverages(gpus: GpuMetric[]): { util: number; vramUsed: number; vramTotal: number } {
  if (gpus.length === 0) return { util: 0, vramUsed: 0, vramTotal: 0 };
  return {
    util: gpus.reduce((sum, gpu) => sum + gpu.usage, 0) / gpus.length,
    vramUsed: gpus.reduce((sum, gpu) => sum + gpu.memoryUsedMb, 0),
    vramTotal: gpus.reduce((sum, gpu) => sum + gpu.memoryTotalMb, 0),
  };
}

export function MonitorWorkspace({ connected, host }: MonitorWorkspaceProps) {
  const bridge = useMemo(() => getBridge(), []);
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [commandDialog, setCommandDialog] = useState<string | null>(null);

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
  const busiest =
    cpu && cpu.cores.length > 0
      ? cpu.cores.reduce((a, b) => (a.usage >= b.usage ? a : b))
      : null;
  const averages = gpuAverages(gpus);
  const processes = gpus.flatMap((gpu) =>
    gpu.processes.map((process) => ({ gpuIndex: gpu.index, ...process })),
  );

  return (
    <div className="monitor-workspace">
      <div className="monitor-header">
        <span className="monitor-host">{host ?? 'Remote host'}</span>
        <span className={`dot ${connected ? 'dot-ok' : 'dot-off'}`} />
        <span className="spacer" />
        <span className="hint mono">
          Synced at {new Date(snapshot.timestamp).toLocaleTimeString()}
        </span>
      </div>

      <div className="stat-row">
        <StatCard
          title="CPU"
          value={cpu ? `${cpu.totalUsage.toFixed(0)}%` : '—'}
          percent={cpu?.totalUsage ?? 0}
          subtitle={
            cpu === null
              ? 'CPU Info'
              : busiest === null
                ? 'CPU Info'
                : `${cpu.cores.length} cores · busiest: ${busiest.usage.toFixed(0)}%`
          }
        />
        <StatCard
          title="Memory"
          value={
            memory
              ? `${(memory.usedMb / 1024).toFixed(1)} / ${(memory.totalMb / 1024).toFixed(0)} GB`
              : '—'
          }
          percent={memory ? (memory.usedMb / Math.max(1, memory.totalMb)) * 100 : 0}
          subtitle={
            memory
              ? `${((memory.usedMb / Math.max(1, memory.totalMb)) * 100).toFixed(0)}% used`
              : 'Memory info unavailable'
          }
          tone="warn"
        />
        <StatCard
          title="GPU"
          value={gpus.length === 0 ? 'N/A' : `${averages.util.toFixed(0)}%`}
          percent={averages.util}
          subtitle={
            gpus.length === 0
              ? 'nvidia-smi not available'
              : `${gpus.length} device${gpus.length > 1 ? 's' : ''} · ${(averages.vramUsed / 1024).toFixed(1)}/${(averages.vramTotal / 1024).toFixed(0)} GB VRAM`
          }
        />
      </div>

      {gpus.length > 0 ? (
        <div className="card">
          <h3>GPU devices</h3>
          <div className="gpu-list">
            {gpus.map((gpu) => (
              <div key={gpu.uuid} className="gpu-item">
                <div className="gpu-item-head">
                  <span className="gpu-name">
                    <span className="gpu-index">#{gpu.index}</span> {gpu.name}
                  </span>
                  <span className="mono gpu-temp">{gpu.temperature.toFixed(0)}°C</span>
                </div>
                <div className="gpu-row">
                  <span>util</span>
                  <Bar percent={gpu.usage} />
                  <span className="core-value">{gpu.usage.toFixed(0)}%</span>
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
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="card">
        <h3>Active processes</h3>
        {processes.length === 0 ? (
          <p className="hint">目前沒有 GPU process。</p>
        ) : (
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
              {processes.map((process) => (
                <tr
                  key={`${process.gpuIndex}-${process.pid}`}
                  className="clickable-row"
                  onClick={() => setCommandDialog(process.commandLine)}
                  title="點擊查看完整命令"
                >
                  <td className="mono">{process.gpuIndex}</td>
                  <td className="mono">{process.pid}</td>
                  <td>{process.username}</td>
                  <td className="mono">{formatRuntime(process.runtimeSeconds)}</td>
                  <td className="mono process-command">{process.commandLine}</td>
                  <td className="mono">{(process.usedMemoryMb / 1024).toFixed(1)}G</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {commandDialog !== null ? (
        <div className="modal-overlay" onClick={() => setCommandDialog(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2>Process command</h2>
              <button className="modal-close" onClick={() => setCommandDialog(null)}>
                ×
              </button>
            </div>
            <pre className="command-block">{commandDialog}</pre>
            <div className="form-actions">
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(commandDialog).catch(() => undefined);
                  setCommandDialog(null);
                }}
              >
                Copy
              </button>
              <button className="primary" onClick={() => setCommandDialog(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
