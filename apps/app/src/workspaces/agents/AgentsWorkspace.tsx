import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AgentInstallation,
  AgentKind,
  AgentSessionStatus,
  AgentSessionSummary,
  ChatItem,
  ConnectionState,
  RemoteFileItem,
  SlashCommand,
} from '@cozypad/contracts';
import { MAX_AGENT_ATTACHMENTS } from '@cozypad/contracts';
import { ContextMenu, useLongPress } from '../../components/ContextMenu';
import { getBridge } from '../../platform/bridge';
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
type SessionBucket =
  | 'running'
  | 'needsInput'
  | 'ready'
  | 'offline'
  | 'exited'
  | 'error';

const BUCKET_LABEL: Record<SessionBucket, string> = {
  running: 'running',
  needsInput: 'needs input',
  ready: 'ready',
  offline: 'offline',
  exited: 'exited',
  error: 'error',
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
  if (status === 'disconnected') return 'offline';
  if (status === 'error') return 'error';
  return 'ready';
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
        <span className={`session-status session-status-${status}`}>
          <span className="session-status-dot" aria-hidden="true" />
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
  workspaceCwd?: string | null;
}

export function AgentsWorkspace({
  connected,
  connectionState,
  reconnect,
  profileId,
  workspaceCwd = null,
}: AgentsWorkspaceProps) {
  const bridge = useMemo(() => getBridge(), []);
  const [agent, setAgent] = useState<AgentKind>('claude');
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [timelines, setTimelines] = useState<Record<string, ChatItem[]>>({});
  const [installations, setInstallations] = useState<
    Partial<Record<AgentKind, AgentInstallation>>
  >({});
  const [sessionView, setSessionView] = useState(createAgentSessionViewState);
  const [mobilePane, setMobilePane] = useState<'sessions' | 'chat'>('sessions');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<
    Record<string, ComposerAttachment[]>
  >({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const attachmentSendInFlight = useRef(new Set<string>());
  const retryInFlightRef = useRef(new Set<string>());
  // Async IPC responses and pushed events can arrive one turn after a host has
  // disconnected. Read this ref at delivery time so stale data never repaints
  // an offline panel.
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const profileIdRef = useRef(profileId);
  profileIdRef.current = profileId;
  /** SPEC 318-331: prompts whose delivery outcome is overdue, per session. */
  const [sendUnconfirmed, setSendUnconfirmed] = useState<
    Record<string, { text: string }>
  >({});
  /**
   * Sends whose delivery is not yet proven. Proof is the user message echoing
   * back on the timeline — NOT `sendAgentMessage` resolving, which happens
   * only when the whole turn ends.
   */
  const sendTimersRef = useRef<Record<string, { timer: number; text: string }>>({});
  const [interrupting, setInterrupting] = useState<Record<string, boolean>>({});
  const [filters, setFilters] = useState<Record<AgentKind, string>>({
    claude: '',
    codex: '',
    agy: '',
  });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * The last surfaced error, tagged with the session it belongs to (null for
   * host-level failures). One global string used to leak into whichever
   * session happened to be selected.
   */
  const [errorState, setErrorState] = useState<{
    text: string;
    sessionId: string | null;
  } | null>(null);
  const error = errorState === null ? null : errorState.text;
  const selectedSessionIdRef = useRef<string | null>(null);
  const setError = useCallback(
    (text: string | null, sessionId?: string | null) =>
      setErrorState(
        text === null
          ? null
          : {
              text,
              sessionId:
                sessionId !== undefined ? sessionId : selectedSessionIdRef.current,
            },
      ),
    [],
  );
  const errorFor = (sessionId: string): string | undefined =>
    errorState !== null && errorState.sessionId === sessionId
      ? errorState.text
      : undefined;
  /** Sessions whose timeline advanced while another one was on screen. */
  const [unreadIds, setUnreadIds] = useState<Record<string, true>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [launchMode, setLaunchMode] = useState('default');
  const [createCwd, setCreateCwd] = useState('~');
  const [directoryJump, setDirectoryJump] = useState('~');
  const [directoryItems, setDirectoryItems] = useState<RemoteFileItem[]>([]);
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const [directoryTruncated, setDirectoryTruncated] = useState(false);
  const [renameSession, setRenameSession] = useState<AgentSessionSummary | null>(
    null,
  );
  const [sessionMenu, setSessionMenu] = useState<{
    session: AgentSessionSummary;
    x: number;
    y: number;
  } | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [bucketFilter, setBucketFilter] = useState<SessionBucket | 'all'>('all');
  const [workspaceScope, setWorkspaceScope] = useState<'current' | 'all'>('all');
  const [archiveFilter, setArchiveFilter] = useState<
    'active' | 'archived' | 'all'
  >('active');
  const [resuming, setResuming] = useState<Record<string, boolean>>({});
  const agentMenuRef = useRef<HTMLDetailsElement>(null);
  const closeAgentMenu = useCallback(() => {
    if (agentMenuRef.current !== null) agentMenuRef.current.open = false;
  }, []);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const menu = agentMenuRef.current;
      if (
        menu?.open === true &&
        event.target instanceof Node &&
        !menu.contains(event.target)
      ) {
        menu.open = false;
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      const menu = agentMenuRef.current;
      if (event.key !== 'Escape' || menu?.open !== true) return;
      menu.open = false;
      menu.querySelector<HTMLElement>('summary')?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

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
    setUnreadIds(drop);
    // A pending delivery timer must not write back a key that is gone.
    const pendingSend = sendTimersRef.current[sessionId];
    if (pendingSend !== undefined) {
      window.clearTimeout(pendingSend.timer);
      delete sendTimersRef.current[sessionId];
    }
    setSendUnconfirmed(drop);
    attachmentSendInFlight.current.delete(sessionId);
    setRenameSession((current) => (current?.id === sessionId ? null : current));
    setSessionMenu((current) =>
      current?.session.id === sessionId ? null : current,
    );
  }, []);

  /**
   * A disconnected host has no readable Agent state. Drop every host-derived
   * value instead of keeping a desktop-side preview cache alive in the panel.
   */
  const clearHostData = useCallback(() => {
    for (const pending of Object.values(sendTimersRef.current)) {
      window.clearTimeout(pending.timer);
    }
    sendTimersRef.current = {};
    attachmentSendInFlight.current.clear();
    retryInFlightRef.current.clear();
    selectedSessionIdRef.current = null;
    loadedProfileId.current = null;

    setSessions([]);
    setTimelines({});
    setInstallations({});
    setSessionView(createAgentSessionViewState());
    setMobilePane('sessions');
    setDrafts({});
    setAttachments((current) => {
      for (const items of Object.values(current)) {
        for (const attachment of items) {
          if (attachment.previewUrl !== undefined) {
            URL.revokeObjectURL(attachment.previewUrl);
          }
        }
      }
      return {};
    });
    setUploading({});
    setSendUnconfirmed({});
    setInterrupting({});
    setUnreadIds({});
    setResuming({});
    setRenameSession(null);
    setSessionMenu(null);
    setCreateOpen(false);
    setCreateTitle('');
    setLaunchMode('default');
    setCreateCwd('~');
    setDirectoryJump('~');
    setDirectoryItems([]);
    setDirectoryLoading(false);
    setDirectoryError(null);
    setDirectoryTruncated(false);
    setBusy(false);
    setLoading(false);
    setError(null);
    closeAgentMenu();
  }, [closeAgentMenu, setError]);

  useEffect(() => {
    const unsubscribeSession = bridge.onAgentSessionChanged(({ session }) => {
      if (!connectedRef.current) return;
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
        if (!connectedRef.current) return;
        // SPEC 1514-1515: late events must not resurrect a deleted session.
        if (forgotten.current.has(sessionId)) return;
        setTimelines((current) => ({ ...current, [sessionId]: items }));
        // The prompt showing up in the timeline IS the delivery confirmation.
        const pendingSend = sendTimersRef.current[sessionId];
        const lastUserItem = [...items]
          .reverse()
          .find((item) => item.kind === 'message' && item.role === 'user');
        if (
          pendingSend !== undefined &&
          lastUserItem !== undefined &&
          lastUserItem.kind === 'message' &&
          lastUserItem.text.trim() === pendingSend.text.trim()
        ) {
          window.clearTimeout(pendingSend.timer);
          delete sendTimersRef.current[sessionId];
          setSendUnconfirmed((current) => {
            if (!(sessionId in current)) return current;
            const next = { ...current };
            delete next[sessionId];
            return next;
          });
        }
        if (sessionId !== selectedSessionIdRef.current) {
          setUnreadIds((current) =>
            current[sessionId] === undefined ? { ...current, [sessionId]: true } : current,
          );
        }
      },
    );
    const unsubscribeDeleted = bridge.onAgentSessionDeleted(
      ({ sessionId, agentKind }) => {
        if (!connectedRef.current) return;
        forgetSession(sessionId, agentKind);
      },
    );
    const unsubscribeError = bridge.onAgentCommunicationError((event) => {
      if (!connectedRef.current) return;
      // A deletion that succeeded locally must not re-surface as red text.
      if (event.sessionId !== undefined && forgotten.current.has(event.sessionId)) {
        return;
      }
      setError(event.message, event.sessionId ?? null);
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
    if (!connected || profileId === null) {
      clearHostData();
      return;
    }
    let cancelled = false;
    if (loadedProfileId.current !== profileId) {
      loadedProfileId.current = profileId;
      setSessions([]);
      setTimelines({});
      setSessionView(createAgentSessionViewState());
    }
    setLoading(true);
    setError(null);
    // Detection may import native conversations. Finish all discovery first,
    // then list, otherwise a fast list races ahead and the new rows only show
    // up on the next polling interval.
    void Promise.all(
      AGENTS.map(async ({ kind }) => {
        try {
          return await bridge.detectAgent({ profileId, agentKind: kind });
        } catch (detectionError) {
          const detail = errorText(detectionError);
          return {
            agentKind: kind,
            installed: false,
            supportsStructuredOutput: false,
            supportsResume: false,
            supportsInteractiveApproval: false,
            launchModes: [],
            detectionError: detail,
            detail,
          } satisfies AgentInstallation;
        }
      }),
    )
      .then(async (detected) => {
        if (cancelled || !connectedRef.current || profileIdRef.current !== profileId) {
          return;
        }
        setInstallations(
          Object.fromEntries(
            detected.map((installation) => [
              installation.agentKind,
              installation,
            ]),
          ),
        );
        const bundles = await bridge.listAgentSessions({
          profileId,
          archive: 'all',
        });
        if (cancelled || !connectedRef.current || profileIdRef.current !== profileId) {
          return;
        }
        setSessions(bundles.map((bundle) => bundle.session));
        setTimelines(
          Object.fromEntries(
            bundles.map((bundle) => [bundle.session.id, bundle.items]),
          ),
        );
      })
      .catch((loadError: unknown) => {
        if (!cancelled && connectedRef.current && profileIdRef.current === profileId) {
          setError(errorText(loadError));
        }
      })
      .finally(() => {
        if (!cancelled && connectedRef.current && profileIdRef.current === profileId) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, clearHostData, connected, profileId, setError]);

  const refreshAgentSessions = useCallback(
    async (nextAgent: AgentKind): Promise<void> => {
      const requestedProfileId = profileId;
      if (!connectedRef.current || requestedProfileId === null) return;
      setError(null);
      try {
        // Refresh the visible registry immediately on selection. Detection can
        // import additional native conversations, so list once more after it
        // completes rather than making the first paint wait on a CLI probe.
        const firstBundles = await bridge.listAgentSessions({
          profileId: requestedProfileId,
          archive: 'all',
        });
        if (
          !connectedRef.current ||
          profileIdRef.current !== requestedProfileId
        ) {
          return;
        }
        setSessions(firstBundles.map((bundle) => bundle.session));
        setTimelines(
          Object.fromEntries(
            firstBundles.map((bundle) => [bundle.session.id, bundle.items]),
          ),
        );

        let detected: AgentInstallation;
        try {
          detected = await bridge.detectAgent({
            profileId: requestedProfileId,
            agentKind: nextAgent,
          });
        } catch (detectionError) {
          const detail = errorText(detectionError);
          detected = {
            agentKind: nextAgent,
            installed: false,
            supportsStructuredOutput: false,
            supportsResume: false,
            supportsInteractiveApproval: false,
            launchModes: [],
            detectionError: detail,
            detail,
          };
        }
        if (
          !connectedRef.current ||
          profileIdRef.current !== requestedProfileId
        ) {
          return;
        }
        setInstallations((current) => ({
          ...current,
          [nextAgent]: detected,
        }));
        const bundles = await bridge.listAgentSessions({
          profileId: requestedProfileId,
          archive: 'all',
        });
        if (
          !connectedRef.current ||
          profileIdRef.current !== requestedProfileId
        ) {
          return;
        }
        setSessions(bundles.map((bundle) => bundle.session));
        setTimelines(
          Object.fromEntries(
            bundles.map((bundle) => [bundle.session.id, bundle.items]),
          ),
        );
      } catch (refreshError) {
        if (
          connectedRef.current &&
          profileIdRef.current === requestedProfileId
        ) {
          setError(errorText(refreshError), null);
        }
      }
    },
    [bridge, profileId, setError],
  );

  useEffect(() => {
    if (!connected || profileId === null) return;
    let stopped = false;
    let inFlight = false;
    const refreshRegistry = async (): Promise<void> => {
      if (
        stopped ||
        inFlight ||
        !connectedRef.current ||
        profileIdRef.current !== profileId ||
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      inFlight = true;
      try {
        const bundles = await bridge.listAgentSessions({
          profileId,
          archive: 'all',
        });
        if (
          stopped ||
          !connectedRef.current ||
          profileIdRef.current !== profileId
        ) {
          return;
        }
        setSessions(bundles.map((bundle) => bundle.session));
        setTimelines((current) => ({
          ...current,
          ...Object.fromEntries(
            bundles.map((bundle) => [bundle.session.id, bundle.items]),
          ),
        }));
      } catch (refreshError) {
        if (
          !stopped &&
          connectedRef.current &&
          profileIdRef.current === profileId
        ) {
          setError(errorText(refreshError), null);
        }
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void refreshRegistry(), 4_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshRegistry();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [bridge, connected, profileId, setError]);

  const searchedSessions = useMemo(
    () =>
      sessions
        .filter((session) => session.agentKind === agent)
        .filter((session) =>
          workspaceScope === 'all' || workspaceCwd === null
            ? true
            : (session.projectId ?? session.cwd) === workspaceCwd,
        )
        .filter((session) => {
          if (archiveFilter === 'all') return true;
          const archived = session.archivedAt != null;
          return archiveFilter === 'archived' ? archived : !archived;
        })
        .filter((session) =>
          filters[agent] === ''
            ? true
            : `${session.title} ${session.host} ${session.project}`
                .toLowerCase()
                .includes(filters[agent].toLowerCase()),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [sessions, agent, filters, workspaceScope, workspaceCwd, archiveFilter],
  );
  // Counted before the bucket filter narrows the list, so every menu option shows
  // what it would reveal rather than what currently survives it.
  const bucketCounts = useMemo(() => {
    const counts: Record<SessionBucket, number> = {
      running: 0,
      needsInput: 0,
      ready: 0,
      offline: 0,
      exited: 0,
      error: 0,
    };
    for (const session of searchedSessions) {
      counts[sessionBucket(session.status)] += 1;
    }
    return counts;
  }, [searchedSessions]);
  const agentSessions = useMemo(
    () =>
      bucketFilter === 'all'
        ? searchedSessions
        : searchedSessions.filter(
            (session) => sessionBucket(session.status) === bucketFilter,
          ),
    [searchedSessions, bucketFilter],
  );

  const selectedSessionId = sessionView.selected[agent];
  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ?? null;
  const selectedSessionEntered =
    selectedSession !== null &&
    sessionView.entered[agent] === selectedSession.id;
  useEffect(() => {
    if (
      selectedSessionId !== null &&
      !agentSessions.some((session) => session.id === selectedSessionId)
    ) {
      setSessionView((current) =>
        forgetSessionView(current, agent, selectedSessionId),
      );
    }
  }, [agent, agentSessions, selectedSessionId]);
  useEffect(() => {
    if (selectedSession === null) setMobilePane('sessions');
  }, [selectedSession]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
    if (selectedSessionId === null) return;
    setUnreadIds((current) => {
      if (current[selectedSessionId] === undefined) return current;
      const next = { ...current };
      delete next[selectedSessionId];
      return next;
    });
  }, [selectedSessionId]);
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
  const agentDetectionError = installation?.detectionError;
  const agentDetectionFailed = agentDetectionError !== undefined;
  // Mirrors what create() actually accepts — an enabled button that the
  // service then refuses is worse than a disabled one with a reason.
  const canCreate =
    connected &&
    profileId !== null &&
    installation?.installed === true &&
    installation.installationScope === 'user' &&
    installation.supportsStructuredOutput &&
    installation.launchModes.length > 0;
  const agentUnavailable =
    installation !== undefined &&
    !agentDetectionFailed &&
    (!installation.installed || !installation.supportsStructuredOutput);

  const retryAgentDetection = async (): Promise<void> => {
    if (!connected || profileId === null) return;
    const retryingAgent = agent;
    setInstallations((current) => {
      const next = { ...current };
      delete next[retryingAgent];
      return next;
    });
    try {
      const detected = await bridge.detectAgent({
        profileId,
        agentKind: retryingAgent,
      });
      setInstallations((current) => ({
        ...current,
        [retryingAgent]: detected,
      }));
    } catch (detectionError) {
      const detail = errorText(detectionError);
      setInstallations((current) => ({
        ...current,
        [retryingAgent]: {
          agentKind: retryingAgent,
          installed: false,
          supportsStructuredOutput: false,
          supportsResume: false,
          supportsInteractiveApproval: false,
          launchModes: [],
          detectionError: detail,
          detail,
        },
      }));
    }
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
    const initialDirectory = workspaceCwd ?? '~';
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
      setMobilePane('chat');
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

  const setArchived = async (
    session: AgentSessionSummary,
    archived: boolean,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const bundle = archived
        ? await bridge.archiveAgentSession({ sessionId: session.id })
        : await bridge.restoreAgentSession({ sessionId: session.id });
      setSessions((current) =>
        current.map((candidate) =>
          candidate.id === bundle.session.id ? bundle.session : candidate,
        ),
      );
      setTimelines((current) => ({
        ...current,
        [bundle.session.id]: bundle.items,
      }));
      if (archived) {
        setSessionView((current) =>
          forgetSessionView(current, session.agentKind, session.id),
        );
        setMobilePane('sessions');
      } else if (archiveFilter === 'archived') {
        // Restoring moves this conversation out of the archived-only view.
        // Follow it back to Active instead of leaving an invisible selection.
        setArchiveFilter('active');
      }
    } catch (archiveError) {
      setError(errorText(archiveError), session.id);
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
    sendTimersRef.current[sessionId] = { timer: unconfirmedTimer, text };
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
        (current[sessionId] ?? '').trim() === text.trim()
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
      const bundles = await bridge.listAgentSessions({ profileId, archive: 'all' });
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
            item.kind === 'message' &&
            item.role === 'user' &&
            item.text.trim() === text.trim(),
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
          (current[sessionId] ?? '').trim() === text.trim()
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
    optionId?: string,
  ) => {
    if (selectedSessionId === null) return;
    setError(null);
    try {
      await bridge.resolveAgentApproval({
        sessionId: selectedSessionId,
        itemId,
        resolution,
        ...(optionId === undefined ? {} : { optionId }),
      });
    } catch (approvalError) {
      setError(errorText(approvalError));
    }
  };

  const setSessionConfigOption = async (configId: string, value: string) => {
    if (selectedSessionId === null) return;
    setError(null);
    try {
      await bridge.setAgentSessionConfigOption({
        sessionId: selectedSessionId,
        configId,
        value,
      });
    } catch (configError) {
      setError(errorText(configError));
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

  const unreadCount = sessions.reduce(
    (count, session) =>
      session.agentKind === agent && unreadIds[session.id] === true
        ? count + 1
        : count,
    0,
  );

  return (
    <div
      className={`agents-workspace mobile-pane-${mobilePane}${
        bridge.kind === 'capacitor' ? ' native-mobile' : ''
      }`}
    >
      <details ref={agentMenuRef} className="agent-landscape-menu">
        <summary aria-label="Agent session menu">
          <span className="agent-menu-hamburger" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="agent-menu-title">Sessions</span>
          <span className="agent-menu-context">
            {AGENTS.find((entry) => entry.kind === agent)?.label} /{' '}
            {workspaceScope === 'current' ? 'current workspace' : 'all workspaces'} /{' '}
            {archiveFilter}
            {unreadCount === 0 ? '' : ` / ${unreadCount} unread`}
          </span>
        </summary>
        <div className="agent-landscape-menu-panel">
          <label>
            <span>Agent</span>
            <select
              aria-label="Select agent"
              value={agent}
              onChange={(event) => {
                const nextAgent = event.target.value as AgentKind;
                setAgent(nextAgent);
                setMobilePane('sessions');
                closeAgentMenu();
                void refreshAgentSessions(nextAgent);
              }}
            >
              {AGENTS.map(({ kind, label }) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Workspace</span>
            <select
              aria-label="Session workspace"
              value={workspaceScope}
              onChange={(event) => {
                setWorkspaceScope(event.target.value as 'current' | 'all');
                closeAgentMenu();
              }}
            >
              <option value="current">Current workspace</option>
              <option value="all">All workspaces</option>
            </select>
          </label>
          <label>
            <span>Archive</span>
            <select
              aria-label="Session archive state"
              value={archiveFilter}
              onChange={(event) => {
                setArchiveFilter(
                  event.target.value as 'active' | 'archived' | 'all',
                );
                closeAgentMenu();
              }}
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">Active and archived</option>
            </select>
          </label>
          <label>
            <span>Runtime status</span>
            <select
              aria-label="Session status"
              value={bucketFilter}
              onChange={(event) => {
                setBucketFilter(event.target.value as SessionBucket | 'all');
                closeAgentMenu();
              }}
            >
              <option value="all">all</option>
              {(Object.keys(BUCKET_LABEL) as SessionBucket[]).map((bucket) => (
                <option key={bucket} value={bucket}>
                  {BUCKET_LABEL[bucket]} ({bucketCounts[bucket]})
                </option>
              ))}
            </select>
          </label>
          <label className="agent-menu-search">
            <span>Find session</span>
            <input
              type="search"
              aria-label="Find session"
              placeholder="Title, host, or workspace"
              value={filters[agent]}
              onChange={(event) =>
                setFilters((current) => ({ ...current, [agent]: event.target.value }))
              }
            />
          </label>
          <button
            type="button"
            disabled={!canCreate || busy}
            onClick={() => {
              closeAgentMenu();
              openCreate();
            }}
          >
            New session
          </button>
        </div>
      </details>

      {error !== null ? (
        <div className="agent-error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      ) : null}

      {!connected ? (
        <div className="agent-disconnected-empty" role="status">
          <strong>{reconnect ? '連線中斷 — 正在重連中' : '尚未連線'}</strong>
          <p>
            {reconnect
              ? `${reconnect.secondsLeft}s 後進行第 ${reconnect.attempt} 次重連嘗試；重新連線前不會讀取或顯示 Agent sessions。`
              : '連線到主機後才會讀取 Agent sessions。斷線期間不保留或顯示主機內容。'}
          </p>
        </div>
      ) : loading || installation === undefined ? (
        <div className="agent-setup">
          <h2>正在偵測 {AGENTS.find((entry) => entry.kind === agent)?.label}</h2>
          <p>
            {agent === 'agy'
              ? '確認遠端 AGY 執行檔與互動式 terminal 能力…'
              : '確認遠端執行檔與 bidirectional stream-json 能力…'}
          </p>
        </div>
      ) : (
        <div className={`agent-panes mobile-pane-${mobilePane}`} ref={panesRef}>
          <aside className="session-sidebar" style={{ width: clamp(sidebarWidth) }}>
            {agentDetectionFailed ? (
              <div className="agent-availability-banner" role="status">
                <strong>
                  {AGENTS.find((entry) => entry.kind === agent)?.label} 偵測失敗
                </strong>
                <p>{agentDetectionError}</p>
                <p className="hint">
                  尚未判定是否安裝；這不是「Agent 不可用」的證據。
                </p>
                <button type="button" onClick={() => void retryAgentDetection()}>
                  重新偵測
                </button>
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
            <div className="session-list">
              {agentSessions.map((session) => {
                const status = session.status;
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
                      setMobilePane('chat');
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
                    {archiveFilter === 'archived'
                      ? 'No archived sessions in this view.'
                      : archiveFilter === 'all'
                        ? 'No sessions in this view.'
                        : 'No active sessions. Create a new session to get started.'}
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
                  <button
                    type="button"
                    className="mobile-session-back"
                    onClick={() => setMobilePane('sessions')}
                    aria-label="Back to sessions"
                  >
                    <span aria-hidden="true">&larr;</span>
                    Sessions
                  </button>
                  <div>
                    <span className="chat-session-title-row">
                      <strong>{selectedSession.title}</strong>
                      {reconnect ? (
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
                      {lastUsage === undefined
                          ? ' · 用量未知'
                          : ` · 用量 in ${lastUsage.inputTokens.toLocaleString()} / out ${lastUsage.outputTokens.toLocaleString()} tokens`}
                    </span>
                  </div>
                  <div
                    className={`session-status session-status-${selectedSession.status}`}
                    aria-label={`Session status: ${STATUS_LABEL[selectedSession.status]}`}
                  >
                    <span className="session-status-dot" aria-hidden="true" />
                    <span>{STATUS_LABEL[selectedSession.status]}</span>
                    {selectedSession.archivedAt == null ? null : (
                      <span className="session-archive-label">archived</span>
                    )}
                  </div>
                  {selectedSessionEntered ? (
                    <div className="chat-session-actions">
                      {(selectedSession.configOptions ?? [])
                        .filter((option) => option.options.length > 0)
                        .map((option) => (
                          <label
                            key={option.id}
                            className="config-option"
                            title={option.description}
                          >
                            <span className="config-option-name">{option.name}</span>
                            <select
                              value={option.currentValue ?? ''}
                              disabled={!connected}
                              onChange={(event) =>
                                void setSessionConfigOption(
                                  option.id,
                                  event.target.value,
                                )
                              }
                            >
                              {option.options.map((choice) => (
                                <option key={choice.value} value={choice.value}>
                                  {choice.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ))}
                      {selectedSession.status === 'running' ||
                      selectedSession.status === 'waiting_approval' ? (
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
                      {selectedSession.status === 'disconnected' ||
                      selectedSession.status === 'exited' ||
                      selectedSession.status === 'error' ? (
                        // The composer's hint says "按 Resume"; the button has
                        // to exist in the same view the hint appears in.
                        <button
                          className="ghost"
                          disabled={
                            !connected || resuming[selectedSession.id] === true
                          }
                          onClick={() => void resumeSession(selectedSession)}
                        >
                          {resuming[selectedSession.id] === true
                            ? 'Resuming…'
                            : 'Resume'}
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
                    {timeline.length === 0 ? (
                      <ZeroMessageState
                        sessionTitle={selectedSession.title}
                        agentKind={selectedSession.agentKind}
                      />
                    ) : (
                      <TimelineErrorBoundary>
                        <ChatTimeline
                          key={selectedSession.id}
                          sessionId={selectedSession.id}
                          sessionCwd={selectedSession.cwd}
                          items={timeline}
                          sessionStatus={selectedSession.status}
                          sessionError={errorFor(selectedSession.id)}
                          // A blocked agent must be answerable where its card
                          // is seen — the service does not care whether the
                          // renderer has "entered" the session.
                          onResolveApproval={(itemId, resolution, optionId) =>
                            void resolveApproval(itemId, resolution, optionId)
                          }
                          onAnswerQuestion={(itemId, optionIndex) =>
                            void answerQuestion(itemId, optionIndex)
                          }
                          onDeclineQuestion={(itemId) => void declineQuestion(itemId)}
                          onRetrySession={() => void resumeSession(selectedSession)}
                        />
                      </TimelineErrorBoundary>
                    )}
                    <div className="session-resume-bar">
                      <span>
                        {selectedSession.archivedAt == null
                          ? '已選取但尚未進入。按 Resume 後才會連回這個 session，並顯示訊息與附件輸入區。'
                          : '這段完整對話已封存。Restore 只會把它放回 Active，不會自動啟動 Agent。'}
                      </span>
                      <span className={`session-status session-status-${selectedSession.status}`}>
                        <span className="session-status-dot" aria-hidden="true" />
                        {STATUS_LABEL[selectedSession.status]}
                      </span>
                      <button
                        className="composer-send"
                        disabled={
                          !connected ||
                          busy ||
                          resuming[selectedSession.id] === true
                        }
                        onClick={() =>
                          void (selectedSession.archivedAt == null
                            ? resumeSession(selectedSession)
                            : setArchived(selectedSession, false))
                        }
                      >
                        {selectedSession.archivedAt != null
                          ? busy
                            ? 'Restoring…'
                            : 'Restore'
                          : resuming[selectedSession.id] === true
                            ? 'Resuming…'
                            : 'Resume'}
                      </button>
                    </div>
                  </>
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
                          key={selectedSession.id}
                          sessionId={selectedSession.id}
                          sessionCwd={selectedSession.cwd}
                          items={timeline}
                          sessionStatus={selectedSession.status}
                          sessionError={errorFor(selectedSession.id)}
                          onResolveApproval={(itemId, resolution, optionId) =>
                            void resolveApproval(itemId, resolution, optionId)
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
            {
              id: 'rename',
              label: 'Rename',
              disabled: !connected || busy,
              hint: connected ? undefined : 'Reconnect to the session host first',
            },
            {
              id: sessionMenu.session.archivedAt == null ? 'archive' : 'restore',
              label:
                sessionMenu.session.archivedAt == null
                  ? 'Archive conversation'
                  : 'Restore conversation',
              separatorBefore: true,
              disabled:
                !connected ||
                busy ||
                sessionMenu.session.status === 'starting' ||
                sessionMenu.session.status === 'running' ||
                sessionMenu.session.status === 'waiting_approval',
              hint:
                !connected
                  ? 'Reconnect to the session host first'
                  : sessionMenu.session.status === 'starting' ||
                sessionMenu.session.status === 'running' ||
                sessionMenu.session.status === 'waiting_approval'
                  ? 'Stop the active run first'
                  : sessionMenu.session.archivedAt == null
                    ? 'Keeps the full conversation and removes it from Active'
                    : 'Returns it to Active without starting an agent',
            },
          ]}
          onSelect={(actionId) => {
            if (actionId === 'rename') {
              setRenameSession(sessionMenu.session);
              setRenameTitle(sessionMenu.session.title);
            } else if (actionId === 'archive') {
              void setArchived(sessionMenu.session, true);
            } else if (actionId === 'restore') {
              void setArchived(sessionMenu.session, false);
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

    </div>
  );
}
