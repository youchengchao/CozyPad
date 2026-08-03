import { useMemo, useState } from 'react';
import {
  materializeResearchExperimentPlan,
  preflightResearchExperimentPlan,
  type MaterializedResearchRun,
  type ResearchExperimentPlan,
  type ResearchParameterValue,
} from '@cozypad/contracts';

type ResearchView = 'pipeline' | 'design' | 'runs';
type SubsetScope = 'train-only' | 'before-split' | 'custom-manifest';

interface PipelineNode {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
  role: 'input' | 'control' | 'factor' | 'execute' | 'outcome';
  x: number;
  y: number;
  config: Record<string, string>;
  parameterPaths: string[];
}

const NORMALIZATION_OPTIONS = ['none', 'zscore', 'minmax'] as const;
const SUBSET_RATIO_OPTIONS = [0.25, 0.5, 1] as const;
const SEED_OPTIONS = [11, 22, 33, 44] as const;
const NORMALIZATION_PATH = 'pipeline.preprocess.normalization';
const SUBSET_RATIO_PATH = 'pipeline.subset.trainRatio';
const SUBSET_SCOPE_PATH = 'pipeline.subset.scope';

const BASELINE: Record<string, ResearchParameterValue> = {
  'pipeline.dataset.uri': 'data/images-v4',
  'pipeline.dataset.revision': 'sha256:4b32…91e8',
  'pipeline.split.strategy': 'stratified',
  'pipeline.split.ratios': '80 / 10 / 10',
  'pipeline.split.seed': 2026,
  [SUBSET_SCOPE_PATH]: 'train-only',
  [SUBSET_RATIO_PATH]: 1,
  'pipeline.preprocess.resize': '224 × 224',
  [NORMALIZATION_PATH]: 'zscore',
  'pipeline.train.epochs': 100,
  'pipeline.train.optimizer': 'adamw',
  'pipeline.train.learningRate': 0.0003,
};

const CONTROL_PATHS = [
  'pipeline.dataset.uri',
  'pipeline.dataset.revision',
  'pipeline.split.strategy',
  'pipeline.split.ratios',
  'pipeline.split.seed',
  SUBSET_SCOPE_PATH,
  'pipeline.preprocess.resize',
  'pipeline.train.epochs',
  'pipeline.train.optimizer',
] as const;

const FACTOR_PATHS = [SUBSET_RATIO_PATH, NORMALIZATION_PATH] as const;

const PATH_LABELS: Record<string, string> = {
  'pipeline.dataset.uri': 'Dataset source',
  'pipeline.dataset.revision': 'Dataset revision',
  'pipeline.split.strategy': 'Split strategy',
  'pipeline.split.ratios': 'Split ratios',
  'pipeline.split.seed': 'Split seed',
  [SUBSET_SCOPE_PATH]: 'Subset scope',
  [SUBSET_RATIO_PATH]: 'Training subset',
  'pipeline.preprocess.resize': 'Input resize',
  [NORMALIZATION_PATH]: 'Normalization',
  'pipeline.train.epochs': 'Epochs',
  'pipeline.train.optimizer': 'Optimizer',
  'pipeline.train.learningRate': 'Learning rate',
  'research.seed': 'Random seed',
};

