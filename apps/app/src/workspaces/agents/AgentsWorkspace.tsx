import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AgentInstallation,
  AgentKind,
  AgentSessionStatus,
  AgentSessionSummary,
  ChatItem,
  ConnectionState,
  DeleteScopeResult,
  RemoteFileItem,
  SlashCommand,
} from '@cozypad/contracts';
import { MAX_AGENT_ATTACHMENTS } from '@cozypad/contracts';
import { ContextMenu, useLongPress } from '../../components/ContextMenu';
import { getBridge } from '../../platform/bridge';
import {
  AgyCliSurface,
  AgyTranscriptPreview,
  clearAgyRuntimeCache,
  clearAgySessionCache,
} from './AgyCliSurface';
import { ChatComposer } from './ChatComposer';
import {
  attachmentFileToBase64,
  bufferAttachmentFiles,
} from './attachmentBuffer';
import type { ComposerAttachment } from './attachmentBuffer';
import {
  createAgentSessionViewState,
  enterSelectedSession,
  forgetSessionView,
  leaveEnteredSession,
  reconcileSessionView,
  selectSessionForPreview,
} from './agentSessionViewState';
import { ChatTimeline, TimelineErrorBoundary } from './ChatTimeline';

export interface AgentsWorkspaceErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

export interface AgentsWorkspaceErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class AgentsWorkspaceErrorBoundary extends Component<
  AgentsWorkspaceErrorBoundaryProps,
  AgentsWorkspaceErrorBoundaryState
