import { describe, expect, it } from 'vitest';
import {
  InvalidRunTransitionError,
  RESEARCH_RUN_TRANSITIONS,
  RunHeartbeatSchema,
  isTerminalRunState,
  materializeResearchExperimentPlan,
  preflightResearchExperimentPlan,
  validateRunTransition,
  validateMaterializedResearchRuns,
  type ResearchExperimentPlan,
} from '../src/research';

describe('validateRunTransition', () => {
  it('allows every declared transition', () => {
    for (const [from, targets] of Object.entries(RESEARCH_RUN_TRANSITIONS)) {
      for (const to of targets) {
        expect(() => validateRunTransition(from, to)).not.toThrow();
      }
    }
  });

  it('is idempotent for same-state writes, including terminal states', () => {
    expect(() => validateRunTransition('completed', 'completed')).not.toThrow();
    expect(() => validateRunTransition('running', 'running')).not.toThrow();
  });

  it('rejects transitions out of terminal states with a hint', () => {
    expect(() => validateRunTransition('completed', 'running')).toThrow(
      /terminal state/,
    );
  });

  it('rejects undeclared transitions and names the source', () => {
    try {
      validateRunTransition('draft', 'running', 'runner');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRunTransitionError);
      expect(String(error)).toContain('source=runner');
      expect(String(error)).toContain("allowed from 'draft'");
    }
  });

  it('rejects unknown states', () => {
    expect(() => validateRunTransition('zombie', 'running')).toThrow(/unknown state/);
  });

  it('lost can be reconciled back to running but never straight to completed', () => {
    expect(() => validateRunTransition('lost', 'running')).not.toThrow();
    expect(() => validateRunTransition('lost', 'completed')).toThrow();
  });

  it('failed can only requeue', () => {
    expect(() => validateRunTransition('failed', 'queued')).not.toThrow();
    expect(() => validateRunTransition('failed', 'running')).toThrow();
  });
});

describe('terminal states', () => {
  it('only completed and cancelled are terminal', () => {
    expect(isTerminalRunState('completed')).toBe(true);
    expect(isTerminalRunState('cancelled')).toBe(true);
    expect(isTerminalRunState('failed')).toBe(false);
    expect(isTerminalRunState('lost')).toBe(false);
  });
});

describe('RunHeartbeatSchema', () => {
  it('accepts a live heartbeat and a lost-pid heartbeat', () => {
    expect(
      RunHeartbeatSchema.parse({
        runId: 'run-1',
        at: '2026-07-29T12:00:00Z',
        pid: 41233,
        elapsedSeconds: 120,
      }).pid,
    ).toBe(41233);
    expect(
      RunHeartbeatSchema.parse({
        runId: 'run-1',
        at: '2026-07-29T12:00:05Z',
        pid: null,
        elapsedSeconds: 125,
      }).pid,
    ).toBeNull();
  });
});

const plan: ResearchExperimentPlan = {
  design: 'one-factor-at-a-time',
  baseline: {
    'pipeline.dataset.revision': 'sha256:data-v1',
    'pipeline.dataset.split': '80/10/10',
    'pipeline.preprocess.normalization': 'zscore',
    'pipeline.train.epochs': 100,
    'pipeline.train.optimizer': 'adamw',
  },
  factors: [
    {
      path: 'pipeline.preprocess.normalization',
      label: 'Normalization',
      values: ['none', 'zscore', 'minmax'],
    },
  ],
  controls: [
    'pipeline.dataset.revision',
    'pipeline.dataset.split',
    'pipeline.train.epochs',
    'pipeline.train.optimizer',
  ],
  seeds: [11, 22, 33],
};

describe('research experiment materialization', () => {
  it('expands one baseline and every non-baseline factor value for each seed', () => {
    const runs = materializeResearchExperimentPlan(plan);

    expect(runs).toHaveLength(9);
    expect(runs.filter((run) => run.kind === 'baseline')).toHaveLength(3);
    expect(runs.filter((run) => run.factorValue === 'none')).toHaveLength(3);
    expect(runs.filter((run) => run.factorValue === 'minmax')).toHaveLength(3);
    expect(runs.some((run) => run.factorValue === 'zscore')).toBe(false);
    expect(runs.map((run) => run.id)).toEqual([
      'baseline-s11',
      'baseline-s22',
      'baseline-s33',
      'pipeline-preprocess-normalization-none-s11',
      'pipeline-preprocess-normalization-none-s22',
      'pipeline-preprocess-normalization-none-s33',
      'pipeline-preprocess-normalization-minmax-s11',
      'pipeline-preprocess-normalization-minmax-s22',
      'pipeline-preprocess-normalization-minmax-s33',
    ]);
  });

  it('keeps every control equal to the baseline in generated configs', () => {
    const runs = materializeResearchExperimentPlan(plan);

    expect(validateMaterializedResearchRuns(plan, runs)).toEqual([]);
    for (const run of runs) {
      expect(run.config['pipeline.dataset.revision']).toBe('sha256:data-v1');
      expect(run.config['pipeline.train.epochs']).toBe(100);
      expect(run.config['research.seed']).toBe(run.seed);
    }
  });

  it('materializes multiple factor families as OFAT instead of a cartesian product', () => {
    const dataAwarePlan: ResearchExperimentPlan = {
      ...plan,
      baseline: {
        ...plan.baseline,
        'pipeline.subset.trainRatio': 1,
      },
      factors: [
        ...plan.factors,
        {
          path: 'pipeline.subset.trainRatio',
          label: 'Training subset',
          values: [0.25, 0.5, 1],
        },
      ],
    };

    const runs = materializeResearchExperimentPlan(dataAwarePlan);

    expect(runs).toHaveLength(15);
    expect(runs.filter((run) => run.factorLabel === 'Normalization')).toHaveLength(6);
    expect(runs.filter((run) => run.factorLabel === 'Training subset')).toHaveLength(6);
    expect(runs.every((run) => run.diff.filter((item) => item.kind === 'factor').length <= 1)).toBe(true);
  });

  it('rejects a field that is both a factor and a control', () => {
    const invalid = {
      ...plan,
      controls: [...plan.controls, 'pipeline.preprocess.normalization'],
    };

    expect(preflightResearchExperimentPlan(invalid)).toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({ code: 'factor-control-overlap' }),
      ],
    });
    expect(() => materializeResearchExperimentPlan(invalid)).toThrow(
      /cannot be both factor and control/,
    );
  });

  it('detects control drift in a materialized run', () => {
    const runs = materializeResearchExperimentPlan(plan);
    const first = runs[0];
    expect(first).toBeDefined();
    if (!first) return;

    const tampered = {
      ...first,
      config: { ...first.config, 'pipeline.train.epochs': 40 },
    };
    const issues = validateMaterializedResearchRuns(plan, [tampered]);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'control-drift' }),
        expect.objectContaining({ code: 'undeclared-change' }),
      ]),
    );
  });

  it('rejects empty seeds and duplicate factor values before materialization', () => {
    const noSeeds = { ...plan, seeds: [] };
    expect(preflightResearchExperimentPlan(noSeeds)).toMatchObject({
      ok: false,
      runCount: 0,
      issues: [expect.objectContaining({ code: 'invalid-plan' })],
    });

    const repeatedValue = {
      ...plan,
      factors: [
        {
          ...plan.factors[0]!,
          values: ['zscore', 'none', 'none'],
        },
      ],
    };
    expect(preflightResearchExperimentPlan(repeatedValue).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'duplicate-factor-value' }),
      ]),
    );
  });
});
