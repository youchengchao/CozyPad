import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentInstallation,
  AgentKind,
  AgentSessionStatus,
  AgentSessionSummary,
  ChatItem,
  RemoteFileItem,
  SlashCommand,
} from '@cozypad/contracts';
import { MAX_AGENT_ATTACHMENT_BYTES } from '@cozypad/contracts';
import { ContextMenu, useLongPress } from '../../components/ContextMenu';
import { getBridge } from '../../platform/bridge';
import { AgyCliSurface, clearAgySessionCache } from './AgyCliSurface';
import { ChatComposer } from './ChatComposer';
import type { ComposerAttachment } from './ChatComposer';
import { ChatTimeline } from './ChatTimeline';

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

/** The three states a user actually reasons about when scanning the list. */
type SessionBucket = 'running' | 'idle' | 'exited';

const BUCKET_LABEL: Record<SessionBucket, string> = {
  running: 'running',
  idle: 'idle',
  exited: 'exited',
};

function sessionBucket(status: AgentSessionStatus): SessionBucket {
  if (status === 'running' || status === 'waiting_approval' || status === 'starting') {
    return 'running';
  }
  if (status === 'exited' || status === 'error') return 'exited';
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

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
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
  waking,
  menuOpen,
  onActivate,
  onOpenMenu,
}: {
  session: AgentSessionSummary;
  status: AgentSessionStatus;
  active: boolean;
  waking: boolean;
  menuOpen: boolean;
  onActivate(): void;
  onOpenMenu(x: number, y: number): void;
}) {
  const lastPointerType = useRef('mouse');
  const longPressOpened = useRef(false);
  const longPress = useLongPress((x, y) => {
    longPressOpened.current = true;
    onOpenMenu(x, y);
  });

  return (
    <button
      data-session-id={session.id}
      className={`session-item${active ? ' session-item-active' : ''}`}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      onClick={(event) => {
        const keyboardClick = event.detail === 0;
        const desktopClick =
          keyboardClick || lastPointerType.current === 'mouse';

        if (!longPressOpened.current) onActivate();
        if (desktopClick) {
          const bounds = event.currentTarget.getBoundingClientRect();
          onOpenMenu(
            keyboardClick ? bounds.left + bounds.width / 2 : event.clientX,
            keyboardClick ? bounds.bottom : event.clientY,
          );
        }
        longPressOpened.current = false;
      }}
      onContextMenu={longPress.onContextMenu}
      onPointerDown={(event) => {
        lastPointerType.current = event.pointerType;
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
          {waking ? 'waking…' : STATUS_LABEL[status]}
        </span>
        <span className="session-time">{formatTime(session.updatedAt)}</span>
      </span>
    </button>
  );
}

interface AgentsWorkspaceProps {
  connected: boolean;
  profileId: string | null;
}

export function AgentsWorkspace({ connected, profileId }: AgentsWorkspaceProps) {
  const bridge = useMemo(() => getBridge(), []);
  const [agent, setAgent] = useState<AgentKind>('claude');
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [timelines, setTimelines] = useState<Record<string, ChatItem[]>>({});
  const [installations, setInstallations] = useState<
    Partial<Record<AgentKind, AgentInstallation>>
  >({});
  const [selected, setSelected] = useState<Record<AgentKind, string | null>>({
    claude: null,
    codex: null,
    agy: null,
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<
    Record<string, ComposerAttachment[]>
  >({});
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
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
  const [waking, setWaking] = useState<Record<string, boolean>>({});
  /**
   * Bumped when a session is revived. The AGY surface is keyed on it: the old
   * surface's terminal died with the old process, so the new process needs a
   * fresh mount to attach to.
   */
  const [reviveNonce, setReviveNonce] = useState<Record<string, number>>({});

  /**
   * Sessions the user removed. A late update for one — a follow stream ending,
   * a status settling — must not resurrect the row it was deleted from.
   */
  const forgotten = useRef(new Set<string>());

  /** Drop every trace of a session from the UI. */
  const forgetSession = useCallback((sessionId: string, agentKind: AgentKind) => {
    forgotten.current.add(sessionId);
    clearAgySessionCache(sessionId);
    setSessions((current) => current.filter((session) => session.id !== sessionId));
    setSelected((selection) =>
      selection[agentKind] === sessionId
        ? { ...selection, [agentKind]: null }
        : selection,
    );
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
    setInterrupting(drop);
    setAgyActivity(drop);
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
      setSelected((current) => ({
        ...current,
        [session.agentKind]: current[session.agentKind] ?? session.id,
      }));
    });
    const unsubscribeTimeline = bridge.onAgentTimelineChanged(
      ({ sessionId, items }) => {
        setTimelines((current) => ({ ...current, [sessionId]: items }));
      },
    );
    const unsubscribeDeleted = bridge.onAgentSessionDeleted(
      ({ sessionId, agentKind }) => forgetSession(sessionId, agentKind),
    );
    const unsubscribeError = bridge.onAgentCommunicationError((event) => {
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
    setSelected((current) => {
      const next = { ...current };
      let changed = false;
      for (const { kind } of AGENTS) {
        if (
          next[kind] === null ||
          !sessions.some(
            (session) => session.id === next[kind] && session.agentKind === kind,
          )
        ) {
          const fallback = sessions.find((session) => session.agentKind === kind)?.id ?? null;
          if (next[kind] !== fallback) {
            next[kind] = fallback;
            changed = true;
          }
        }
      }
      return changed ? next : current;
    });
  }, [sessions]);

  useEffect(() => {
    if (!connected || profileId === null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
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
        setSelected((current) => {
          const next = { ...current };
          for (const { kind } of AGENTS) {
            if (
              next[kind] === null ||
              !bundles.some((bundle) => bundle.session.id === next[kind])
            ) {
              next[kind] =
                bundles.find((bundle) => bundle.session.agentKind === kind)?.session
                  .id ?? null;
            }
          }
          return next;
        });
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
   * only thing that knows whether it is thinking right now is the live screen.
   */
  const liveStatus = useCallback(
    (session: AgentSessionSummary): AgentSessionStatus =>
      session.agentKind === 'agy'
        ? (agyActivity[session.id] ?? session.status)
        : session.status,
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
    const counts: Record<SessionBucket, number> = { running: 0, idle: 0, exited: 0 };
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

  const selectedSessionId = selected[agent];
  const selectedSession =
    sessions.find((session) => session.id === selectedSessionId) ?? null;
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
  const installation = installations[agent];
  const canCreate =
    connected &&
    profileId !== null &&
    installation?.installed === true &&
    installation.installationScope === 'user' &&
    (agent === 'agy' || installation.supportsStructuredOutput) &&
    installation.launchModes.length > 0;

  const badge = (kind: AgentKind) => {
    const mine = sessions.filter((session) => session.agentKind === kind);
    return {
      waiting: mine.some((session) => session.status === 'waiting_approval'),
      running: mine.some((session) => session.status === 'running'),
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
      setSelected((current) => ({
        ...current,
        [bundle.session.agentKind]: bundle.session.id,
      }));
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
    setBusy(true);
    setError(null);
    try {
      await bridge.deleteAgentSession({ sessionId });
      // Drop it from the UI here rather than waiting for the change event to
      // come back. Until the surface unmounts it keeps talking about a session
      // the host has already forgotten, which surfaced as "unknown agent
      // session" right after a delete that had in fact worked.
      forgetSession(sessionId, agentKind);
    } catch (deleteError) {
      setError(errorText(deleteError));
    } finally {
      setBusy(false);
    }
  };

  const sendMessage = async (text: string) => {
    if (selectedSessionId === null) return;
    const pending = attachments[selectedSessionId] ?? [];
    setDrafts((current) => ({ ...current, [selectedSessionId]: '' }));
    setError(null);
    try {
      await bridge.sendAgentMessage({
        sessionId: selectedSessionId,
        text,
        attachmentIds: pending.map((attachment) => attachment.id),
      });
      pending.forEach((attachment) => {
        if (attachment.previewUrl !== undefined) URL.revokeObjectURL(attachment.previewUrl);
      });
      setAttachments((current) => ({ ...current, [selectedSessionId]: [] }));
    } catch (sendError) {
      setDrafts((current) => ({ ...current, [selectedSessionId]: text }));
      setError(errorText(sendError));
    }
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

  const attachFiles = async (files: File[]) => {
    if (selectedSessionId === null || files.length === 0) return;
    const sessionId = selectedSessionId;
    const remaining = Math.max(0, 10 - (attachments[sessionId]?.length ?? 0));
    const selectedFiles = files.slice(0, remaining);
    if (selectedFiles.length === 0) return;
    setUploading((current) => ({ ...current, [sessionId]: true }));
    setError(null);
    try {
      for (const file of selectedFiles) {
        if (file.size > MAX_AGENT_ATTACHMENT_BYTES) {
          throw new Error(
            `${file.name} is too large (${file.size} bytes; limit ${MAX_AGENT_ATTACHMENT_BYTES} bytes)`,
          );
        }
        const uploaded = await bridge.uploadAgentAttachment({
          sessionId,
          name: file.name,
          mediaType: file.type || 'application/octet-stream',
          dataBase64: await fileToBase64(file),
        });
        const previewUrl = file.type.startsWith('image/')
          ? URL.createObjectURL(file)
          : undefined;
        setAttachments((current) => ({
          ...current,
          [sessionId]: [
            ...(current[sessionId] ?? []),
            {
              id: uploaded.id,
              name: uploaded.name,
              mediaType: uploaded.mediaType,
              sizeBytes: uploaded.sizeBytes,
              ...(previewUrl === undefined ? {} : { previewUrl }),
            },
          ],
        }));
      }
    } catch (attachmentError) {
      setError(errorText(attachmentError));
    } finally {
      setUploading((current) => ({ ...current, [sessionId]: false }));
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

  /**
   * Selecting a dead session is the whole gesture: nobody clicks an exited
   * conversation to admire it, so the click relaunches its agent in place.
   */
  const wakeSession = async (sessionId: string) => {
    if (waking[sessionId] === true) return;
    setWaking((current) => ({ ...current, [sessionId]: true }));
    try {
      await bridge.reviveAgentSession({ sessionId });
      // The AGY surface must remount to attach to the new process's console,
      // and its cached "exited" reading belongs to the old one.
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
    } catch (reviveError) {
      setError(errorText(reviveError));
    } finally {
      setWaking((current) => {
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

      {!connected ? (
        <div className="agent-setup">
          <h2>先連線到遠端主機</h2>
          <p>Agent 對話會在遠端指定路徑建立 tmux session，並立刻啟動 Agent。</p>
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
      ) : !installation.installed ||
        (agent !== 'agy' && !installation.supportsStructuredOutput) ? (
        <div className="agent-setup">
          <h2>{AGENTS.find((entry) => entry.kind === agent)?.label} 尚不可用</h2>
          <p>{installation.detail ?? '遠端 Agent 或 structured protocol 不可用。'}</p>
          {environmentText(installation) !== null ? (
            <p className="hint">
              Remote: {environmentText(installation)}
              {installation.environment?.loginShell === undefined
                ? ''
                : ` · shell ${installation.environment.loginShell}`}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="agent-panes">
          <aside className="session-sidebar">
            <input
              className="session-filter"
              placeholder="搜尋 sessions…"
              value={filters[agent]}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  [agent]: event.target.value,
                }))
              }
            />
            <div className="session-bucket-filter" role="radiogroup" aria-label="Session status filter">
              {(['all', 'running', 'idle', 'exited'] as const).map((bucket) => (
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
                const bucket = sessionBucket(status);
                return (
                  <SessionListItem
                    key={session.id}
                    session={session}
                    status={status}
                    active={session.id === selectedSessionId}
                    waking={waking[session.id] === true}
                    menuOpen={sessionMenu?.session.id === session.id}
                    onActivate={() => {
                      setSelected((current) => ({
                        ...current,
                        [agent]: session.id,
                      }));
                      if (bucket === 'exited' && connected) {
                        void wakeSession(session.id);
                      }
                    }}
                    onOpenMenu={(x, y) => setSessionMenu({ session, x, y })}
                  />
                );
              })}
              {agentSessions.length === 0 ? (
                <p className="hint session-empty">
                  {bucketFilter === 'all'
                    ? '還沒有對話。'
                    : `沒有${BUCKET_LABEL[bucketFilter]} 狀態的對話。`}
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
                    </span>
                    <span className="mono">{selectedSession.cwd}</span>
                  </div>
                  {selectedSession.agentKind !== 'agy' &&
                  (selectedSession.status === 'running' ||
                    selectedSession.status === 'waiting_approval') ? (
                    <div className="chat-session-actions">
                      <button
                        className="ghost"
                        disabled={interrupting[selectedSession.id] === true}
                        onClick={() => void stopSession(selectedSession.id)}
                      >
                        {interrupting[selectedSession.id] === true
                          ? 'Stopping…'
                          : 'Stop'}
                      </button>
                    </div>
                  ) : null}
                </div>
                {selectedSession.agentKind === 'agy' ? (
                  <AgyCliSurface
                    key={`${selectedSession.id}:${reviveNonce[selectedSession.id] ?? 0}`}
                    sessionId={selectedSession.id}
                    cwd={selectedSession.cwd}
                    sessionStatus={selectedSession.status}
                    stopping={interrupting[selectedSession.id] === true}
                    onInterrupt={() => stopSession(selectedSession.id)}
                    onNotify={(message) => setError(message)}
                    onStatusChange={(status) =>
                      setAgyActivity((current) =>
                        current[selectedSession.id] === status
                          ? current
                          : { ...current, [selectedSession.id]: status },
                      )
                    }
                  />
                ) : (
                  <>
                    <ChatTimeline
                      sessionId={selectedSession.id}
                      items={timeline}
                      onResolveApproval={(itemId, resolution) =>
                        void resolveApproval(itemId, resolution)
                      }
                      onAnswerQuestion={(itemId, optionIndex) =>
                        void answerQuestion(itemId, optionIndex)
                      }
                    />
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
                      }))}
                      attachments={attachments[selectedSession.id] ?? []}
                      uploading={uploading[selectedSession.id] === true}
                      running={
                        selectedSession.status === 'running' ||
                        selectedSession.status === 'waiting_approval'
                      }
                      stopping={interrupting[selectedSession.id] === true}
                      disabled={
                        selectedSession.status === 'running' ||
                        selectedSession.status === 'waiting_approval' ||
                        selectedSession.status === 'starting' ||
                        selectedSession.status === 'exited'
                      }
                      onChange={(value) =>
                        setDrafts((current) => ({
                          ...current,
                          [selectedSession.id]: value,
                        }))
                      }
                      onAttach={(files) => void attachFiles(files)}
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
                <p>新增或選擇一個對話。</p>
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
              This stops the tmux session and removes CozyPad's local and remote
              metadata for <strong>{deleteSession.title}</strong>.
            </p>
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
