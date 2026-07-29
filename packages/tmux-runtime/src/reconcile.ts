import type { RemoteAgentSessionRecord } from '@cozypad/contracts';
import type { TmuxSessionInfo } from './runtime';

export interface ReconciliationResult {
  /** 狀態有變更的 records（不含未變更者）。 */
  updated: RemoteAgentSessionRecord[];
  /** 遠端存在但本機沒有記錄的 sdh_ sessions——不得靜默建立重複 session（§5.4）。 */
  orphanedLive: TmuxSessionInfo[];
}

const LIVE_KEEP_STATES = new Set(['running', 'waiting_approval', 'starting']);

/**
 * SPEC_V3 §5.4：連線／重連時比對本機 records 與 tmux 現況。
 * Gate A：session_id 相同但 session_created 不同代表 tmux server 重啟後
 * $N 被回收——不得誤認為舊 session。
 */
export function reconcileSessions(
  records: RemoteAgentSessionRecord[],
  liveSessions: TmuxSessionInfo[],
  now: string,
): ReconciliationResult {
  const liveById = new Map(liveSessions.map((session) => [session.sessionId, session]));
  const referencedIds = new Set<string>();
  const updated: RemoteAgentSessionRecord[] = [];

  for (const record of records) {
    const tmuxSessionId =
      record.identity?.tmuxSessionId ?? record.provisionalIdentity.tmuxSessionId;
    const live = liveById.get(tmuxSessionId);
    const epochMatches =
      live !== undefined &&
      (record.tmuxCreatedEpoch === null || record.tmuxCreatedEpoch === live.createdEpoch);

    if (live !== undefined && epochMatches) {
      referencedIds.add(tmuxSessionId);
      if (
        record.status === 'disconnected' ||
        record.status === 'exited' ||
        record.status === 'error'
      ) {
        updated.push({ ...record, status: 'ready', updatedAt: now });
      } else if (!LIVE_KEEP_STATES.has(record.status) && record.status !== 'ready') {
        updated.push({ ...record, status: 'ready', updatedAt: now });
      }
      continue;
    }

    if (record.status !== 'exited') {
      updated.push({ ...record, status: 'exited', updatedAt: now });
    }
  }

  const orphanedLive = liveSessions.filter(
    (session) => !referencedIds.has(session.sessionId),
  );
  return { updated, orphanedLive };
}
