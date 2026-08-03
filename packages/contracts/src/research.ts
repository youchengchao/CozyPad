import { z } from 'zod';

/**
 * Research run 狀態機（SPEC_V3 §18.6），驗證模式採 ADR 0001：
 * 顯式轉移鄰接表、同狀態冪等、顯式錯誤。
 */
export const ResearchRunStatusSchema = z.enum([
  'draft',
  'queued',
  'preflight',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'lost',
]);
export type ResearchRunStatus = z.infer<typeof ResearchRunStatusSchema>;

export const RESEARCH_RUN_TRANSITIONS: Record<
  ResearchRunStatus,
  readonly ResearchRunStatus[]
> = {
  draft: ['queued'],
  queued: ['preflight', 'cancelled'],
  preflight: ['running', 'failed', 'cancelled'],
  running: ['paused', 'completed', 'failed', 'cancelled', 'lost'],
  paused: ['running', 'cancelled'],
  /** retry 產生新 run（failed → queued 是 mermaid 圖中唯一的回頭路）。 */
  failed: ['queued'],
  /** tmux/job 被 reconciliation 找回時恢復。 */
  lost: ['running', 'failed'],
  completed: [],
  cancelled: [],
};

export const TERMINAL_RUN_STATES: readonly ResearchRunStatus[] = [
  'completed',
  'cancelled',
];

export class InvalidRunTransitionError extends Error {
  constructor(
    readonly fromState: string,
    readonly toState: string,
    readonly source: string,
  ) {
    const allowed = RESEARCH_RUN_TRANSITIONS[fromState as ResearchRunStatus];
    const hint =
      allowed === undefined
        ? `unknown state '${fromState}'`
        : allowed.length === 0
          ? `'${fromState}' is a terminal state`
          : `allowed from '${fromState}': ${allowed.join(', ')}`;
    super(`invalid run transition '${fromState}' → '${toState}' (source=${source}); ${hint}`);
  }
}

/** 同狀態寫入為冪等 no-op；未知或未允許的轉移擲出顯式錯誤。 */
export function validateRunTransition(
  fromState: string,
  toState: string,
  source = 'unknown',
): void {
  if (fromState === toState) return;
  const allowed = RESEARCH_RUN_TRANSITIONS[fromState as ResearchRunStatus] as
    | readonly string[]
    | undefined;
  if (allowed === undefined || !allowed.includes(toState)) {
    throw new InvalidRunTransitionError(fromState, toState, source);
  }
}

export function isTerminalRunState(state: ResearchRunStatus): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

/**
 * 遠端 run 目錄的 heartbeat 檔（ADR 0001）：PID 消失且無 exit code → lost，
 * 不得推定成功或失敗。
 */
export const RunHeartbeatSchema = z.object({
  runId: z.string().min(1),
  at: z.string(),
  pid: z.number().int().nullable(),
  elapsedSeconds: z.number().min(0),
});
export type RunHeartbeat = z.infer<typeof RunHeartbeatSchema>;

/**
 * Research Lab 初版的 experiment design contract。
 *
 * Pipeline editor 與 YAML editor 之後都應產生這個結構；執行前再把它展開成
 * immutable runs。第一版刻意只支援 one-factor-at-a-time，避免 UI 與 runner
 * 同時背負完整 factorial design 的複雜度。
 */
export const ResearchParameterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
]);
export type ResearchParameterValue = z.infer<
  typeof ResearchParameterValueSchema
>;

export const ResearchFactorSchema = z.object({
  path: z.string().min(1),
  label: z.string().min(1),
  values: z.array(ResearchParameterValueSchema).min(1),
});
export type ResearchFactor = z.infer<typeof ResearchFactorSchema>;

export const ResearchExperimentPlanSchema = z.object({
  design: z.literal('one-factor-at-a-time'),
  baseline: z.record(z.string(), ResearchParameterValueSchema),
  factors: z.array(ResearchFactorSchema),
  controls: z.array(z.string().min(1)),
  seeds: z.array(z.number().int().nonnegative()).min(1),
});
export type ResearchExperimentPlan = z.infer<
  typeof ResearchExperimentPlanSchema
