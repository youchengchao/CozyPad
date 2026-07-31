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