> {
  constructor(props: AgentsWorkspaceErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): AgentsWorkspaceErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('AgentsWorkspaceErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="agent-workspace-error-fallback" role="alert">
          <div className="error-fallback-head">
            <h2>⚠️ Agents Workspace Encountered an Error</h2>
          </div>
          <p className="error-fallback-message">
            {this.state.error?.message ?? 'An unexpected error occurred in the agent workspace.'}
          </p>
          <div className="error-fallback-actions">
            <button
              className="composer-send"
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              Reload Workspace
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const AGENTS: { kind: AgentKind; label: string }[] = [
  { kind: 'claude', label: 'Claude' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'agy', label: 'agy' },
];

const STATUS_LABEL: Record<AgentSessionStatus, string> = {
  starting: 'starting',
  ready: 'ready',
  running: 'running',
  waiting_approval: 'needs input',
  disconnected: 'offline',
  exited: 'exited',
  error: 'error',
};

/** SPEC 1136-1144: one bucket per 3.4.13 status family, none folded away. */
type SessionBucket = 'running' | 'needsInput' | 'idle' | 'exited' | 'error';

const BUCKET_LABEL: Record<SessionBucket, string> = {
  running: 'running',
  needsInput: 'needs input',
  idle: 'idle',
  exited: 'exited',
  error: 'error',
};

/** SPEC 1496-1508: every delete scope names itself and its actual impact. */
const DELETE_SCOPE_COPY: Record<
  DeleteScopeResult['scope'],
  { label: string; impact: string }
> = {
  localIndex: {
    label: '本機索引與 Timeline',
    impact: '從 CozyPad 移除，無法復原',
  },
  process: { label: 'Agent Process（tmux session）', impact: '立即終止' },
  remoteEvents: {
    label: '遠端事件記錄',
    impact: '刪除主機上的事件與紀錄，無法復原',
  },
  remoteAttachments: {
    label: '遠端附件暫存',
    impact: '刪除主機上的附件暫存，無法復原',
  },
  nativeConversation: {
    label: 'Agent 原生對話',
    impact: 'Agent 不支援刪除；會保留在 Agent 自己的儲存中',
  },
};

const DELETE_OUTCOME_LABEL: Record<DeleteScopeResult['outcome'], string> = {
  done: '完成',
  skipped: '未執行',
  unsupported: '不支援',
  failed: '失敗',
};

/**
 * One switch produces both the composer's disabled flag and its reason
 * (SPEC 1362-1364) so the two can never drift apart.
 */
function composerAvailability(
  session: AgentSessionSummary,
  uploading: boolean,
): { disabled: boolean; reason?: { text: string; nextStep?: string } } {
  if (uploading) {
    return { disabled: true, reason: { text: '正在傳送 Prompt 與附件…' } };
  }
  switch (session.status) {
    case 'running':
      return {
        disabled: true,
        reason: {
          text: 'Agent 正在執行上一個 Prompt',
          nextStep: '等待完成，或按 Stop 中止',
        },
      };
    case 'waiting_approval':
      return {
        disabled: true,
        reason: {
          text: 'Agent 正在等待你的回覆',
          nextStep: '在上方的 Approval／Question 卡片作答',
        },
      };
    case 'starting':
      // SPEC 207-209: the first prompt is sent while the agent is still
      // Starting. Claude reads stdin from launch; Codex has no thread yet.
      return session.agentKind === 'claude'
        ? { disabled: false }
        : {
            disabled: true,
            reason: {
              text: 'Agent 正在啟動',
              nextStep: '取得對話 ID 後即可輸入',
            },
          };
    case 'disconnected':
      return {
        disabled: true,
        reason: { text: '主機連線已中斷', nextStep: '重新連線後按 Resume' },
      };
    case 'exited':
      return {
        disabled: true,
        reason: { text: 'Agent process 已結束', nextStep: '按 Resume 重新啟動' },
      };
    case 'error':
      return {
        disabled: true,
        reason: { text: 'Agent 發生錯誤', nextStep: '按 Resume 重新啟動' },
      };
    default:
      return { disabled: false };
  }
}

function sessionBucket(status: AgentSessionStatus): SessionBucket {
  if (status === 'running' || status === 'starting') return 'running';
  // A session waiting on an Approval/Question hid inside "running", and a
  // disconnected one inside "idle" looked healthy — both unfindable.
  if (status === 'waiting_approval') return 'needsInput';
  if (status === 'exited') return 'exited';
  if (status === 'error' || status === 'disconnected') return 'error';
  return 'idle';
}

const SLASH_COMMAND_DESCRIPTIONS: Record<string, string> = {
  'add-dir': 'Add a directory to later agent turns',
  agents: 'Manage or inspect delegated agents',
  btw: 'Ask a side question without interrupting the current task',
  clear: 'Clear the current conversation context',
  compact: 'Compact the conversation context',
  context: 'Show current context usage',
  diff: 'Show current workspace changes',
  effort: 'Change the reasoning effort',
  fork: 'Fork this conversation',
  fast: 'Use the agent fast execution mode',
  help: 'Show commands supported in CozyPad',
  keybindings: 'Show or configure keyboard shortcuts',
  mcp: 'Manage MCP servers',
  model: 'Select or inspect the current model',
  open: 'Open a file or location',
  permissions: 'Review or change the permission mode',
  plan: 'Enter or inspect plan mode',
  planning: 'Use the agent planning mode',
  rename: 'Rename the agent conversation',
  resume: 'Resume a previous conversation',
  review: 'Review current code changes',
  rewind: 'Rewind the conversation',
  skills: 'List or run installed skills',
  status: 'Show current session status',
  statusline: 'Configure the status line',
  tasks: 'Show background tasks',
  usage: 'Show token and usage information',
};

function slashCommandDescription(
  agentKind: AgentKind,
  name: string,
  descriptions?: Record<string, string>,
): string {
  const normalized = name.replace(/^\/+/, '').toLowerCase();
  return (
    descriptions?.[normalized] ??
    SLASH_COMMAND_DESCRIPTIONS[normalized] ??
    `Available in this ${agentKind} session`
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function environmentText(installation: AgentInstallation): string | null {
  const environment = installation.environment;
  if (environment === undefined) return null;
  const platform = environment.distribution ?? environment.osName;
  return [platform, environment.kernelRelease, environment.architecture]
    .filter((value): value is string => value !== undefined && value !== '')
    .join(' ');
}

function SessionListItem({
  session,
  status,
  active,
  resuming,
  menuOpen,
  onActivate,
  onOpenMenu,
}: {
  session: AgentSessionSummary;
  status: AgentSessionStatus;
  active: boolean;
  resuming: boolean;
  menuOpen: boolean;
  onActivate(): void;
  onOpenMenu(x: number, y: number): void;
}) {
  const longPressOpened = useRef(false);
  const longPress = useLongPress((x, y, gesture) => {
    longPressOpened.current = gesture === 'longpress';
    onOpenMenu(x, y);
  });

  return (
    <button
      data-session-id={session.id}
      className={`session-item${active ? ' session-item-active' : ''}`}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onClick={() => {
        if (!longPressOpened.current) onActivate();
        longPressOpened.current = false;
      }}
      onContextMenu={longPress.onContextMenu}
      onPointerDown={(event) => {
        longPressOpened.current = false;
        longPress.onPointerDown(event);
      }}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
    >
      <span className="session-title">{session.title}</span>
      <span className="session-meta">
        {session.host} · {session.project}
      </span>
      <span className="session-footer">
        <span className={`chip chip-${status}`}>
          {resuming ? 'resuming…' : STATUS_LABEL[status]}
        </span>
        <span className="session-time">{formatTime(session.updatedAt)}</span>
      </span>
    </button>
  );
}

function ZeroMessageState({
  sessionTitle,
  agentKind,
  onSelectSuggestion,
}: {
  sessionTitle: string;
  agentKind: AgentKind;
  onSelectSuggestion?: (text: string) => void;
}) {
  const agentLabel = AGENTS.find((a) => a.kind === agentKind)?.label ?? agentKind;
  const icon = agentKind === 'claude' ? '✦' : agentKind === 'codex' ? '⚙' : '⚡';

  return (
    <div className="zero-message-state">
      <div className="zero-message-card">
        <div className="zero-message-header">
          <div className="zero-message-avatar">{icon}</div>
          <div>
            <h3>{sessionTitle}</h3>
            <span className="hint">{agentLabel} Agent Workspace</span>
          </div>
        </div>
        <p className="zero-message-description">
          This session has no messages yet. Send a message or select a slash command below to start working with {agentLabel}.
        </p>
        <div className="zero-message-suggestions">
          <span className="suggestions-label">Suggested actions</span>
          <div className="suggestion-chips">
            <button
              className="suggestion-chip"
              onClick={() => onSelectSuggestion?.('/help')}
            >
              <code>/help</code> — Show commands
            </button>
            <button
              className="suggestion-chip"
              onClick={() => onSelectSuggestion?.('/status')}
            >
              <code>/status</code> — Session status
            </button>
            <button
              className="suggestion-chip"
              onClick={() =>
                onSelectSuggestion?.(
                  'What can you help me with in this project?',
                )
              }
            >
              Overview project
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface AgentsWorkspaceProps {
  connected: boolean;
  connectionState?: ConnectionState;
  reconnect?: { attempt: number; secondsLeft: number } | null;
  profileId: string | null;
}

export function AgentsWorkspace({
  connected,
  connectionState,
  reconnect,
  profileId,
}: AgentsWorkspaceProps) {
  const bridge = useMemo(() => getBridge(), []);
  const [agent, setAgent] = useState<AgentKind>('claude');
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [timelines, setTimelines] = useState<Record<string, ChatItem[]>>({});
  const [installations, setInstallations] = useState<
    Partial<Record<AgentKind, AgentInstallation>>
  >({});
  const [sessionView, setSessionView] = useState(createAgentSessionViewState);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<
    Record<string, ComposerAttachment[]>
  >({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const attachmentSendInFlight = useRef(new Set<string>());
  const retryInFlightRef = useRef(new Set<string>());

  const prevConnectedRef = useRef(connected);
  useEffect(() => {
    if (prevConnectedRef.current && !connected) {
      setTimelines((current) => {
        let changed = false;
        const next = { ...current };
        for (const [sId, items] of Object.entries(next)) {
          let itemChanged = false;
          const updatedItems = items.map((item) => {
            if (item.kind === 'message' && item.streaming) {
              itemChanged = true;
              return { ...item, streaming: false, interrupted: true };
            }
            if (item.kind === 'tool_call' && item.status === 'running') {
              itemChanged = true;
              return {
                ...item,
                status: 'error' as const,
                output:
                  (item.output ? item.output + '\n' : '') +
                  '[連線中斷 — Agent 執行已中斷]',
              };
            }
            return item;
          });
          if (itemChanged) {
            changed = true;
            next[sId] = [
              ...updatedItems,
              {
                kind: 'notice',
                id: `notice-disrupt-${Date.now()}`,
                text: '⚡ 連線中斷 — Agent 執行已中斷',
              },
            ];
          }
        }
        return changed ? next : current;
      });
    }
    prevConnectedRef.current = connected;
  }, [connected]);
  /** SPEC 318-331: prompts whose delivery outcome is overdue, per session. */
  const [sendUnconfirmed, setSendUnconfirmed] = useState<
    Record<string, { text: string }>
  >({});
  const sendTimersRef = useRef<Record<string, number>>({});
  const [interrupting, setInterrupting] = useState<Record<string, boolean>>({});
  const [filters, setFilters] = useState<Record<AgentKind, string>>({
    claude: '',
    codex: '',
    agy: '',
  });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [launchMode, setLaunchMode] = useState('default');
  const [createCwd, setCreateCwd] = useState('$HOME');
  const [directoryJump, setDirectoryJump] = useState('$HOME');
  const [directoryItems, setDirectoryItems] = useState<RemoteFileItem[]>([]);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [directoryTruncated, setDirectoryTruncated] = useState(false);
  const [renameSession, setRenameSession] = useState<AgentSessionSummary | null>(
    null,
  );
  const [deleteOutcome, setDeleteOutcome] = useState<{
    title: string;
    scopes: DeleteScopeResult[];
  } | null>(null);
  const [deleteSession, setDeleteSession] = useState<AgentSessionSummary | null>(
    null,
  );
  const [sessionMenu, setSessionMenu] = useState<{
    session: AgentSessionSummary;
    x: number;
    y: number;
  } | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [modelPickerSessionId, setModelPickerSessionId] = useState<string | null>(
    null,
  );
  const [modelName, setModelName] = useState('');
  /** Live status for native AGY sessions, whose record status never changes. */
  const [agyActivity, setAgyActivity] = useState<Record<string, AgentSessionStatus>>({});
  const [bucketFilter, setBucketFilter] = useState<SessionBucket | 'all'>('all');
  const [resuming, setResuming] = useState<Record<string, boolean>>({});
  /**
   * Bumped when a session is revived. The AGY surface is keyed on it: the old
   * surface's terminal died with the old process, so the new process needs a
   * fresh mount to attach to.
   */
  const [reviveNonce, setReviveNonce] = useState<Record<string, number>>({});

  /* ---- Sidebar drag-to-resize (VS Code style) ---- */
  const SIDEBAR_MIN = 180;
  const SIDEBAR_ABSOLUTE_MAX = 600;
  const CHAT_MIN = 360;
  const SIDEBAR_DEFAULT = 286;
  const SIDEBAR_STORAGE_KEY = 'cozypad-agent-sidebar-width';
  const panesRef = useRef<HTMLDivElement>(null);

  /** Dynamic max: leave at least CHAT_MIN for the chat column, strictly <= 600px. */
  const sidebarMax = useCallback(() => {
    const panes = panesRef.current;
    if (panes === null) return SIDEBAR_ABSOLUTE_MAX;
    const available = panes.clientWidth - CHAT_MIN - 4;
    return Math.min(SIDEBAR_ABSOLUTE_MAX, Math.max(SIDEBAR_MIN, available));
  }, []);

  const clamp = useCallback(
    (w: number) => Math.max(SIDEBAR_MIN, Math.min(sidebarMax(), w)),
    [sidebarMax],
  );

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (stored !== null) {
        const parsed = Number(stored);
        if (Number.isFinite(parsed)) return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_ABSOLUTE_MAX, parsed));
      }
    } catch { /* ignore */ }
    return SIDEBAR_DEFAULT;
  });

  const sidebarDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    sidebarDragRef.current = { startX: e.clientX, startWidth: sidebarWidth };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [sidebarWidth]);

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (sidebarDragRef.current === null) return;
    const delta = e.clientX - sidebarDragRef.current.startX;
    const nextW = clamp(sidebarDragRef.current.startWidth + delta);
    setSidebarWidth(nextW);
    try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(nextW)); } catch { /* ignore */ }
  }, [clamp]);

  const onResizePointerUp = useCallback((e: React.PointerEvent) => {
    if (sidebarDragRef.current === null) return;
    const delta = e.clientX - sidebarDragRef.current.startX;
    const finalW = clamp(sidebarDragRef.current.startWidth + delta);
    sidebarDragRef.current = null;
    setSidebarWidth(finalW);
    try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(finalW)); } catch { /* ignore */ }
  }, [clamp]);

  const onResizeDoubleClick = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT);
    try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(SIDEBAR_DEFAULT)); } catch { /* ignore */ }
  }, []);

  /**
   * Sessions the user removed. A late update for one — a follow stream ending,
   * a status settling — must not resurrect the row it was deleted from.
   */
  const forgotten = useRef(new Set<string>());
  const loadedProfileId = useRef<string | null>(null);

  /** Drop every trace of a session from the UI. */
  const forgetSession = useCallback((sessionId: string, agentKind: AgentKind) => {
    forgotten.current.add(sessionId);
    clearAgySessionCache(sessionId);
    setSessions((current) => current.filter((session) => session.id !== sessionId));
    setSessionView((current) => forgetSessionView(current, agentKind, sessionId));
    const drop = <T,>(current: Record<string, T>): Record<string, T> => {
      if (!(sessionId in current)) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    };
    setTimelines(drop);
    setDrafts(drop);
    setAttachments((current) => {
      current[sessionId]?.forEach((attachment) => {
        if (attachment.previewUrl !== undefined) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
      return drop(current);
    });
    setUploading(drop);
    setResuming(drop);
    setInterrupting(drop);
    setAgyActivity(drop);
    // A pending delivery timer must not write back a key that is gone.
    const timer = sendTimersRef.current[sessionId];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete sendTimersRef.current[sessionId];
    }
    setSendUnconfirmed(drop);
    attachmentSendInFlight.current.delete(sessionId);
    setRenameSession((current) => (current?.id === sessionId ? null : current));
    setDeleteSession((current) => (current?.id === sessionId ? null : current));
    setSessionMenu((current) =>
      current?.session.id === sessionId ? null : current,
    );
    setModelPickerSessionId((current) => (current === sessionId ? null : current));
  }, []);

  useEffect(() => {
    const unsubscribeSession = bridge.onAgentSessionChanged(({ session }) => {
      if (forgotten.current.has(session.id)) return;
      setSessions((current) => {
        const exists = current.some((candidate) => candidate.id === session.id);
        return exists
          ? current.map((candidate) =>
              candidate.id === session.id ? session : candidate,
            )
          : [session, ...current];
      });
      if (session.status === 'exited' || session.status === 'error') {
        setSessionView((current) =>
          leaveEnteredSession(current, session.agentKind, session.id),
        );
      }
    });
    const unsubscribeTimeline = bridge.onAgentTimelineChanged(
      ({ sessionId, items }) => {
        // SPEC 1514-1515: late events must not resurrect a deleted session.
        if (forgotten.current.has(sessionId)) return;
        setTimelines((current) => ({ ...current, [sessionId]: items }));
      },
    );
    const unsubscribeDeleted = bridge.onAgentSessionDeleted(
      ({ sessionId, agentKind }) => forgetSession(sessionId, agentKind),
    );
    const unsubscribeError = bridge.onAgentCommunicationError((event) => {
      // A deletion that succeeded locally must not re-surface as red text.
      if (event.sessionId !== undefined && forgotten.current.has(event.sessionId)) {
        return;
      }
      setError(event.message);
    });
    return () => {
      unsubscribeSession();
      unsubscribeTimeline();
      unsubscribeDeleted();
      unsubscribeError();
    };
  }, [bridge, forgetSession]);

  useEffect(() => {
    setSessionView((current) => reconcileSessionView(current, sessions));
  }, [sessions]);

  useEffect(() => {
    if (profileId === null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    if (loadedProfileId.current !== profileId) {
      loadedProfileId.current = profileId;
      setSessions([]);
      setTimelines({});
      setSessionView(createAgentSessionViewState());
    }
    if (!connected) {
      // SPEC 256-262/1512: saved sessions are previewable and manageable
      // without a process — and without a connection. The store lives on
      // this side; only agent detection needs the host.
      setLoading(true);
      void bridge
        .listAgentSessions({ profileId })
        .then((bundles) => {
          if (cancelled) return;
          setSessions(bundles.map((bundle) => bundle.session));
          setTimelines(
            Object.fromEntries(
              bundles.map((bundle) => [bundle.session.id, bundle.items]),
            ),
          );
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    setError(null);
    void Promise.all([
      bridge.listAgentSessions({ profileId }),
      ...AGENTS.map(async ({ kind }) => {
        try {
          return await bridge.detectAgent({ profileId, agentKind: kind });
        } catch (detectionError) {
          return {
            agentKind: kind,
            installed: false,
            supportsStructuredOutput: false,
            supportsResume: false,
            supportsInteractiveApproval: false,
            launchModes: [],
            detail: errorText(detectionError),
          } satisfies AgentInstallation;
        }
      }),
    ])
      .then(([bundles, ...detected]) => {
        if (cancelled) return;
        setSessions(bundles.map((bundle) => bundle.session));
        setTimelines(
          Object.fromEntries(
            bundles.map((bundle) => [bundle.session.id, bundle.items]),
          ),
        );
        setInstallations(
          Object.fromEntries(
            detected.map((installation) => [
              installation.agentKind,
              installation,
            ]),
          ),
        );
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(errorText(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, connected, profileId]);

  /**
   * A native AGY session's stored status is written once at launch, so the
   * only thing that knows whether it is thinking right now is the live
   * screen. But the service is the authority on liveness: once it says the
   * process is disconnected/exited/errored, a stale screen-derived guess —
   * the surface unmounted long ago — must not resurrect it as "ready".
   */
  const liveStatus = useCallback(
    (session: AgentSessionSummary): AgentSessionStatus => {
      if (session.agentKind !== 'agy') return session.status;
      if (
        session.status === 'disconnected' ||
        session.status === 'exited' ||
        session.status === 'error'
      ) {
        return session.status;
      }
      return agyActivity[session.id] ?? session.status;
    },
    [agyActivity],
  );

  const searchedSessions = useMemo(
    () =>
      sessions
        .filter((session) => session.agentKind === agent)
        .filter((session) =>
          filters[agent] === ''
            ? true
            : `${session.title} ${session.host} ${session.project}`
                .toLowerCase()
                .includes(filters[agent].toLowerCase()),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [sessions, agent, filters],
  );
  // Counted before the bucket filter narrows the list, so every chip shows
  // what it would reveal rather than what currently survives it.
  const bucketCounts = useMemo(() => {
    const counts: Record<SessionBucket, number> = {
      running: 0,
      needsInput: 0,
      idle: 0,
      exited: 0,
      error: 0,
    };
    for (const session of searchedSessions) {
      counts[sessionBucket(liveStatus(session))] += 1;
    }
    return counts;
  }, [searchedSessions, liveStatus]);
  const agentSessions = useMemo(
    () =>
      bucketFilter === 'all'
        ? searchedSessions
        : searchedSessions.filter(
            (session) => sessionBucket(liveStatus(session)) === bucketFilter,
          ),
    [searchedSessions, bucketFilter, liveStatus],
  );

  const selectedSessionId = sessionView.selected[agent];
  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ?? null;
  const selectedSessionEntered =
    selectedSession !== null &&
    sessionView.entered[agent] === selectedSession.id;
  const timeline = selectedSessionId ? (timelines[selectedSessionId] ?? []) : [];
  const promptHistory = useMemo(
    () =>
      timeline
        .filter(
          (item): item is Extract<ChatItem, { kind: 'message' }> =>
            item.kind === 'message' && item.role === 'user' && item.text.trim() !== '',
        )
        .map((item) => item.text),
    [timeline],
  );
  // SPEC 1225-1226 (display half): the header always states usage — a
  // figure when the agent has reported one, 「用量未知」 otherwise, never
  // silence. AGY has its own statusline for this.
  const lastUsage = useMemo(
    () =>
      [...timeline]
        .reverse()
        .find(
          (item): item is Extract<ChatItem, { kind: 'usage' }> =>
            item.kind === 'usage',
        ),
    [timeline],
  );
  const installation = installations[agent];
  const canCreate =
    connected &&
    profileId !== null &&
    installation?.installed === true &&
    installation.installationScope === 'user' &&
    (agent === 'agy' || installation.supportsStructuredOutput) &&
    installation.launchModes.length > 0;
  const agentUnavailable =
    installation !== undefined &&
    (!installation.installed ||
      (agent !== 'agy' && !installation.supportsStructuredOutput));

  // The screen-derived AGY activity dies with the surface: keeping the last
  // guess after leaving the session let it override every later status the
  // service reported. A revive remount keeps the same entered id, so this
  // only clears on a genuine leave.
  const enteredAgySessionId =
    agent === 'agy' && selectedSessionEntered ? (selectedSession?.id ?? null) : null;
  const previousEnteredAgyRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousEnteredAgyRef.current;
    if (previous !== null && previous !== enteredAgySessionId) {
      setAgyActivity((current) => {
        if (!(previous in current)) return current;
        const next = { ...current };
        delete next[previous];
        return next;
      });
    }
    previousEnteredAgyRef.current = enteredAgySessionId;
  }, [enteredAgySessionId]);

  const badge = (kind: AgentKind) => {
    const mine = sessions.filter((session) => session.agentKind === kind);
    // Same source as the list rows; reading raw session.status here made the
    // tab dot and the list disagree about the same session.
    return {
      waiting: mine.some((session) => liveStatus(session) === 'waiting_approval'),
      running: mine.some((session) => liveStatus(session) === 'running'),
      unread: mine.reduce((sum, session) => sum + session.unread, 0),
    };
  };

  const loadCreateDirectory = async (directory: string) => {
    setDirectoryLoading(true);
    setDirectoryError(null);
    try {
      const listing = await bridge.fsList({ path: directory });
      setCreateCwd(listing.path);
      setDirectoryJump(listing.path);
      setDirectoryItems(
        listing.items.filter(
          (item) => item.type === 'd' || (item.type === 'l' && item.targetType === 'd'),
        ),
      );
      setDirectoryTruncated(listing.truncated);
    } catch (directoryLoadError) {
      setDirectoryError(errorText(directoryLoadError));
    } finally {
      setDirectoryLoading(false);
    }
  };

  const openCreate = () => {
    const initialDirectory = selectedSession?.cwd ?? '~';
    setCreateCwd(initialDirectory);
    setDirectoryJump(initialDirectory);
    setDirectoryItems([]);
    setDirectoryError(null);
    setCreateTitle('');
    setLaunchMode(installation?.launchModes[0]?.id ?? 'default');
    setCreateOpen(true);
    void loadCreateDirectory(initialDirectory);
  };

  const parentDirectory =
    createCwd === '/'
      ? '/'
      : createCwd.slice(0, createCwd.lastIndexOf('/')) || '/';

  const createSession = async () => {
    if (!canCreate || profileId === null || createCwd.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const bundle = await bridge.createAgentSession({
        profileId,
        agentKind: agent,
        cwd: createCwd.trim(),
        interactionMode: agent === 'agy' ? 'terminal' : 'chat',
        launchMode,
        ...(createTitle.trim() === '' ? {} : { title: createTitle.trim() }),
      });
      setSessions((current) => [
        bundle.session,
        ...current.filter((session) => session.id !== bundle.session.id),
      ]);
      setTimelines((current) => ({
        ...current,
        [bundle.session.id]: bundle.items,
      }));
      setSessionView((current) => {
        const selected = selectSessionForPreview(
          current,
          bundle.session.agentKind,
          bundle.session.id,
        );
        return enterSelectedSession(
          selected,
          bundle.session.agentKind,
          bundle.session.id,
        );
      });
      setCreateOpen(false);
    } catch (createError) {
      setError(errorText(createError));
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (renameSession === null || renameTitle.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await bridge.renameAgentSession({
        sessionId: renameSession.id,
        title: renameTitle.trim(),
      });
      setRenameSession(null);
    } catch (renameError) {
      setError(errorText(renameError));
    } finally {
      setBusy(false);
    }
  };

  const removeSession = async () => {
    if (deleteSession === null) return;
    const sessionId = deleteSession.id;
    const agentKind = deleteSession.agentKind;
    const title = deleteSession.title;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.deleteAgentSession({ sessionId });
      // Drop it from the UI here rather than waiting for the change event to
      // come back. Until the surface unmounts it keeps talking about a session
      // the host has already forgotten, which surfaced as "unknown agent
      // session" right after a delete that had in fact worked.
      forgetSession(sessionId, agentKind);
      // SPEC 1509-1511: a partial failure must not present as complete —
      // keep the per-scope report on screen when anything was left behind.
      if (
        result.scopes.some(
          (scope) => scope.outcome === 'failed' || scope.outcome === 'skipped',
        )
      ) {
        setDeleteOutcome({ title, scopes: result.scopes });
      }
    } catch (deleteError) {
      setError(errorText(deleteError));
    } finally {
      setBusy(false);
    }
  };

  const setTrayItemStates = (
    sessionId: string,
    ids: ReadonlySet<string>,
    state: ComposerAttachment['state'],
    errorMessage?: string,
  ) => {
    setAttachments((current) => ({
      ...current,
      [sessionId]: (current[sessionId] ?? []).map((attachment) =>
        ids.has(attachment.id)
          ? {
              ...attachment,
              state,
              ...(errorMessage === undefined ? {} : { errorMessage }),
            }
          : attachment,
      ),
    }));
  };

  const sendMessage = async (text: string) => {
    if (selectedSessionId === null) return;
    const sessionId = selectedSessionId;
    if (attachmentSendInFlight.current.has(sessionId)) return;
    // SPEC 1360: a prompt whose delivery is still unconfirmed blocks new
    // sends until the user queries or explicitly resends.
    if (sendUnconfirmed[sessionId] !== undefined) {
      setError(
        '上一個 Prompt 的送達結果尚未確認——先用輸入區上方的「再次查詢」或「明確重送」。',
      );
      return;
    }
    const pending = attachments[sessionId] ?? [];
    attachmentSendInFlight.current.add(sessionId);
    // `uploading` now means exactly "attachments are being processed": a
    // text-only send no longer flashes Packaging on the Attach button.
    if (pending.length > 0) {
      setUploading((current) => ({ ...current, [sessionId]: true }));
    }
    setError(null);
    // SPEC 318-323: when neither success nor failure comes back in time, the
    // prompt becomes explicitly unconfirmed instead of leaving a composer
    // locked forever on a hung IPC with no escape.
    const unconfirmedTimer = window.setTimeout(() => {
      setSendUnconfirmed((current) => ({ ...current, [sessionId]: { text } }));
    }, 20_000);
    sendTimersRef.current[sessionId] = unconfirmedTimer;
    try {
      const buffered = pending.filter(
        (attachment): attachment is ComposerAttachment & { file: File } =>
          attachment.file !== undefined,
      );
      let ready = pending;
      if (buffered.length > 0) {
        const bufferedIds = new Set(buffered.map((attachment) => attachment.id));
        setTrayItemStates(sessionId, bufferedIds, 'packaging');
        const encoded = await Promise.all(
          buffered.map(async (attachment) => ({
            name: attachment.name,
            mediaType: attachment.mediaType,
            dataBase64: await attachmentFileToBase64(attachment.file),
          })),
        );
        setTrayItemStates(sessionId, bufferedIds, 'transferring');
        const uploaded = await bridge.uploadAgentAttachments({
          sessionId,
          attachments: encoded,
        });
        setTrayItemStates(sessionId, bufferedIds, 'verifying');
        if (uploaded.length !== buffered.length) {
          throw new Error('The attachment batch returned an incomplete result');
        }
        const replacements = new Map(
          buffered.map((attachment, index) => [attachment.id, uploaded[index]!]),
        );
        ready = pending.map((attachment) => {
          const uploadedAttachment = replacements.get(attachment.id);
          if (uploadedAttachment === undefined) return attachment;
          return {
            id: uploadedAttachment.id,
            name: uploadedAttachment.name,
            mediaType: uploadedAttachment.mediaType,
            sizeBytes: uploadedAttachment.sizeBytes,
            state: 'ready' as const,
            remotePath: uploadedAttachment.remotePath,
            ...(attachment.previewUrl === undefined
              ? {}
              : { previewUrl: attachment.previewUrl }),
          };
        });
        setAttachments((current) => {
          const readyByBufferedId = new Map(
            pending.map((attachment, index) => [attachment.id, ready[index]!]),
          );
          return {
            ...current,
            [sessionId]: (current[sessionId] ?? []).map(
              (attachment) => readyByBufferedId.get(attachment.id) ?? attachment,
            ),
          };
        });
      }
      await bridge.sendAgentMessage({
        sessionId,
        text,
        attachmentIds: ready.map((attachment) => attachment.id),
      });
      pending.forEach((attachment) => {
        if (attachment.previewUrl !== undefined) URL.revokeObjectURL(attachment.previewUrl);
      });
      const sentLocalIds = new Set(pending.map((attachment) => attachment.id));
      const sentRemoteIds = new Set(ready.map((attachment) => attachment.id));
      setAttachments((current) => ({
        ...current,
        [sessionId]: (current[sessionId] ?? []).filter(
          (attachment) =>
            !sentLocalIds.has(attachment.id) && !sentRemoteIds.has(attachment.id),
        ),
      }));
      setDrafts((current) =>
        (current[sessionId] ?? '').trim() === text
          ? { ...current, [sessionId]: '' }
          : current,
      );
    } catch (sendError) {
      // SPEC 1406/1415: failure is per item — whatever never reached the
      // host is marked error (removable, retryable); draft and tray stay.
      const failedIds = new Set(
        (attachments[sessionId] ?? [])
          .filter((attachment) => attachment.file !== undefined)
          .map((attachment) => attachment.id),
      );
      if (failedIds.size > 0) {
        setTrayItemStates(sessionId, failedIds, 'error', errorText(sendError));
      }
      setError(errorText(sendError));
    } finally {
      attachmentSendInFlight.current.delete(sessionId);
      window.clearTimeout(unconfirmedTimer);
      delete sendTimersRef.current[sessionId];
      setSendUnconfirmed((current) => {
        if (!(sessionId in current)) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      setUploading((current) =>
        current[sessionId] === true ? { ...current, [sessionId]: false } : current,
      );
    }
  };

  /** SPEC 1415: one failed item retries alone, without re-sending the rest. */
  const retryAttachment = async (attachmentId: string) => {
    if (selectedSessionId === null) return;
    if (retryInFlightRef.current.has(attachmentId)) return;
    retryInFlightRef.current.add(attachmentId);
    const sessionId = selectedSessionId;
    const target = (attachments[sessionId] ?? []).find(
      (attachment) => attachment.id === attachmentId,
    );
    if (target?.file === undefined) {
      retryInFlightRef.current.delete(attachmentId);
      return;
    }
    setError(null);
    setTrayItemStates(sessionId, new Set([attachmentId]), 'packaging');
    try {
      const dataBase64 = await attachmentFileToBase64(target.file);
      setTrayItemStates(sessionId, new Set([attachmentId]), 'transferring');
      const uploaded = await bridge.uploadAgentAttachments({
        sessionId,
        attachments: [
          { name: target.name, mediaType: target.mediaType, dataBase64 },
        ],
      });
      const remote = uploaded[0];
      if (remote === undefined) {
        throw new Error('The attachment upload returned no result');
      }
      setAttachments((current) => ({
        ...current,
        [sessionId]: (current[sessionId] ?? []).map((attachment) =>
          attachment.id === attachmentId
            ? {
                id: remote.id,
                name: remote.name,
                mediaType: remote.mediaType,
                sizeBytes: remote.sizeBytes,
                state: 'ready' as const,
                remotePath: remote.remotePath,
                ...(attachment.previewUrl === undefined
                  ? {}
                  : { previewUrl: attachment.previewUrl }),
              }
            : attachment,
        ),
      }));
    } catch (retryError) {
      setTrayItemStates(
        sessionId,
        new Set([attachmentId]),
        'error',
        errorText(retryError),
      );
      setError(errorText(retryError));
    } finally {
      retryInFlightRef.current.delete(attachmentId);
    }
  };

  /**
   * SPEC 325-331: query the host for the actual outcome of an unconfirmed
   * prompt. Delivered → adopt the host's timeline; not delivered → the
   * draft and tray were never cleared, so they are simply usable again.
   */
  const verifyPendingSend = async (sessionId: string, text: string) => {
    if (profileId === null) return;
    setError(null);
    try {
      const bundles = await bridge.listAgentSessions({ profileId });
      const bundle = bundles.find(
        (candidate) => candidate.session.id === sessionId,
      );
      if (bundle !== undefined) {
        setSessions((current) =>
          current.map((candidate) =>
            candidate.id === sessionId ? bundle.session : candidate,
          ),
        );
        setTimelines((current) => ({ ...current, [sessionId]: bundle.items }));
      }
      const delivered =
        bundle?.items.some(
          (item) =>
            item.kind === 'message' && item.role === 'user' && item.text === text,
        ) === true;
      setSendUnconfirmed((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      attachmentSendInFlight.current.delete(sessionId);
      setUploading((current) =>
        current[sessionId] === true ? { ...current, [sessionId]: false } : current,
      );
      if (delivered) {
        setDrafts((current) =>
          (current[sessionId] ?? '').trim() === text
            ? { ...current, [sessionId]: '' }
            : current,
        );
      } else {
        setError('查詢結果：這個 Prompt 未送達。草稿與附件已保留，可再次送出。');
      }
    } catch (queryError) {
      setError(errorText(queryError));
    }
  };

  /** SPEC 331: resending is always the user's explicit choice, never automatic. */
  const resendPendingSend = (sessionId: string, text: string) => {
    setSendUnconfirmed((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    attachmentSendInFlight.current.delete(sessionId);
    setUploading((current) =>
      current[sessionId] === true ? { ...current, [sessionId]: false } : current,
    );
    void sendMessage(text);
  };

  const stopSession = async (sessionId: string) => {
    setInterrupting((current) => ({ ...current, [sessionId]: true }));
    setError(null);
    try {
      await bridge.interruptAgentSession({ sessionId });
    } catch (interruptError) {
      setError(errorText(interruptError));
    } finally {
      setInterrupting((current) => ({ ...current, [sessionId]: false }));
    }
  };

  const sendSlashCommand = async (sessionId: string, text: string) => {
    setError(null);
    try {
      await bridge.sendAgentMessage({
        sessionId,
        text,
        attachmentIds: [],
      });
    } catch (commandError) {
      setDrafts((current) => ({ ...current, [sessionId]: text }));
      setError(errorText(commandError));
    }
  };

  const selectSlashCommand = (command: SlashCommand) => {
    if (selectedSessionId === null) return;
    const name = command.name.replace(/^\/+/, '').toLowerCase();
    if (command.behavior === 'picker' && name === 'model') {
      setModelPickerSessionId(selectedSessionId);
      setModelName('');
      return;
    }
    void sendSlashCommand(selectedSessionId, `/${name}`);
  };

  const applyModelSelection = (useDefault = false) => {
    if (modelPickerSessionId === null) return;
    const value = modelName.trim();
    if (!useDefault && value === '') return;
    const sessionId = modelPickerSessionId;
    setModelPickerSessionId(null);
    setModelName('');
    void sendSlashCommand(
      sessionId,
      useDefault ? '/model default' : `/model ${value}`,
    );
  };

  const attachFiles = (sessionId: string, files: File[]) => {
    if (files.length === 0) return;
    const buffered = bufferAttachmentFiles(
      files,
      attachments[sessionId]?.length ?? 0,
    );
    if (buffered.attachments.length === 0) {
      setError(
        buffered.oversizedCount > 0
          ? `${buffered.oversizedCount} attachment(s) exceeded the 20 MB limit.`
          : `This conversation already has ${MAX_AGENT_ATTACHMENTS} buffered attachments.`,
      );
      return;
    }
    setAttachments((current) => ({
      ...current,
      [sessionId]: [...(current[sessionId] ?? []), ...buffered.attachments],
    }));
    if (buffered.oversizedCount > 0 || buffered.limitCount > 0) {
      const messages = [
        buffered.oversizedCount > 0
          ? `${buffered.oversizedCount} attachment(s) exceeded the 20 MB limit`
          : '',
        buffered.limitCount > 0
          ? `${buffered.limitCount} attachment(s) exceeded the ${MAX_AGENT_ATTACHMENTS}-file limit`
          : '',
      ].filter(Boolean);
      setError(`${messages.join('; ')}. The remaining files are buffered locally.`);
    } else {
      setError(null);
    }
  };

  const removeAttachment = (sessionId: string, attachmentId: string) => {
    setAttachments((current) => {
      const target = current[sessionId]?.find(
        (attachment) => attachment.id === attachmentId,
      );
      if (target?.previewUrl !== undefined) URL.revokeObjectURL(target.previewUrl);
      return {
        ...current,
        [sessionId]: (current[sessionId] ?? []).filter(
          (attachment) => attachment.id !== attachmentId,
        ),
      };
    });
  };

  const answerQuestion = async (itemId: string, optionIndex: number) => {
    if (selectedSessionId === null) return;
    setError(null);
    try {
      await bridge.answerAgentQuestion({
        sessionId: selectedSessionId,
        itemId,
        optionIndex,
      });
    } catch (answerError) {
      setError(errorText(answerError));
    }
  };

  const declineQuestion = async (itemId: string) => {
    if (selectedSessionId === null) return;
    setError(null);
    try {
      await bridge.declineAgentQuestion({
        sessionId: selectedSessionId,
        itemId,
      });
    } catch (declineError) {
      setError(errorText(declineError));
    }
  };

  const resolveApproval = async (
    itemId: string,
    resolution: 'allowed' | 'denied',
  ) => {
    if (selectedSessionId === null) return;
    setError(null);
    try {
      await bridge.resolveAgentApproval({
        sessionId: selectedSessionId,
        itemId,
        resolution,
      });
    } catch (approvalError) {
      setError(errorText(approvalError));
    }
  };

  const resumeSession = async (session: AgentSessionSummary) => {
    const sessionId = session.id;
    if (resuming[sessionId] === true) return;
    if (!connected) {
      setError('尚未連線——連線到主機後才能進入這個 session；歷史內容仍可預覽。');
      return;
    }
    // An unavailable agent cannot host a process; the session list and its
    // previews stay usable, only entering is refused — with the reason.
    const sessionInstallation = installations[session.agentKind];
    if (
      sessionInstallation === undefined ||
      !sessionInstallation.installed ||
      (session.agentKind !== 'agy' &&
        !sessionInstallation.supportsStructuredOutput)
    ) {
      setError(
        `${AGENTS.find((entry) => entry.kind === session.agentKind)?.label ?? session.agentKind} 尚不可用，無法進入這個 session；歷史內容仍可預覽與管理。`,
      );
      return;
    }
    const relaunching = session.status === 'exited' || session.status === 'error';
    setResuming((current) => ({ ...current, [sessionId]: true }));
    setError(null);
    try {
      const bundle = await bridge.reviveAgentSession({ sessionId });
      if (bundle.session.status === 'disconnected') {
        throw new Error('This session is still disconnected; reconnect its machine first');
      }
      setSessions((current) =>
        current.map((candidate) =>
          candidate.id === sessionId ? bundle.session : candidate,
        ),
      );
      setTimelines((current) => ({ ...current, [sessionId]: bundle.items }));
      setSessionView((current) =>
        enterSelectedSession(current, session.agentKind, sessionId),
      );
      if (relaunching) {
        // A revived AGY process needs a fresh projected surface; cached screen
        // state belongs to the process that exited.
        clearAgyRuntimeCache(sessionId);
        setAgyActivity((current) => {
          if (!(sessionId in current)) return current;
          const next = { ...current };
          delete next[sessionId];
          return next;
        });
        setReviveNonce((current) => ({
          ...current,
          [sessionId]: (current[sessionId] ?? 0) + 1,
        }));
      }
    } catch (reviveError) {
      setError(errorText(reviveError));
    } finally {
      setResuming((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
    }
  };

  return (
    <div className="agents-workspace">
      <div className="agent-tabs">
        {AGENTS.map(({ kind, label }) => {
          const info = badge(kind);
          return (
            <button
              key={kind}
              className={`agent-tab${agent === kind ? ' agent-tab-active' : ''}`}
              onClick={() => setAgent(kind)}
            >
              {label}
              {info.waiting ? (
                <span className="dot dot-approval" title="needs input" />
              ) : null}
              {info.running ? (
                <span className="dot dot-running" title="running" />
              ) : null}
              {info.unread > 0 ? (
                <span className="unread">{info.unread}</span>
              ) : null}
            </button>
          );
        })}
        <button
          className="agent-tab agent-tab-disabled"
          title="Custom adapter SDK 尚未開放"
        >
          ＋
        </button>
      </div>

      {error !== null ? (
        <div className="agent-error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      ) : null}

      {connected && (loading || installation === undefined) ? (
        <div className="agent-setup">
          <h2>正在偵測 {AGENTS.find((entry) => entry.kind === agent)?.label}</h2>
          <p>
            {agent === 'agy'
              ? '確認遠端 AGY 執行檔與互動式 terminal 能力…'
              : '確認遠端執行檔與 bidirectional stream-json 能力…'}
          </p>
        </div>
      ) : (
        <div className="agent-panes" ref={panesRef}>
          <aside className="session-sidebar" style={{ width: clamp(sidebarWidth) }}>
            {/*
              SPEC 1057/256-262: neither a missing connection nor an
              unavailable agent may hide the workspace — saved sessions
              preview without a process. The banner names the reason;
              entering and creating stay gated elsewhere.
            */}
            {!connected ? (
              <div
                className={`agent-availability-banner${
                  connectionState === 'reconnecting' || reconnect
                    ? ' agent-availability-reconnecting'
                    : ''
                }`}
                role="status"
              >
                <strong>
                  {connectionState === 'reconnecting' || reconnect
                    ? '連線中斷 — 正在重連中'
                    : '尚未連線'}
                </strong>
                <p>
                  {reconnect
                    ? `${reconnect.secondsLeft}s 後進行第 ${reconnect.attempt} 次重連嘗試`
                    : '已保存的 sessions 仍可瀏覽、預覽、改名與刪除；連線後才能進入或新建。Agent 對話會在遠端指定路徑建立 tmux session。'}
                </p>
              </div>
            ) : agentUnavailable ? (
              <div className="agent-availability-banner" role="status">
                <strong>
                  {AGENTS.find((entry) => entry.kind === agent)?.label} 尚不可用
                </strong>
                <p>
                  {installation.detail ??
                    '遠端 Agent 或 structured protocol 不可用。'}
                </p>
                {environmentText(installation) !== null ? (
                  <p className="hint">
                    Remote: {environmentText(installation)}
                    {installation.environment?.loginShell === undefined
                      ? ''
                      : ` · shell ${installation.environment.loginShell}`}
                  </p>
                ) : null}
                <dl className="agent-capabilities">
                  <dt>安裝</dt>
                  <dd>
                    {installation.installed
                      ? `已安裝 ${installation.version ?? '（版本未知）'}`
                      : '未偵測到'}
                  </dd>
                  <dt>Structured Chat</dt>
                  <dd>{installation.supportsStructuredOutput ? '可用' : '不可用'}</dd>
                  <dt>Resume</dt>
                  <dd>
                    {installation.supportsResume
                      ? '延續原生對話'
                      : installation.resumeStartsNewConversation === true
                        ? '以新原生對話重啟'
                        : installation.installed
                          ? '不可用'
                          : '未知'}
                  </dd>
                  <dt>Approval</dt>
                  <dd>
                    {installation.supportsInteractiveApproval ? '可用' : '不可用'}
                  </dd>
                  <dt>Skip Permissions</dt>
                  <dd>
                    {installation.supportsDangerouslySkipPermissions === undefined
                      ? '未知'
                      : installation.supportsDangerouslySkipPermissions
                        ? '可用'
                        : '不可用'}
                  </dd>
                  <dt>Launch Modes</dt>
                  <dd>
                    {installation.launchModes.length > 0
                      ? installation.launchModes.map((mode) => mode.label).join('、')
                      : '無'}
                  </dd>
                </dl>
                <p className="hint">
                  既有 sessions 仍可瀏覽、預覽與管理；進入與新建已停用。
                </p>
              </div>
            ) : null}
            <div className="session-filter-wrapper">
              <span className="session-filter-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>
              <input
                className="session-filter"
                placeholder="Filter sessions..."
                value={filters[agent]}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    [agent]: event.target.value,
                  }))
                }
              />
            </div>
            <div className="session-bucket-filter" role="radiogroup" aria-label="Session status filter">
              {(['all', 'running', 'needsInput', 'idle', 'exited', 'error'] as const).map((bucket) => (
                <button
                  key={bucket}
                  role="radio"
                  aria-checked={bucketFilter === bucket}
                  className={`session-bucket${
                    bucketFilter === bucket ? ' session-bucket-active' : ''
                  }`}
                  onClick={() => setBucketFilter(bucket)}
                >
                  {bucket === 'all' ? '全部' : BUCKET_LABEL[bucket]}
                  {bucket === 'all' ? null : (
                    <span className="session-bucket-count">
                      {bucketCounts[bucket]}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="session-list">
              {agentSessions.map((session) => {
                const status = liveStatus(session);
                return (
                  <SessionListItem
                    key={session.id}
                    session={session}
                    status={status}
                    active={session.id === selectedSessionId}
                    resuming={resuming[session.id] === true}
                    menuOpen={sessionMenu?.session.id === session.id}
                    onActivate={() => {
                      setSessionView((current) =>
                        selectSessionForPreview(
                          current,
                          session.agentKind,
                          session.id,
                        ),
                      );
                    }}
                    onOpenMenu={(x, y) => setSessionMenu({ session, x, y })}
                  />
                );
              })}
              {searchedSessions.length === 0 && filters[agent] === '' ? (
                <div className="zero-session-state">
                  <div className="zero-session-icon" aria-hidden="true">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                  </div>
                  <p className="zero-session-text">
                    No active sessions. Create a new session to get started.
                  </p>
                  <button
                    className="zero-session-cta"
                    disabled={!canCreate || busy}
                    onClick={openCreate}
                  >
                    ＋ New session
                  </button>
                </div>
              ) : agentSessions.length === 0 ? (
                <p className="hint session-empty">
                  {bucketFilter === 'all'
                    ? '沒有符合搜尋的對話。'
                    : `沒有 ${BUCKET_LABEL[bucketFilter]} 狀態的對話。`}
                </p>
              ) : null}
            </div>
            <button
              className="session-new"
              disabled={!canCreate || busy}
              onClick={openCreate}
            >
              ＋ New session
            </button>
          </aside>
          {/* VS Code-style drag handle */}
          <div
            className="pane-resize-handle"
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onDoubleClick={onResizeDoubleClick}
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={clamp(sidebarWidth)}
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_ABSOLUTE_MAX}
            title="Drag to resize sidebar (180px - 600px), double-click to reset"
          />
          <div className="chat-column">
            {selectedSession ? (
              <>
                <div className="chat-session-head">
                  <div>
                    <span className="chat-session-title-row">
                      <strong>{selectedSession.title}</strong>
                      {selectedSession.agentKind === 'agy' ? (
                        <span className="agent-surface-chip">AGY CLI</span>
                      ) : null}
                      {reconnect || connectionState === 'reconnecting' ? (
                        <span className="reconnect-pill mono">
                          Reconnecting {reconnect ? `(${reconnect.secondsLeft}s)` : ''}...
                        </span>
                      ) : null}
                    </span>
                    <span className="mono">{selectedSession.cwd}</span>
                    {/* SPEC 3.4.5: version, binding, and whether the last
                        Resume continued the native conversation. */}
                    <span className="chat-session-meta">
                      {installation?.version === undefined
                        ? ''
                        : `${AGENTS.find((entry) => entry.kind === selectedSession.agentKind)?.label ?? ''} ${installation.version} · `}
                      {selectedSession.conversationBound === true
                        ? '已綁定原生對話'
                        : '未綁定原生對話'}
                      {selectedSession.resumeContinuity === undefined
                        ? ''
                        : selectedSession.resumeContinuity === 'continued'
                          ? ' · 本次 Resume 延續原生對話'
                          : selectedSession.resumeContinuity === 'assumed'
                            ? ' · 本次 Resume 接回的對話未經確認'
                            : ' · 本次 Resume 開啟新原生對話'}
                      {selectedSession.agentKind === 'agy'
                        ? ''
                        : lastUsage === undefined
                          ? ' · 用量未知'
                          : ` · 用量 in ${lastUsage.inputTokens.toLocaleString()} / out ${lastUsage.outputTokens.toLocaleString()} tokens`}
                    </span>
                  </div>
                  {selectedSessionEntered ? (
                    <div className="chat-session-actions">
                      {selectedSession.agentKind !== 'agy' &&
                      (selectedSession.status === 'running' ||
                        selectedSession.status === 'waiting_approval') ? (
                        <button
                          className="ghost"
                          disabled={interrupting[selectedSession.id] === true}
                          onClick={() => void stopSession(selectedSession.id)}
                        >
                          {interrupting[selectedSession.id] === true
                            ? 'Stopping…'
                            : 'Stop'}
                        </button>
                      ) : null}
                      <button
                        className="ghost"
                        onClick={() =>
                          setSessionView((current) =>
                            leaveEnteredSession(
                              current,
                              selectedSession.agentKind,
                              selectedSession.id,
                            )
                          )
                        }
                      >
                        Leave
                      </button>
                    </div>
                  ) : null}
                </div>
                {!selectedSessionEntered ? (
                  <>
                    {selectedSession.agentKind === 'agy' ? (
                      <AgyTranscriptPreview
                        key={selectedSession.id}
                        sessionId={selectedSession.id}
                        cwd={selectedSession.cwd}
                      />
                    ) : timeline.length === 0 ? (
                      <ZeroMessageState
                        sessionTitle={selectedSession.title}
                        agentKind={selectedSession.agentKind}
                      />
                    ) : (
                      <TimelineErrorBoundary>
                        <ChatTimeline
                          sessionId={selectedSession.id}
                          items={timeline}
                          interactive={false}
                          sessionStatus={selectedSession.status}
                          sessionError={error ?? undefined}
                          onResolveApproval={() => undefined}
                          onAnswerQuestion={() => undefined}
                          onRetrySession={() => void resumeSession(selectedSession)}
                        />
                      </TimelineErrorBoundary>
                    )}
                    <div className="session-resume-bar">
                      <span>
                        已選取但尚未進入。按 Resume 後才會連回這個 session，並顯示訊息與附件輸入區。
                      </span>
                      <span className={`chip chip-${liveStatus(selectedSession)}`}>
                        {STATUS_LABEL[liveStatus(selectedSession)]}
                      </span>
                      <button
                        className="composer-send"
                        disabled={!connected || resuming[selectedSession.id] === true}
                        onClick={() => void resumeSession(selectedSession)}
                      >
                        {resuming[selectedSession.id] === true ? 'Resuming…' : 'Resume'}
                      </button>
                    </div>
                  </>
                ) : selectedSession.agentKind === 'agy' ? (
                  <AgyCliSurface
                    key={`${selectedSession.id}:${reviveNonce[selectedSession.id] ?? 0}`}
                    sessionId={selectedSession.id}
                    cwd={selectedSession.cwd}
                    sessionStatus={selectedSession.status}
                    stopping={interrupting[selectedSession.id] === true}
                    onInterrupt={() => stopSession(selectedSession.id)}
                    onNotify={(message) => {
                      // A surface unmounting after its session was deleted
                      // must not resurface as an error (SPEC 1515).
                      if (forgotten.current.has(selectedSession.id)) return;
                      setError(message);
                    }}
                    onStatusChange={(status) => {
                      setAgyActivity((current) =>
                        current[selectedSession.id] === status
                          ? current
                          : { ...current, [selectedSession.id]: status },
                      );
                      if (status === 'exited' || status === 'error') {
                        setSessionView((current) =>
                          leaveEnteredSession(
                            current,
                            selectedSession.agentKind,
                            selectedSession.id,
                          ),
                        );
                      }
                    }}
                  />
                ) : (
                  <>
                    {timeline.length === 0 ? (
                      <ZeroMessageState
                        sessionTitle={selectedSession.title}
                        agentKind={selectedSession.agentKind}
                        onSelectSuggestion={(text) =>
                          setDrafts((current) => ({
                            ...current,
                            [selectedSession.id]: text,
                          }))
                        }
                      />
                    ) : (
                      <TimelineErrorBoundary>
                        <ChatTimeline
                          sessionId={selectedSession.id}
                          items={timeline}
                          interactive
                          sessionStatus={selectedSession.status}
                          sessionError={error ?? undefined}
                          onResolveApproval={(itemId, resolution) =>
                            void resolveApproval(itemId, resolution)
                          }
                          onAnswerQuestion={(itemId, optionIndex) =>
                            void answerQuestion(itemId, optionIndex)
                          }
                          onDeclineQuestion={(itemId) => void declineQuestion(itemId)}
                          onRetrySession={() => void resumeSession(selectedSession)}
                        />
                      </TimelineErrorBoundary>
                    )}
                    {sendUnconfirmed[selectedSession.id] !== undefined ? (
                      // SPEC 325-331: an overdue prompt is a question, not a
                      // spinner — query the real outcome or resend on purpose.
                      <div className="send-unconfirmed" role="status">
                        <span>
                          Prompt 已送出但遲未確認送達；可查詢實際結果，或明確重送。
                        </span>
                        <button
                          onClick={() =>
                            void verifyPendingSend(
                              selectedSession.id,
                              sendUnconfirmed[selectedSession.id]!.text,
                            )
                          }
                        >
                          再次查詢
                        </button>
                        <button
                          onClick={() =>
                            resendPendingSend(
                              selectedSession.id,
                              sendUnconfirmed[selectedSession.id]!.text,
                            )
                          }
                        >
                          明確重送
                        </button>
                      </div>
                    ) : null}
                    <ChatComposer
                      key={selectedSession.id}
                      agentLabel={
                        AGENTS.find((entry) => entry.kind === agent)?.label ?? agent
                      }
                      value={drafts[selectedSession.id] ?? ''}
                      history={promptHistory}
                      commands={(selectedSession.slashCommands ?? []).map((name) => ({
                        name,
                        description: slashCommandDescription(
                          selectedSession.agentKind,
                          name,
                          selectedSession.slashCommandDescriptions,
                        ),
                        behavior:
                          selectedSession.slashCommandBehaviors?.[
                            name.replace(/^\/+/, '').toLowerCase()
                          ],
                        owner:
                          selectedSession.slashCommandOwners?.[
                            name.replace(/^\/+/, '').toLowerCase()
                          ],
                      }))}
                      attachments={attachments[selectedSession.id] ?? []}
                      uploading={uploading[selectedSession.id] === true}
                      running={
                        selectedSession.status === 'running' ||
                        selectedSession.status === 'waiting_approval'
                      }
                      stopping={interrupting[selectedSession.id] === true}
                      disabled={
                        composerAvailability(
                          selectedSession,
                          uploading[selectedSession.id] === true,
                        ).disabled
                      }
                      disabledReason={
                        composerAvailability(
                          selectedSession,
                          uploading[selectedSession.id] === true,
                        ).reason
                      }
                      onChange={(value) =>
                        setDrafts((current) => ({
                          ...current,
                          [selectedSession.id]: value,
                        }))
                      }
                      onAttach={(files) => attachFiles(selectedSession.id, files)}
                      onRetryAttachment={(id) => void retryAttachment(id)}
                      onRemoveAttachment={(attachmentId) =>
                        removeAttachment(selectedSession.id, attachmentId)
                      }
                      onCommand={selectSlashCommand}
                      onStop={() => void stopSession(selectedSession.id)}
                      onSend={(text) => void sendMessage(text)}
                    />
                  </>
                )}
              </>
            ) : (
              <div className="placeholder">
                <p>選擇一個對話查看內容，或建立新對話。</p>
              </div>
            )}
          </div>

        </div>
      )}

      {sessionMenu !== null ? (
        <ContextMenu
          x={sessionMenu.x}
          y={sessionMenu.y}
          title={sessionMenu.session.title}
          subtitle={sessionMenu.session.cwd}
          actions={[
            { id: 'rename', label: 'Rename' },
            {
              id: 'delete',
              label: 'Delete',
              danger: true,
              separatorBefore: true,
              disabled: busy,
            },
          ]}
          onSelect={(actionId) => {
            if (actionId === 'rename') {
              setRenameSession(sessionMenu.session);
              setRenameTitle(sessionMenu.session.title);
            } else if (actionId === 'delete') {
              setDeleteSession(sessionMenu.session);
            }
          }}
          onClose={() => setSessionMenu(null)}
        />
      ) : null}

      {createOpen ? (
        <div className="modal-overlay" role="presentation">
          <div className="modal modal-directory" role="dialog" aria-modal="true">
            <div className="modal-head">
              <h2>
                New {AGENTS.find((entry) => entry.kind === agent)?.label} session
              </h2>
              <button className="modal-close" onClick={() => setCreateOpen(false)}>
                ×
              </button>
            </div>
            <div className="directory-picker">
              <div className="directory-toolbar">
                <button onClick={() => void loadCreateDirectory('~')}>Home</button>
                <button onClick={() => void loadCreateDirectory('/')}>Root</button>
                <button
                  disabled={createCwd === '/'}
                  onClick={() => void loadCreateDirectory(parentDirectory)}
                >
                  Up
                </button>
              </div>
              <div className="directory-jump">
                <input
                  className="mono"
                  value={directoryJump}
                  onChange={(event) => setDirectoryJump(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void loadCreateDirectory(directoryJump);
                    }
                  }}
                  placeholder="/home/user/project"
                  autoFocus
                />
                <button onClick={() => void loadCreateDirectory(directoryJump)}>
                  Go
                </button>
              </div>
              <div className="directory-selected">
                <span>Selected</span>
                <strong className="mono">{createCwd}</strong>
              </div>
              <div className="directory-list">
                {directoryLoading ? (
                  <p className="hint">Loading directories…</p>
                ) : directoryItems.length > 0 ? (
                  directoryItems.map((item) => (
                    <button
                      key={item.path}
                      className="directory-item"
                      onClick={() => void loadCreateDirectory(item.path)}
                    >
                      <span aria-hidden="true">▸</span>
                      <span>{item.name}</span>
                      {item.type === 'l' ? (
                        <span className="hint">symlink</span>
                      ) : null}
                    </button>
                  ))
                ) : (
                  <p className="hint">This directory has no subdirectories.</p>
                )}
              </div>
              {directoryTruncated ? (
                <p className="hint">Directory listing was truncated.</p>
              ) : null}
              {directoryError !== null ? (
                <p className="form-error">{directoryError}</p>
              ) : null}
            </div>
            <label>
              Title（optional）
              <input
                value={createTitle}
                onChange={(event) => setCreateTitle(event.target.value)}
                placeholder={`New ${AGENTS.find((entry) => entry.kind === agent)?.label ?? agent} conversation`}
              />
            </label>
            {agent === 'agy' ? (
              <div className="agy-cli-create-note">
                <strong>AGY CLI</strong>
                <span>
                  會直接啟動原生 TUI；prompt、方向鍵、Enter、Esc 與 Ctrl+C 都透過遠端 PTY 傳送。
                </span>
              </div>
            ) : null}
            <label>
              Launch mode
              <select
                value={launchMode}
                onChange={(event) => setLaunchMode(event.target.value)}
              >
                {(installation?.launchModes ?? []).map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="hint">
              {installation?.launchModes.find((mode) => mode.id === launchMode)
                ?.description ?? 'Uses the selected agent’s guarded launch policy.'}
            </p>
            {installation?.launchModes.find((mode) => mode.id === launchMode)
              ?.risk === 'dangerous' ? (
              <p className="form-error">
                此模式允許 Agent 不經逐次確認直接執行工具，僅應用於可信任的工作目錄。
              </p>
            ) : null}
            <p className="hint">
              {agent === 'agy'
                ? '建立後會立刻在這個路徑開 tmux，並顯示 AGY 自己的起始互動畫面。'
                : '建立後會立刻在這個路徑開 tmux，並啟動所選 Agent 的 structured session。'}
            </p>
            <div className="modal-actions">
              <button onClick={() => setCreateOpen(false)}>Cancel</button>
              <button
                className="primary"
                disabled={
                  busy ||
                  directoryLoading ||
                  directoryError !== null ||
                  !installation?.launchModes.some(
                    (mode) => mode.id === launchMode,
                  ) ||
                  createCwd.trim() === ''
                }
                onClick={() => void createSession()}
              >
                {busy ? 'Starting…' : 'Create & start'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {renameSession !== null ? (
        <div className="modal-overlay" role="presentation">
          <div className="modal modal-narrow" role="dialog" aria-modal="true">
            <div className="modal-head">
              <h2>Rename conversation</h2>
              <button className="modal-close" onClick={() => setRenameSession(null)}>
                ×
              </button>
            </div>
            <label>
              Title
              <input
                value={renameTitle}
                onChange={(event) => setRenameTitle(event.target.value)}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void rename();
                }}
              />
            </label>
            <div className="modal-actions">
              <button onClick={() => setRenameSession(null)}>Cancel</button>
              <button
                className="primary"
                disabled={busy || renameTitle.trim() === ''}
                onClick={() => void rename()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteSession !== null ? (
        <div className="modal-overlay" role="presentation">
          <div className="modal modal-narrow" role="dialog" aria-modal="true">
            <div className="modal-head">
              <h2>Delete conversation?</h2>
              <button className="modal-close" onClick={() => setDeleteSession(null)}>
                ×
              </button>
            </div>
            <p>
              <strong>{deleteSession.title}</strong>
              <span className="delete-session-meta">
                {AGENTS.find((entry) => entry.kind === deleteSession.agentKind)
                  ?.label ?? deleteSession.agentKind}
                {' · '}
                {deleteSession.host}
                {' · '}
                <span className="mono">{deleteSession.cwd}</span>
              </span>
            </p>
            <ul className="delete-scope-list">
              {(
                [
                  'localIndex',
                  'process',
                  'remoteEvents',
                  'remoteAttachments',
                  'nativeConversation',
                ] as const
              ).map((scope) => (
                <li key={scope}>
                  <strong>{DELETE_SCOPE_COPY[scope].label}</strong>
                  <span>{DELETE_SCOPE_COPY[scope].impact}</span>
                </li>
              ))}
            </ul>
            <p className="hint">
              Files in <span className="mono">{deleteSession.cwd}</span> are not
              deleted. This action cannot be undone.
            </p>
            <div className="modal-actions">
              <button disabled={busy} onClick={() => setDeleteSession(null)}>
                Cancel
              </button>
              <button
                className="danger"
                disabled={busy}
                onClick={() => void removeSession()}
              >
                {busy ? 'Deleting…' : 'Delete session'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteOutcome !== null ? (
        <div className="modal-overlay" role="presentation">
          <div className="modal modal-narrow" role="dialog" aria-modal="true">
            <div className="modal-head">
              <h2>刪除結果：{deleteOutcome.title}</h2>
              <button className="modal-close" onClick={() => setDeleteOutcome(null)}>
                ×
              </button>
            </div>
            <p className="hint">
              本機索引已移除，但部分範圍未完成；殘留項目如下。
            </p>
            <ul className="delete-scope-list">
              {deleteOutcome.scopes.map((scope) => (
                <li key={scope.scope} className={`delete-scope-${scope.outcome}`}>
                  <strong>
                    {DELETE_SCOPE_COPY[scope.scope].label} —{' '}
                    {DELETE_OUTCOME_LABEL[scope.outcome]}
                  </strong>
                  <span>
                    {scope.detail ?? ''}
                    {scope.residualPath === undefined ? null : (
                      <span className="mono"> · {scope.residualPath}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button onClick={() => setDeleteOutcome(null)}>關閉</button>
            </div>
          </div>
        </div>
      ) : null}

      {modelPickerSessionId !== null ? (
        <div className="modal-overlay" role="presentation">
          <div className="modal modal-narrow" role="dialog" aria-modal="true">
            <div className="modal-head">
              <h2>Choose AGY model</h2>
              <button
                className="modal-close"
                onClick={() => setModelPickerSessionId(null)}
              >
                ×
              </button>
            </div>
            <label>
              Model name
              <input
                value={modelName}
                onChange={(event) => setModelName(event.target.value)}
                placeholder="Enter an AGY model ID"
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applyModelSelection();
                }}
              />
            </label>
            <p className="hint">
              CozyPad passes this value to AGY with <code>--model</code> on later
              turns. This picker does not start a remote process.
            </p>
            <div className="modal-actions">
              <button onClick={() => applyModelSelection(true)}>
                Use AGY default
              </button>
              <button
                className="primary"
                disabled={modelName.trim() === ''}
                onClick={() => applyModelSelection()}
              >
                Use model
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