function createPipelineNodes(
  subsetScope: SubsetScope,
  subsetValueCount: number,
): PipelineNode[] {
  const scopeLabel =
    subsetScope === 'train-only'
      ? 'Training split only'
      : subsetScope === 'before-split'
        ? 'Before split'
        : 'Custom sample manifest';

  return [
    {
      id: 'dataset',
      eyebrow: 'DATA SOURCE',
      title: 'Dataset snapshot',
      description: '資料來源只負責 identity、revision 與 schema，不包含 split 或 subset 語意。',
      role: 'input',
      x: 24,
      y: 160,
      config: { URI: 'data/images-v4', Revision: 'sha256:4b32…91e8', Samples: '12,000' },
      parameterPaths: ['pipeline.dataset.uri', 'pipeline.dataset.revision'],
    },
    {
      id: 'split',
      eyebrow: 'DATA OPERATION',
      title: 'Split dataset',
      description: '獨立保存 split strategy、seed 與每筆 sample assignment，避免 runs 之間資料漂移。',
      role: 'control',
      x: 174,
      y: 160,
      config: { Strategy: 'Stratified', Ratios: '80 / 10 / 10', Seed: '2026' },
      parameterPaths: [
        'pipeline.split.strategy',
        'pipeline.split.ratios',
        'pipeline.split.seed',
      ],
    },
    {
      id: 'subset',
      eyebrow: 'DATA OPERATION',
      title: 'Select subset',
      description: 'Subset 是獨立的 dataset view；可套用在整體資料或只套用 training split。',
      role: 'factor',
      x: 324,
      y: 70,
      config: { Scope: scopeLabel, Selector: 'Random stratified', Values: `${subsetValueCount} ratios` },
      parameterPaths: [SUBSET_SCOPE_PATH, SUBSET_RATIO_PATH],
    },
    {
      id: 'preprocess',
      eyebrow: 'DATA OPERATION',
      title: 'Transform',
      description: 'Resize、normalization 與 augmentation 可各自成為 factor 或 control。',
      role: 'factor',
      x: 474,
      y: 70,
      config: { Resize: '224 × 224', Normalization: 'zscore → 3 values' },
      parameterPaths: ['pipeline.preprocess.resize', NORMALIZATION_PATH],
    },
    {
      id: 'model',
      eyebrow: 'MODEL',
      title: 'Build model',
      description: '模型架構、初始化來源與 freeze policy 保持為獨立參數群組。',
      role: 'execute',
      x: 624,
      y: 70,
      config: { Architecture: 'resnet50', Initialize: 'pretrained', Freeze: 'backbone' },
      parameterPaths: [],
    },
    {
      id: 'train',
      eyebrow: 'COMMAND',
      title: 'Train',
      description: '每個 run 使用 resolved config；runner 不綁定特定 deep learning framework。',
      role: 'execute',
      x: 774,
      y: 70,
      config: { Command: 'python train.py --config …', Epochs: '100', Optimizer: 'adamw' },
      parameterPaths: [
        'pipeline.train.epochs',
        'pipeline.train.optimizer',
        'pipeline.train.learningRate',
      ],
    },
    {
      id: 'evaluation-set',
      eyebrow: 'DATA VIEW',
      title: 'Validation / test',
      description: '評估資料從 split manifest 固定引用，不隨 training subset 大小改變。',
      role: 'control',
      x: 324,
      y: 250,
      config: { Validation: '1,200 samples', Test: '1,200 samples', Leakage: 'none' },
      parameterPaths: ['pipeline.split.ratios', 'pipeline.split.seed'],
    },
    {
      id: 'evaluate',
      eyebrow: 'COMMAND',
      title: 'Evaluate',
      description: '使用相同 metric definition 與 evaluation set 比較所有 runs。',
      role: 'outcome',
      x: 624,
      y: 250,
      config: { Metric: 'val/accuracy', Direction: 'maximize' },
      parameterPaths: [],
    },
    {
      id: 'artifacts',
      eyebrow: 'OUTPUT',
      title: 'Metrics + artifacts',
      description: '保存 metrics、checkpoint、resolved config 與 dataset-view manifests。',
      role: 'outcome',
      x: 774,
      y: 250,
      config: { Outputs: 'metrics.jsonl · best.ckpt', Retention: 'remote' },
      parameterPaths: [],
    },
  ];
}

function displayValue(value: ResearchParameterValue | undefined): string {
  if (value === undefined) return '—';
  if (typeof value === 'number' && value < 0.01) return value.toExponential(1);
  return String(value);
}

function displayPathValue(
  path: string,
  value: ResearchParameterValue | undefined,
): string {
  if (path === SUBSET_RATIO_PATH && typeof value === 'number') {
    return `${Math.round(value * 100)}%`;
  }
  return displayValue(value);
}

function roleLabel(role: PipelineNode['role']): string {
  switch (role) {
    case 'input':
      return 'Input';
    case 'control':
      return 'Locked control';
    case 'factor':
      return 'Factor';
    case 'execute':
      return 'Runner';
    case 'outcome':
      return 'Outcome';
  }
}