>;

export interface MaterializedResearchRunDiff {
  path: string;
  baseline: ResearchParameterValue | undefined;
  value: ResearchParameterValue;
  kind: 'factor' | 'replicate';
}

export interface MaterializedResearchRun {
  id: string;
  kind: 'baseline' | 'ablation';
  factorPath?: string;
  factorLabel?: string;
  factorValue?: ResearchParameterValue;
  seed: number;
  config: Record<string, ResearchParameterValue>;
  diff: MaterializedResearchRunDiff[];
}

export type ResearchPreflightIssueCode =
  | 'invalid-plan'
  | 'duplicate-factor'
  | 'duplicate-factor-value'
  | 'duplicate-control'
  | 'duplicate-seed'
  | 'missing-baseline'
  | 'factor-control-overlap'
  | 'control-drift'
  | 'undeclared-change'
  | 'invalid-factor-count';

export interface ResearchPreflightIssue {
  code: ResearchPreflightIssueCode;
  path: string;
  message: string;
  runId?: string;
}

export interface ResearchPreflightResult {
  ok: boolean;
  issues: ResearchPreflightIssue[];
  runCount: number;
}

export class InvalidExperimentPlanError extends Error {
  constructor(readonly issues: readonly ResearchPreflightIssue[]) {
    super(
      issues.length === 0
        ? 'invalid experiment plan'
        : `invalid experiment plan: ${issues.map((issue) => issue.message).join('; ')}`,
    );
  }
}

function hasOwn(
  value: Record<string, ResearchParameterValue>,
  path: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, path);
}

function valueEquals(
  left: ResearchParameterValue | undefined,
  right: ResearchParameterValue | undefined,
): boolean {
  return Object.is(left, right);
}

function slug(value: ResearchParameterValue | string): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'value';
}

