interface MockRun {
  id: string;
  status: 'completed' | 'running' | 'failed';
  normalization: string;
  seed: number;
  accuracy: number | null;
  duration: string;
}

const RUNS: MockRun[] = [
  { id: 'run-a1f3', status: 'completed', normalization: 'zscore', seed: 11, accuracy: 0.873, duration: '2h 14m' },
  { id: 'run-b7c2', status: 'completed', normalization: 'zscore', seed: 22, accuracy: 0.869, duration: '2h 11m' },
  { id: 'run-c9d8', status: 'running', normalization: 'zscore', seed: 33, accuracy: null, duration: '1h 03m' },
  { id: 'run-d2e4', status: 'completed', normalization: 'none', seed: 11, accuracy: 0.85, duration: '2h 09m' },
  { id: 'run-e5f1', status: 'failed', normalization: 'minmax', seed: 11, accuracy: null, duration: '0h 22m' },
];

export function ResearchWorkspace() {
  return (
    <div className="research-workspace">
      <div className="card study-card">
        <div className="study-head">
          <h2>Normalization and initialization effects</h2>
          <span className="chip chip-running">experiment: locked</span>
        </div>
        <p className="hint">
          Which choices improve validation accuracy under equal training budget?
        </p>
        <div className="study-meta">
          <span>
            objective: <span className="mono">val/accuracy ↑</span>
          </span>
          <span>
            baseline: <span className="mono">zscore + pretrained + backbone-freeze</span>
          </span>
          <span>seeds: 11 / 22 / 33</span>
        </div>
      </div>

      <div className="card">
        <h3>Runs</h3>
        <table className="runs-table">
          <thead>
            <tr>
              <th>run</th>
              <th>status</th>
              <th>normalization</th>
              <th>seed</th>
              <th>val/accuracy</th>
              <th>duration</th>
            </tr>
          </thead>
          <tbody>
            {RUNS.map((run) => (
              <tr key={run.id}>
                <td className="mono">{run.id}</td>
                <td>
                  <span className={`chip chip-run-${run.status}`}>{run.status}</span>
                </td>
                <td className="mono">{run.normalization}</td>
                <td className="mono">{run.seed}</td>
                <td className="mono">{run.accuracy === null ? '—' : run.accuracy.toFixed(3)}</td>
                <td className="mono">{run.duration}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">
          failed / missing-metric runs 依 SPEC 18.5 保持可見，不會被靜默排除。
        </p>
      </div>

      <div className="card">
        <h3>Research Lab</h3>
        <p className="hint">
          Pipeline DAG、ablation preflight、learning curves 與 dashboard 屬 Phase
          6A；此頁先以唯讀 mock 固定資訊架構（SPEC_V3 §18）。
        </p>
      </div>
    </div>
  );
}