export function ResearchWorkspace() {
  const [activeView, setActiveView] = useState<ResearchView>('pipeline');
  const [normalizations, setNormalizations] = useState<string[]>([
    ...NORMALIZATION_OPTIONS,
  ]);
  const [subsetRatios, setSubsetRatios] = useState<number[]>([
    ...SUBSET_RATIO_OPTIONS,
  ]);
  const [subsetScope, setSubsetScope] = useState<SubsetScope>('train-only');
  const [seeds, setSeeds] = useState<number[]>([11, 22, 33]);
  const [selectedNodeId, setSelectedNodeId] = useState('subset');
  const [selectedRunId, setSelectedRunId] = useState('baseline-s11');

  const baseline = useMemo<Record<string, ResearchParameterValue>>(
    () => ({ ...BASELINE, [SUBSET_SCOPE_PATH]: subsetScope }),
    [subsetScope],
  );
  const pipelineNodes = useMemo(
    () => createPipelineNodes(subsetScope, subsetRatios.length),
    [subsetRatios.length, subsetScope],
  );

  const plan = useMemo<ResearchExperimentPlan>(
    () => ({
      design: 'one-factor-at-a-time',
      baseline,
      factors: [
        {
          path: SUBSET_RATIO_PATH,
          label: 'Training subset',
          values: subsetRatios,
        },
        {
          path: NORMALIZATION_PATH,
          label: 'Normalization',
          values: normalizations,
        },
      ],
      controls: [...CONTROL_PATHS],
      seeds,
    }),
    [baseline, normalizations, seeds, subsetRatios],
  );

  const preflight = useMemo(
    () => preflightResearchExperimentPlan(plan),
    [plan],
  );
  const runs = useMemo(
    () =>
      preflight.ok ? materializeResearchExperimentPlan(plan) : [],
    [plan, preflight.ok],
  );
  const selectedNode =
    pipelineNodes.find((node) => node.id === selectedNodeId) ?? pipelineNodes[0];
  const selectedRun =
    runs.find((run) => run.id === selectedRunId) ?? runs[0];

  const toggleNormalization = (value: string): void => {
    if (value === baseline[NORMALIZATION_PATH]) return;
    setNormalizations((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return NORMALIZATION_OPTIONS.filter((option) => next.has(option));
    });
  };

  const toggleSubsetRatio = (value: number): void => {
    if (value === baseline[SUBSET_RATIO_PATH]) return;
    setSubsetRatios((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return SUBSET_RATIO_OPTIONS.filter((option) => next.has(option));
    });
  };

  const toggleSeed = (seed: number): void => {
    setSeeds((current) => {
      if (current.includes(seed)) {
        if (current.length === 1) return current;
        return current.filter((value) => value !== seed);
      }
      return SEED_OPTIONS.filter((value) =>
        new Set([...current, seed]).has(value),
      );
    });
  };

  const previewRuns = (): void => {
    setSelectedRunId(runs[0]?.id ?? '');
    setActiveView('runs');
  };

  return (
    <div className="research-workspace">
      <header className="research-header">
        <div>
          <div className="research-kicker">RESEARCH LAB · PROTOTYPE</div>
          <div className="research-title-row">
            <h1>Data recipe ablation</h1>
            <span className="chip">draft plan</span>
          </div>
          <p>
            How do training subset size and normalization affect validation accuracy?
          </p>
        </div>
        <div className="research-header-actions">
          <div
            className={`research-preflight ${preflight.ok ? 'is-valid' : 'is-invalid'}`}
          >
            <span className="research-preflight-dot" />
            <span>
              <strong>{preflight.ok ? 'Preflight passed' : 'Needs attention'}</strong>
              <small>{preflight.runCount} materialized runs</small>
            </span>
          </div>
          <button
            className="primary research-preview-button"
            type="button"
            onClick={previewRuns}
            disabled={!preflight.ok}
          >
            Preview {preflight.runCount} runs
          </button>
        </div>
      </header>

      <div className="research-layout">
        <aside className="research-studies">
          <div className="research-side-title">
            <span>Studies</span>
            <button type="button" aria-label="Create study" title="初版先固定單一 study">
              +
            </button>
          </div>
          <div className="research-project-label">VISION BENCHMARKS</div>
          <button className="research-study-item is-active" type="button">
            <span className="research-study-icon">N</span>
            <span>
              <strong>Data recipe ablation</strong>
              <small>{preflight.runCount} planned runs</small>
            </span>
          </button>
          <button className="research-study-item" type="button" disabled>
            <span className="research-study-icon is-muted">+</span>
            <span>
              <strong>New study</strong>
              <small>coming next</small>
            </span>
          </button>

          <div className="research-plan-versions">
            <div className="research-project-label">PLAN VERSIONS</div>
            <button className="research-version is-current" type="button">
              <span>v3</span>
              <small>editing</small>
            </button>
            <button className="research-version" type="button" disabled>
              <span>v2</span>
              <small>locked · 6 runs</small>
            </button>
          </div>
        </aside>

        <main className="research-main">
          <nav className="research-tabs" aria-label="Research view">
            {(
              [
                ['pipeline', 'Pipeline'],
                ['design', 'Experiment design'],
                ['runs', `Runs ${preflight.runCount}`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={activeView === id ? 'is-active' : ''}
                type="button"
                onClick={() => setActiveView(id)}
              >
                {label}
              </button>
            ))}
          </nav>

          <section className="research-stage">
            {activeView === 'pipeline' ? (
              <PipelineCanvas
                nodes={pipelineNodes}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
              />
            ) : null}
            {activeView === 'design' ? (
              <ExperimentDesign
                baseline={baseline}
                normalizations={normalizations}
                subsetRatios={subsetRatios}
                subsetScope={subsetScope}
                seeds={seeds}
                runCount={preflight.runCount}
                onToggleNormalization={toggleNormalization}
                onToggleSubsetRatio={toggleSubsetRatio}
                onSetSubsetScope={setSubsetScope}
                onToggleSeed={toggleSeed}
              />
            ) : null}
            {activeView === 'runs' ? (
              <RunsPreview
                runs={runs}
                selectedRunId={selectedRun?.id ?? ''}
                onSelectRun={setSelectedRunId}
              />
            ) : null}
          </section>
        </main>

        <aside className="research-inspector">
          {activeView === 'pipeline' && selectedNode ? (
            <NodeInspector node={selectedNode} />
          ) : null}
          {activeView === 'design' ? (
            <DesignInspector plan={plan} runCount={preflight.runCount} />
          ) : null}
          {activeView === 'runs' ? (
            <RunInspector run={selectedRun} />
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function PipelineCanvas({
  nodes,
  selectedNodeId,
  onSelectNode,
}: {
  nodes: readonly PipelineNode[];
  selectedNodeId: string;
  onSelectNode: (id: string) => void;
}) {
  return (
    <div className="pipeline-scroll">
      <div className="pipeline-canvas" aria-label="Experiment pipeline graph">
        <div className="pipeline-canvas-head">
          <span>Experiment pipeline</span>
          <span className="pipeline-legend">
            <i className="legend-factor" /> factor
            <i className="legend-control" /> control
          </span>
        </div>
        <svg
          className="pipeline-edges"
          viewBox="0 0 940 430"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d="M164 202 L174 202" />
          <path d="M314 202 C324 202 314 112 324 112" />
          <path d="M464 112 L474 112" />
          <path d="M614 112 L624 112" />
          <path d="M764 112 L774 112" />
          <path d="M244 244 C244 292 286 292 324 292" />
          <path d="M464 292 L624 292" />
          <path d="M844 154 C844 220 694 220 694 250" />
          <path d="M764 292 L774 292" />
        </svg>
        {nodes.map((node) => (
          <button
            key={node.id}
            className={`pipeline-node pipeline-node-${node.role} ${
              selectedNodeId === node.id ? 'is-selected' : ''
            }`}
            style={{ left: node.x, top: node.y }}
            type="button"
            onClick={() => onSelectNode(node.id)}
          >
            <span className="pipeline-node-port pipeline-node-port-in" />
            <span className="pipeline-node-port pipeline-node-port-out" />
            <small>{node.eyebrow}</small>
            <strong>{node.title}</strong>
            <span>{roleLabel(node.role)}</span>
          </button>
        ))}
        <div className="pipeline-canvas-note">
          Graph 決定「做什麼」；變因組合由 Experiment design 控制。
        </div>
      </div>
    </div>
  );
}

function ExperimentDesign({
  baseline,
  normalizations,
  subsetRatios,
  subsetScope,
  seeds,
  runCount,
  onToggleNormalization,
  onToggleSubsetRatio,
  onSetSubsetScope,
  onToggleSeed,
}: {
  baseline: Record<string, ResearchParameterValue>;
  normalizations: string[];
  subsetRatios: number[];
  subsetScope: SubsetScope;
  seeds: number[];
  runCount: number;
  onToggleNormalization: (value: string) => void;
  onToggleSubsetRatio: (value: number) => void;
  onSetSubsetScope: (value: SubsetScope) => void;
  onToggleSeed: (value: number) => void;
}) {
  const dataRoute =
    subsetScope === 'before-split'
      ? ['Dataset', 'Subset', 'Split', 'Train / Eval']
      : subsetScope === 'custom-manifest'
        ? ['Dataset', 'Sample manifest', 'Split', 'Train / Eval']
        : ['Dataset', 'Split', 'Train subset', 'Train'];
  const factorVariants =
    Math.max(subsetRatios.length - 1, 0) +
    Math.max(normalizations.length - 1, 0);

  return (
    <div className="experiment-design">
      <div className="design-summary-card">
        <span className="design-step">01</span>
        <div>
          <small>DATA-AWARE DESIGN</small>
          <strong>Compose data operations, then declare factors</strong>
          <p>Dataset、Subset、Split 各自保存語意；OFAT 一次只改一個宣告過的欄位。</p>
        </div>
        <span className="chip chip-ready">{runCount} runs</span>
      </div>

      <div className="design-grid">
        <section className="design-card design-card-data-flow">
          <header>
            <div>
              <small>DATA PIPELINE</small>
              <h3>Where should the subset apply?</h3>
            </div>
            <span className="research-role research-role-control">scope locked per plan</span>
          </header>
          <p>
            同一個 subset 定義放在 split 前後會改變實驗母體；選擇後會寫入 plan version。
          </p>
          <div className="subset-scope-options">
            {(
              [
                ['train-only', 'Training split only', '低資料量 ablation；validation/test 固定'],
                ['before-split', 'Before split', '先縮小母體，再重新產生 splits'],
                ['custom-manifest', 'Custom manifest', '由 index/query/file 精確指定 samples'],
              ] as const
            ).map(([value, label, description]) => (
              <button
                key={value}
                className={subsetScope === value ? 'is-active' : ''}
                type="button"
                onClick={() => onSetSubsetScope(value)}
              >
                <span className="subset-scope-radio" />
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
              </button>
            ))}
          </div>
          <div className="data-flow-preview">
            <div className="data-flow-route">
              {dataRoute.map((label, index) => (
                <span key={label} className="data-flow-step-wrap">
                  <span className={`data-flow-node ${label.includes('Subset') || label.includes('manifest') ? 'is-factor' : ''}`}>
                    {label}
                  </span>
                  {index < dataRoute.length - 1 ? <i>→</i> : null}
                </span>
              ))}
            </div>
            <div className="data-flow-stats">
              <span><b>12,000</b> source samples</span>
              <span><b>9,600</b> baseline train</span>
              <span><b>2,400</b> fixed validation + test</span>
            </div>
          </div>
        </section>

        <section className="design-card design-card-factor">
          <header>
            <div>
              <small>DATA FACTOR 01</small>
              <h3>Training subset size</h3>
            </div>
            <span className="research-role research-role-factor">factor</span>
          </header>
          <p className="mono design-path">{SUBSET_RATIO_PATH}</p>
          <div className="design-options design-options-inline">
            {SUBSET_RATIO_OPTIONS.map((value) => {
              const isBaseline = value === baseline[SUBSET_RATIO_PATH];
              const checked = subsetRatios.includes(value);
              return (
                <label
                  key={value}
                  className={`design-option ${checked ? 'is-selected' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={isBaseline}
                    onChange={() => onToggleSubsetRatio(value)}
                  />
                  <span className="design-checkbox" />
                  <span>
                    <strong>{displayPathValue(SUBSET_RATIO_PATH, value)}</strong>
                    <small>
                      {isBaseline
                        ? 'baseline · 9,600 samples'
                        : `${Math.round(9600 * value).toLocaleString()} training samples`}
                    </small>
                  </span>
                </label>
              );
            })}
          </div>
        </section>

        <section className="design-card design-card-factor">
          <header>
            <div>
              <small>PREPROCESS FACTOR 02</small>
              <h3>Normalization</h3>
            </div>
            <span className="research-role research-role-factor">variable</span>
          </header>
          <p className="mono design-path">{NORMALIZATION_PATH}</p>
          <div className="design-options">
            {NORMALIZATION_OPTIONS.map((value) => {
              const isBaseline = value === baseline[NORMALIZATION_PATH];
              const checked = normalizations.includes(value);
              return (
                <label
                  key={value}
                  className={`design-option ${checked ? 'is-selected' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={isBaseline}
                    onChange={() => onToggleNormalization(value)}
                  />
                  <span className="design-checkbox" />
                  <span>
                    <strong>{value}</strong>
                    <small>{isBaseline ? 'baseline · always included' : 'ablation value'}</small>
                  </span>
                </label>
              );
            })}
          </div>
        </section>

        <section className="design-card">
          <header>
            <div>
              <small>REPLICATES</small>
              <h3>Random seeds</h3>
            </div>
            <span className="research-role">repeat</span>
          </header>
          <p>每個 baseline 與 factor value 使用相同 seeds。</p>
          <div className="seed-options">
            {SEED_OPTIONS.map((seed) => (
              <label
                key={seed}
                className={`seed-option ${seeds.includes(seed) ? 'is-selected' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={seeds.includes(seed)}
                  onChange={() => onToggleSeed(seed)}
                />
                <span>{seed}</span>
              </label>
            ))}
          </div>
          <div className="design-equation mono">
            (1 baseline + {factorVariants} OFAT variants) × {seeds.length} seeds ={' '}
            <strong>{runCount} runs</strong>
          </div>
        </section>

        <section className="design-card design-card-controls">
          <header>
            <div>
              <small>LOCKED CONTROLS</small>
              <h3>Equal training budget</h3>
            </div>
            <span className="research-role research-role-control">locked</span>
          </header>
          <div className="control-list">
            {CONTROL_PATHS.map((path) => (
              <div key={path} className="control-row">
                <span className="control-lock">⌁</span>
                <span>
                  <strong>{PATH_LABELS[path]}</strong>
                  <small className="mono">{path}</small>
                </span>
                <b className="mono">{displayPathValue(path, baseline[path])}</b>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function RunsPreview({
  runs,
  selectedRunId,
  onSelectRun,
}: {
  runs: readonly MaterializedResearchRun[];
  selectedRunId: string;
  onSelectRun: (id: string) => void;
}) {
  return (
    <div className="runs-preview">
      <div className="runs-preview-head">
        <div>
          <small>MATERIALIZED PLAN</small>
          <h2>{runs.length} runs ready for review</h2>
        </div>
        <div className="runs-preview-stats">
          <span>
            <b>{runs.filter((run) => run.kind === 'baseline').length}</b> baseline
          </span>
          <span>
            <b>{runs.filter((run) => run.kind === 'ablation').length}</b> ablation
          </span>
          <span className="is-good">
            <b>0</b> control drift
          </span>
        </div>
      </div>
      <div className="runs-table-wrap">
        <table className="runs-table research-runs-table">
          <thead>
            <tr>
              <th>run</th>
              <th>varied factor</th>
              <th>train subset</th>
              <th>normalization</th>
              <th>seed</th>
              <th>config diff</th>
              <th>preflight</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.id}
                className={selectedRunId === run.id ? 'is-selected' : ''}
                onClick={() => onSelectRun(run.id)}
              >
                <td className="mono">{run.id}</td>
                <td>
                  <span className={`research-run-kind research-run-${run.kind}`}>
                    {run.factorLabel ?? 'Baseline'}
                  </span>
                </td>
                <td className="mono">
                  {displayPathValue(
                    SUBSET_RATIO_PATH,
                    run.config[SUBSET_RATIO_PATH],
                  )}
                </td>
                <td className="mono">
                  {displayValue(run.config[NORMALIZATION_PATH])}
                </td>
                <td className="mono">{run.seed}</td>
                <td>
                  {run.kind === 'baseline' ? (
                    <span className="research-muted">baseline snapshot</span>
                  ) : (
                    <span className="mono research-diff">
                      {PATH_LABELS[run.factorPath ?? ''] ?? run.factorPath}:{' '}
                      {displayPathValue(run.factorPath ?? '', run.factorValue)}
                    </span>
                  )}
                </td>
                <td>
                  <span className="chip chip-ready">passed</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NodeInspector({ node }: { node: PipelineNode }) {
  return (
    <>
      <div className="inspector-heading">
        <small>STAGE INSPECTOR</small>
        <h2>{node.title}</h2>
        <span className={`research-role research-role-${node.role}`}>
          {roleLabel(node.role)}
        </span>
      </div>
      <p className="inspector-copy">{node.description}</p>

      <InspectorSection title="Configuration">
        {Object.entries(node.config).map(([label, value]) => (
          <div key={label} className="inspector-property">
            <span>{label}</span>
            <b className="mono">{value}</b>
          </div>
        ))}
      </InspectorSection>

      <InspectorSection title="Experiment role">
        {node.parameterPaths.length === 0 ? (
          <p className="inspector-empty">No configurable research variables.</p>
        ) : (
          node.parameterPaths.map((path) => {
            const factor = FACTOR_PATHS.includes(
              path as (typeof FACTOR_PATHS)[number],
            );
            const control = CONTROL_PATHS.includes(
              path as (typeof CONTROL_PATHS)[number],
            );
            return (
              <div key={path} className="inspector-variable">
                <span className={`variable-dot ${factor ? 'is-factor' : ''}`} />
                <span>
                  <strong>{PATH_LABELS[path] ?? path}</strong>
                  <small className="mono">{path}</small>
                </span>
                <em>{factor ? 'factor' : control ? 'control' : 'fixed'}</em>
              </div>
            );
          })
        )}
      </InspectorSection>

      <InspectorSection title="Ports">
        <div className="inspector-port-row">
          <span><i className="port-dot port-in" /> inputs</span>
          <b>{node.id === 'dataset' ? '0' : '1'}</b>
        </div>
        <div className="inspector-port-row">
          <span><i className="port-dot port-out" /> outputs</span>
          <b>{node.id === 'artifacts' ? '0' : '1'}</b>
        </div>
      </InspectorSection>
    </>
  );
}

function DesignInspector({
  plan,
  runCount,
}: {
  plan: ResearchExperimentPlan;
  runCount: number;
}) {
  return (
    <>
      <div className="inspector-heading">
        <small>PLAN PREFLIGHT</small>
        <h2>Ready to materialize</h2>
        <span className="research-role research-role-valid">valid</span>
      </div>
      <p className="inspector-copy">
        每個 OFAT run 只允許一個 Model、Training 或 Data factor 改變；split 與 evaluation set 目前鎖定。
      </p>
      <InspectorSection title="Plan summary">
        <div className="inspector-property"><span>Design</span><b>OFAT</b></div>
        <div className="inspector-property"><span>Factors</span><b>{plan.factors.length}</b></div>
        <div className="inspector-property"><span>Controls</span><b>{plan.controls.length}</b></div>
        <div className="inspector-property"><span>Seeds</span><b>{plan.seeds.length}</b></div>
        <div className="inspector-property"><span>Runs</span><b>{runCount}</b></div>
      </InspectorSection>
      <InspectorSection title="Validation">
        <div className="validation-item is-valid"><i /> baseline snapshot exists</div>
        <div className="validation-item is-valid"><i /> factors declared</div>
        <div className="validation-item is-valid"><i /> controls unchanged</div>
        <div className="validation-item is-valid"><i /> metric definition fixed</div>
      </InspectorSection>
      <InspectorSection title="Manifest preview">
        <pre className="manifest-preview">{`design: one-factor-at-a-time
factors:
  - data.trainSubset
  - preprocess.normalization
seeds: [${plan.seeds.join(', ')}]
runs: ${runCount}`}</pre>
      </InspectorSection>
    </>
  );
}

function RunInspector({ run }: { run: MaterializedResearchRun | undefined }) {
  if (!run) {
    return <p className="inspector-empty">No materialized run selected.</p>;
  }

  return (
    <>
      <div className="inspector-heading">
        <small>RUN PREVIEW</small>
        <h2 className="mono">{run.id}</h2>
        <span className="research-role research-role-valid">preflight passed</span>
      </div>
      <p className="inspector-copy">
        尚未執行。Launch 後會產生新的正式 run ID 與 immutable manifest。
      </p>
      <InspectorSection title="Declared differences">
        {run.diff.map((item) => (
          <div key={item.path} className="run-diff-item">
            <span className={`variable-dot ${item.kind === 'factor' ? 'is-factor' : ''}`} />
            <span>
              <strong>{PATH_LABELS[item.path] ?? item.path}</strong>
              <small className="mono">{item.path}</small>
            </span>
            <b className="mono">
              {item.kind === 'factor'
                ? `${displayPathValue(item.path, item.baseline)} → ${displayPathValue(item.path, item.value)}`
                : displayPathValue(item.path, item.value)}
            </b>
          </div>
        ))}
      </InspectorSection>
      <InspectorSection title="Locked controls">
        {CONTROL_PATHS.map((path) => (
          <div key={path} className="inspector-property">
            <span>{PATH_LABELS[path]}</span>
            <b className="mono">{displayPathValue(path, run.config[path])}</b>
          </div>
        ))}
      </InspectorSection>
    </>
  );
}

function InspectorSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="inspector-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