function duplicateValues<T>(values: readonly T[]): Set<T> {
  const seen = new Set<T>();
  const duplicates = new Set<T>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function materializeUnchecked(
  plan: ResearchExperimentPlan,
): MaterializedResearchRun[] {
  const runs: MaterializedResearchRun[] = [];

  const addRun = (
    seed: number,
    factor?: ResearchFactor,
    factorValue?: ResearchParameterValue,
  ): void => {
    const factorSlug = factor
      ? `${slug(factor.path)}-${slug(factorValue ?? 'value')}`
      : 'baseline';
    const diff: MaterializedResearchRunDiff[] = [
      {
        path: 'research.seed',
        baseline: undefined,
        value: seed,
        kind: 'replicate',
      },
    ];
    const config: Record<string, ResearchParameterValue> = {
      ...plan.baseline,
      'research.seed': seed,
    };

    if (factor && factorValue !== undefined) {
      config[factor.path] = factorValue;
      diff.unshift({
        path: factor.path,
        baseline: plan.baseline[factor.path],
        value: factorValue,
        kind: 'factor',
      });
    }

    runs.push({
      id: `${factorSlug}-s${seed}`,
      kind: factor ? 'ablation' : 'baseline',
      factorPath: factor?.path,
      factorLabel: factor?.label,
      factorValue,
      seed,
      config,
      diff,
    });
  };

  for (const seed of plan.seeds) addRun(seed);

  for (const factor of plan.factors) {
    const baselineValue = plan.baseline[factor.path];
    for (const factorValue of factor.values) {
      if (valueEquals(factorValue, baselineValue)) continue;
      for (const seed of plan.seeds) addRun(seed, factor, factorValue);
    }
  }

  return runs;
}

function validatePlanShape(
  plan: ResearchExperimentPlan,
): ResearchPreflightIssue[] {
  const issues: ResearchPreflightIssue[] = [];

  for (const path of duplicateValues(plan.factors.map((factor) => factor.path))) {
    issues.push({
      code: 'duplicate-factor',
      path,
      message: `factor '${path}' is declared more than once`,
    });
  }

  for (const path of duplicateValues(plan.controls)) {
    issues.push({
      code: 'duplicate-control',
      path,
      message: `control '${path}' is declared more than once`,
    });
  }

  for (const seed of duplicateValues(plan.seeds)) {
    issues.push({
      code: 'duplicate-seed',
      path: 'research.seed',
      message: `seed '${seed}' is declared more than once`,
    });
  }

  const controls = new Set(plan.controls);
  for (const factor of plan.factors) {
    for (const value of duplicateValues(factor.values)) {
      issues.push({
        code: 'duplicate-factor-value',
        path: factor.path,
        message: `factor '${factor.path}' repeats value '${String(value)}'`,
      });
    }
    if (!hasOwn(plan.baseline, factor.path)) {
      issues.push({
        code: 'missing-baseline',
        path: factor.path,
        message: `factor '${factor.path}' has no baseline value`,
      });
    }
    if (controls.has(factor.path)) {
      issues.push({
        code: 'factor-control-overlap',
        path: factor.path,
        message: `'${factor.path}' cannot be both factor and control`,
      });
    }
  }

  for (const path of plan.controls) {
    if (!hasOwn(plan.baseline, path)) {
      issues.push({
        code: 'missing-baseline',
        path,
        message: `control '${path}' has no baseline value`,
      });
    }
  }

  return issues;
}

/** 驗證 materialized runs 沒有未宣告變動或 control drift。 */
export function validateMaterializedResearchRuns(
  plan: ResearchExperimentPlan,
  runs: readonly MaterializedResearchRun[],
): ResearchPreflightIssue[] {
  const issues: ResearchPreflightIssue[] = [];
  const declaredFactors = new Set(plan.factors.map((factor) => factor.path));

  for (const run of runs) {
    for (const control of plan.controls) {
      if (!valueEquals(run.config[control], plan.baseline[control])) {
        issues.push({
          code: 'control-drift',
          path: control,
          runId: run.id,
          message: `run '${run.id}' changed locked control '${control}'`,
        });
      }
    }

    const paths = new Set([
      ...Object.keys(plan.baseline),
      ...Object.keys(run.config),
    ]);
    const changedFactors: string[] = [];
    for (const path of paths) {
      if (path === 'research.seed') continue;
      if (valueEquals(run.config[path], plan.baseline[path])) continue;
      if (!declaredFactors.has(path)) {
        issues.push({
          code: 'undeclared-change',
          path,
          runId: run.id,
          message: `run '${run.id}' changed undeclared field '${path}'`,
        });
      } else {
        changedFactors.push(path);
      }
    }

    const expectedCount = run.kind === 'baseline' ? 0 : 1;
    if (changedFactors.length !== expectedCount) {
      issues.push({
        code: 'invalid-factor-count',
        path: run.factorPath ?? 'baseline',
        runId: run.id,
        message: `run '${run.id}' changes ${changedFactors.length} factors; expected ${expectedCount}`,
      });
    }
  }

  return issues;
}

/** 展開並驗證 plan；UI 可用 runCount 即時預覽 launch 規模。 */
export function preflightResearchExperimentPlan(
  plan: ResearchExperimentPlan,
): ResearchPreflightResult {
  const parsed = ResearchExperimentPlanSchema.safeParse(plan);
  if (!parsed.success) {
    return {
      ok: false,
      runCount: 0,
      issues: parsed.error.issues.map((issue) => ({
        code: 'invalid-plan',
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  const validatedPlan = parsed.data;
  const shapeIssues = validatePlanShape(validatedPlan);
  const runs = materializeUnchecked(validatedPlan);
  const runIssues =
    shapeIssues.length === 0
      ? validateMaterializedResearchRuns(validatedPlan, runs)
      : [];
  const issues = [...shapeIssues, ...runIssues];
  return { ok: issues.length === 0, issues, runCount: runs.length };
}

/** 將 OFAT plan 展開成 immutable run configs；無效 plan 不會被靜默修正。 */
export function materializeResearchExperimentPlan(
  plan: ResearchExperimentPlan,
): MaterializedResearchRun[] {
  const preflight = preflightResearchExperimentPlan(plan);
  if (!preflight.ok) throw new InvalidExperimentPlanError(preflight.issues);
  return materializeUnchecked(plan);
}
