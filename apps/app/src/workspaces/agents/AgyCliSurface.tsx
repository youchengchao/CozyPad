import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { Terminal } from '@xterm/xterm';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  base64ToBytes,
  textToBase64,
  type AgentSessionStatus,
  type TerminalClosedEvent,
  type TerminalOutputEvent,
} from '@cozypad/contracts';
import { getBridge } from '../../platform/bridge';
import {
  agyKeySequence,
  agyOptionSelectionSequence,
  agyPromptSequence,
  deriveAgyScreenModel,
  extractAgyAssistantText,
  isAgyComposerEditable,
  isStaleAgyReplyCandidate,
  mayScrapeAgyReply,
  mirrorAgyDraft,
  nextSuggestionIndex,
  segmentAgyReply,
  type AgyNavigationKey,
  type AgyScreenModel,
} from './agyTerminalModel';
import {
  readAgyStatus,
  recogniseAgyScreen,
  type AgyStatus,
  type AgyTypedScreen,
} from './agyScreens';

interface AgyCliSurfaceProps {
  sessionId: string;
  cwd: string;
  sessionStatus: AgentSessionStatus;
  stopping: boolean;
  onInterrupt(): Promise<void>;
  onNotify(message: string): void;
  onStatusChange(status: AgentSessionStatus): void;
}

interface AgyLocalTurn {
  id: string;
  prompt: string;
  assistantText: string;
  createdAt: number;
}

type ConnectionState = 'connecting' | 'connected' | 'closed' | 'error';
type StopVerification = 'idle' | 'requested' | 'confirmed' | 'unconfirmed';
type StatusSyncPhase =
  | 'waiting'
  | 'context'
  | 'contextClosing'
  | 'usage'
  | 'usageClosing'
  | 'settling'
  | 'done'
  | 'failed';

const AGY_TURN_CACHE = new Map<string, AgyLocalTurn[]>();
const AGY_STATUS_CACHE = new Map<string, AgyStatus>();

function hasCompleteAgyStatus(status: AgyStatus): boolean {
  return status.contextUsedPercent !== undefined && status.limits !== undefined;
}

/**
 * Turns also persist to localStorage so a conversation survives an app
 * restart: the backend revives the CLI with `--continue`, and this restores
 * the transcript the user was looking at alongside it.
 */
const turnStorageKey = (sessionId: string) => `cozypad.agy.turns.${sessionId}`;

function readPersistedTurns(sessionId: string): AgyLocalTurn[] {
  try {
    const raw = window.localStorage.getItem(turnStorageKey(sessionId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (turn): turn is AgyLocalTurn =>
        typeof turn === 'object' &&
        turn !== null &&
        typeof (turn as AgyLocalTurn).id === 'string' &&
        typeof (turn as AgyLocalTurn).prompt === 'string' &&
        typeof (turn as AgyLocalTurn).assistantText === 'string' &&
        typeof (turn as AgyLocalTurn).createdAt === 'number',
    );
  } catch {
    return [];
  }
}

function persistTurns(sessionId: string, turns: AgyLocalTurn[]): void {
  try {
    window.localStorage.setItem(
      turnStorageKey(sessionId),
      JSON.stringify(turns.slice(-50)),
    );
  } catch {
    // Storage full or unavailable — the in-memory cache still works.
  }
}

/**
 * This terminal is a headless parser — it is never attached to the DOM, so its
 * size is not a layout concern. Both ends must simply agree: AGY positions its
 * redraws by absolute column, so a local/remote width mismatch makes every
 * frame overwrite itself. Keeping one fixed size removes that whole class of
 * corruption, and a stable size also keeps the parsed screen deterministic
 * instead of re-flowing whenever the window moves.
 */
const AGY_COLS = 120;
const AGY_ROWS = 40;

export function clearAgySessionCache(sessionId: string): void {
  AGY_TURN_CACHE.delete(sessionId);
  AGY_STATUS_CACHE.delete(sessionId);
  try {
    window.localStorage.removeItem(turnStorageKey(sessionId));
  } catch {
    // Nothing to clean if storage is unavailable.
  }
}

function readTerminalScreen(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.baseY);
  return Array.from({ length: terminal.rows }, (_, row) =>
    buffer.getLine(start + row)?.translateToString(true) ?? '',
  );
}

function navigationKeyForEvent(event: React.KeyboardEvent): AgyNavigationKey | null {
  if (event.shiftKey && event.key === 'ArrowUp') return 'pageUp';
  if (event.shiftKey && event.key === 'ArrowDown') return 'pageDown';
  switch (event.key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    case 'PageUp':
      return 'pageUp';
    case 'PageDown':
      return 'pageDown';
    case 'Home':
      return 'home';
    case 'End':
      return 'end';
    case 'Enter':
      return 'enter';
    case 'Escape':
      return 'escape';
    case 'Tab':
      return 'tab';
    default:
      return null;
  }
}

function panelCopy(model: AgyScreenModel): string[] {
  // The question title and choices already carry the complete interaction.
  // AGY also leaves fragments such as `Question 1/1` and the tail of the
  // user's tool instruction on screen; presenting those as explanatory copy
  // duplicates the question and leaks terminal furniture into the chat UI.
  if (model.mode === 'question') return [];
  const optionLines = new Set(model.options.map((option) => option.lineIndex));
  return model.rawLines
    .filter((line, index) => index !== model.promptLineIndex && !optionLines.has(index))
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== '' &&
        !/^agy(?:\s+v?[\d.]+|\s+native|$)/iu.test(line) &&
        !/(?:↑|↓|←|→|arrow|enter\s+select|tab\s+to|ctrl\+|esc\s+to)/iu.test(line),
    )
    .slice(-5);
}

function DiffLines({ diff }: { diff: string }) {
  return (
    <pre className="diff-body">
      {diff.split('\n').map((line, index) => {
        const className =
          line.startsWith('+++') || line.startsWith('---')
            ? 'diff-file'
            : line.startsWith('+')
              ? 'diff-add'
              : line.startsWith('-')
                ? 'diff-del'
                : line.startsWith('@@')
                  ? 'diff-hunk'
                  : '';
        return (
          <span className={className} key={index}>
            {line}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

function AgyDiffCard({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  const path =
    lines
      .find((line) => line.startsWith('+++ '))
      ?.replace(/^\+\+\+\s+(?:b\/)?/u, '') ?? 'File changes';
  const additions = lines.filter(
    (line) => line.startsWith('+') && !line.startsWith('+++'),
  ).length;
  const deletions = lines.filter(
    (line) => line.startsWith('-') && !line.startsWith('---'),
  ).length;
  return (
    <details className="card diff-card agy-diff-card" open>
      <summary>
        <span className="mono diff-path">{path}</span>
        <span className="diff-stat">
          <span className="diff-add">+{additions}</span>{' '}
          <span className="diff-del">-{deletions}</span>
        </span>
      </summary>
      <DiffLines diff={diff} />
    </details>
  );
}

function MarkdownPre({ children }: ComponentPropsWithoutRef<'pre'>) {
  const child = Children.count(children) === 1 ? Children.only(children) : null;
  if (
    isValidElement<{
      className?: string;
      children?: ReactNode;
    }>(child)
  ) {
    const language = child.props.className ?? '';
    const text = String(child.props.children ?? '').replace(/\n$/u, '');
    if (/\blanguage-(?:diff|patch)\b/u.test(language)) {
      return <AgyDiffCard diff={text} />;
    }
    if (/\blanguage-(?:gitlog|git-log)\b/u.test(language)) {
      return (
        <section className="card agy-git-history">
          <strong>Git history</strong>
          <pre>{text}</pre>
        </section>
      );
    }
  }
  return <pre>{children}</pre>;
}

/**
 * The overlays AGY draws get purpose-built controls rather than a flat list of
 * buttons: the model picker has two independent axes, and a conversation row
 * has columns. The UI expresses intent — "focus row 3", "set effort to medium"
 * — and the caller turns that into the key presses the CLI expects.
 */
function AgyOverlay({
  screen,
  onFocus,
  onAdjust,
  onConfirm,
  onCancel,
}: {
  screen: AgyTypedScreen;
  onFocus(index: number): void;
  onAdjust(delta: number): void;
  onConfirm(): void;
  onCancel(): void;
}) {
  const footer = (
    <div className="agy-overlay-keys">
      {screen.keys.map((key) => (
        <span key={`${key.label}-${key.action}`}>
          <kbd>{key.label}</kbd> {key.action}
        </span>
      ))}
    </div>
  );

  if (screen.kind === 'modelPicker') {
    const focused = screen.models.findIndex((model) => model.focused);
    return (
      <section className="card agy-overlay" data-testid="agy-overlay-modelPicker">
        <h3>{screen.title}</h3>
        <div className="agy-overlay-rows" role="listbox">
          {screen.models.map((model) => (
            <button
              type="button"
              role="option"
              aria-selected={model.focused}
              className={`agy-overlay-row${model.focused ? ' agy-overlay-row-focused' : ''}`}
              key={`${model.label}|${model.qualifier ?? ''}`}
              onClick={() => onFocus(model.index)}
            >
              <span className="agy-overlay-label">{model.label}</span>
              {model.qualifier === undefined ? null : (
                <span className="agy-overlay-tag">{model.qualifier}</span>
              )}
              {model.current ? (
                <span className="agy-overlay-current">使用中</span>
              ) : null}
            </button>
          ))}
        </div>
        {screen.effort === undefined ? null : (
          <div className="agy-effort">
            <span className="agy-effort-caption">Effort</span>
            <div className="agy-effort-track" role="group" aria-label="Reasoning effort">
              {screen.effort.levels.map((level, index) => (
                <button
                  type="button"
                  key={level}
                  aria-pressed={index === screen.effort!.selectedIndex}
                  className={`agy-effort-step${
                    index === screen.effort!.selectedIndex ? ' agy-effort-step-on' : ''
                  }`}
                  onClick={() => onAdjust(index - screen.effort!.selectedIndex)}
                >
                  {level}
                </button>
              ))}
            </div>
            {screen.effort.description === undefined ? null : (
              <p className="agy-effort-note">{screen.effort.description}</p>
            )}
          </div>
        )}
        <div className="agy-overlay-actions">
          <button onClick={onConfirm} disabled={focused < 0}>
            套用
          </button>
          <button className="ghost" onClick={onCancel}>
            取消
          </button>
        </div>
        {footer}
      </section>
    );
  }

  if (screen.kind === 'sessionPicker') {
    return (
      <section className="card agy-overlay" data-testid="agy-overlay-sessionPicker">
        <h3>Conversations</h3>
        <div className="agy-overlay-rows" role="listbox">
          {screen.rows.map((row) => (
            <button
              type="button"
              role="option"
              aria-selected={row.focused}
              className={`agy-overlay-row${row.focused ? ' agy-overlay-row-focused' : ''}`}
              key={`${row.index}-${row.title}`}
              onClick={() => onFocus(row.index)}
            >
              <span className="agy-overlay-label">{row.title}</span>
              {row.workspace === undefined ? null : (
                <span className="agy-overlay-tag mono">{row.workspace}</span>
              )}
              <span className="agy-overlay-meta">
                {row.steps} steps · {row.age}
              </span>
            </button>
          ))}
        </div>
        <div className="agy-overlay-actions">
          <button onClick={onConfirm}>開啟</button>
          <button className="ghost" onClick={onCancel}>
            取消
          </button>
        </div>
        {footer}
      </section>
    );
  }

  if (screen.kind === 'quotaReport') {
    return (
      <section className="card agy-overlay" data-testid="agy-overlay-quotaReport">
        <h3>{screen.title}</h3>
        {screen.account === undefined ? null : (
          <p className="agy-overlay-meta">{screen.account}</p>
        )}
        {screen.groups.map((group) => (
          <div className="agy-quota-group" key={group.name}>
            <strong>{group.name}</strong>
            {group.members === undefined ? null : (
              <p className="agy-overlay-meta">{group.members}</p>
            )}
            {group.limits.map((limit) => (
              <div className="agy-quota-limit" key={limit.label}>
                <span className="agy-quota-label">{limit.label}</span>
                <span
                  className="agy-quota-track"
                  role="img"
                  aria-label={`${limit.label} ${limit.percent}%`}
                >
                  <span
                    className="agy-quota-fill"
                    style={{ width: `${limit.percent}%` }}
                  />
                </span>
                <span className="agy-quota-note">{limit.note}</span>
              </div>
            ))}
          </div>
        ))}
        {screen.footnote === undefined ? null : (
          <p className="agy-overlay-meta">{screen.footnote}</p>
        )}
        <div className="agy-overlay-actions">
          <button className="ghost" onClick={onCancel}>
            關閉
          </button>
        </div>
        {footer}
      </section>
    );
  }

  if (screen.kind === 'contextReport') {
    return (
      <section className="card agy-overlay" data-testid="agy-overlay-contextReport">
        <h3>{screen.title}</h3>
        <p className="agy-overlay-meta">{screen.summary}</p>
        <div className="agy-context-bar" role="img" aria-label={screen.summary}>
          {screen.segments
            .filter((segment) => segment.percent > 0)
            .map((segment) => (
              <span
                key={segment.label}
                className="agy-context-slice"
                style={{ width: `${segment.percent}%` }}
                title={`${segment.label}: ${segment.amount}`}
              />
            ))}
        </div>
        <ul className="agy-context-legend">
          {screen.segments.map((segment) => (
            <li key={segment.label}>
              <span>{segment.label}</span>
              <span className="mono">
                {segment.amount} ({segment.percent}%)
              </span>
            </li>
          ))}
        </ul>
        <div className="agy-overlay-actions">
          <button className="ghost" onClick={onCancel}>
            關閉
          </button>
        </div>
        {footer}
      </section>
    );
  }

  const rows =
    screen.kind === 'permissionScopes'
      ? screen.scopes.map((scope) => ({
          key: scope.label,
          label: scope.label,
          focused: scope.focused,
          index: scope.index,
          note: undefined as string | undefined,
        }))
      : screen.agents.map((agent) => ({
          key: agent.label,
          label: agent.label,
          focused: agent.focused,
          index: agent.index,
          note: agent.description,
        }));

  return (
    <section className={`card agy-overlay`} data-testid={`agy-overlay-${screen.kind}`}>
      <h3>{screen.title}</h3>
      {screen.kind === 'permissionScopes' ? <p>{screen.prompt}</p> : null}
      <div className="agy-overlay-rows" role="listbox">
        {rows.map((row) => (
          <button
            type="button"
            role="option"
            aria-selected={row.focused}
            className={`agy-overlay-row${row.focused ? ' agy-overlay-row-focused' : ''}`}
            key={row.key}
            onClick={() => onFocus(row.index)}
          >
            <span className="agy-overlay-label">{row.label}</span>
            {row.note === undefined ? null : (
              <span className="agy-overlay-meta">{row.note}</span>
            )}
          </button>
        ))}
      </div>
      {screen.kind === 'permissionScopes' && screen.description !== undefined ? (
        <p className="agy-overlay-meta">{screen.description}</p>
      ) : null}
      <div className="agy-overlay-actions">
        <button onClick={onConfirm}>選擇</button>
        <button className="ghost" onClick={onCancel}>
          取消
        </button>
      </div>
      {footer}
    </section>
  );
}

/**
 * Render one reply the way the rest of the product renders a turn: prose in a
 * bubble, each tool run as its own card, and the agent's reasoning collapsed
 * behind a disclosure — rather than one block of terminal text.
 */
function AgyReply({
  text,
  streaming,
  onToggleToolDetails,
}: {
  text: string;
  streaming: boolean;
  onToggleToolDetails(): void;
}) {
  const blocks = useMemo(() => segmentAgyReply(text), [text]);
  return (
    <>
      {blocks.map((block, index) => {
        const last = index === blocks.length - 1;
        if (block.kind === 'tool') {
          return (
            <details className={`card tool-card tool-${block.status}`} key={index}>
              <summary>
                <span className={`tool-status tool-status-${block.status}`} />
                <span className="tool-name">{block.name}</span>
                <span className="tool-summary mono">{block.detail}</span>
              </summary>
              {block.detail === '' ? null : (
                <pre className="tool-output">{block.detail}</pre>
              )}
              <button
                type="button"
                className="agy-tool-native-view"
                data-testid="agy-tool-native-view"
                onClick={onToggleToolDetails}
              >
                View in AGY
              </button>
            </details>
          );
        }
        if (block.kind === 'thinking') {
          return (
            <details className="card agy-thinking-card" key={index}>
              <summary>
                <span className="agy-thinking-title">
                  {block.title === '' ? 'Thinking' : block.title}
                </span>
                <span className="agy-thinking-meta">{block.meta}</span>
              </summary>
            </details>
          );
        }
        if (block.kind === 'diff') {
          return <AgyDiffCard diff={block.diff} key={index} />;
        }
        if (block.kind === 'gitHistory') {
          return (
            <section className="card agy-git-history" key={index}>
              <strong>Git history</strong>
              <pre>{block.entries.join('\n')}</pre>
            </section>
          );
        }
        return (
          <div className="msg msg-assistant" key={index}>
            <div className="msg-body markdown">
              <Markdown
                components={{ pre: MarkdownPre }}
                remarkPlugins={[remarkGfm]}
              >
                {block.text}
              </Markdown>
              {streaming && last ? <span className="caret" /> : null}
            </div>
          </div>
        );
      })}
    </>
  );
}

export function AgyCliSurface({
  sessionId,
  cwd,
  sessionStatus,
  stopping,
  onInterrupt,
  onNotify,
  onStatusChange,
}: AgyCliSurfaceProps) {
  const bridge = useMemo(() => getBridge(), []);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const terminalIdRef = useRef<string | null>(null);
  const writeRawRef = useRef<(data: string) => void>(() => undefined);
  const remoteDraftRef = useRef('');
  const inputFingerprintRef = useRef('');
  const activeTurnIdRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const stopFingerprintRef = useRef('');
  const stopVerificationRef = useRef<StopVerification>('idle');
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [screen, setScreen] = useState<AgyScreenModel>(() =>
    deriveAgyScreenModel([]),
  );
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<AgyLocalTurn[]>(() => [
    ...(AGY_TURN_CACHE.get(sessionId) ?? readPersistedTurns(sessionId)),
  ]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [status, setStatus] = useState<AgyStatus>(
    () => AGY_STATUS_CACHE.get(sessionId) ?? {},
  );
  const [statusSyncPhase, setStatusSyncPhase] = useState<StatusSyncPhase>(() =>
    hasCompleteAgyStatus(AGY_STATUS_CACHE.get(sessionId) ?? {})
      ? 'done'
      : 'waiting',
  );
  const [stopVerification, setStopVerification] =
    useState<StopVerification>('idle');
  const activeSlashItemRef = useRef<HTMLButtonElement>(null);

  const updateTurns = (updater: (current: AgyLocalTurn[]) => AgyLocalTurn[]) => {
    setTurns((current) => {
      const next = updater(current);
      AGY_TURN_CACHE.set(sessionId, next);
      persistTurns(sessionId, next);
      return next;
    });
  };

  useEffect(() => {
    const terminal = new Terminal({
      cols: AGY_COLS,
      rows: AGY_ROWS,
      scrollback: 5_000,
      allowProposedApi: false,
    });
    let disposed = false;
    let writePending = false;
    let refreshAgain = false;
    let lastOutputSequence = -1;
    const earlyOutput: TerminalOutputEvent[] = [];
    const earlyClosed: TerminalClosedEvent[] = [];

    const refreshScreen = () => {
      if (writePending) {
        refreshAgain = true;
        return;
      }
      const next = deriveAgyScreenModel(readTerminalScreen(terminal));
      setScreen(next);
      setConnection('connected');
      setTurns((current) => {
        if (current.length === 0) return current;
        const latest = current.at(-1)!;
        // Terminal redraws are global to the CLI session. Only the ordinary
        // prompt that initiated the active turn may consume them; otherwise a
        // later `/model` or `/usage` repaint can overwrite a completed reply.
        if (latest.id !== activeTurnIdRef.current) return current;
        // A recovered turn's text came from AGY's store in full; the screen
        // only shows its tail and would overwrite better with worse.
        if (latest.id.startsWith('recovered-')) return current;
        if (!mayScrapeAgyReply(latest.prompt, next.rawLines, latest.assistantText)) {
          return current;
        }
        const assistantText = extractAgyAssistantText(
          next,
          latest.prompt,
          latest.assistantText,
        );
        if (
          isStaleAgyReplyCandidate(
            assistantText,
            current.slice(0, -1).map((turn) => turn.assistantText),
            next.mode === 'running',
            latest.assistantText,
          )
        ) {
          return current;
        }
        if (assistantText === latest.assistantText) return current;
        const updated = [...current.slice(0, -1), { ...latest, assistantText }];
        AGY_TURN_CACHE.set(sessionId, updated);
        persistTurns(sessionId, updated);
        return updated;
      });
    };

    const parseOutput = (event: TerminalOutputEvent) => {
      writePending = true;
      terminal.write(base64ToBytes(event.dataBase64), () => {
        writePending = false;
        refreshScreen();
        if (refreshAgain) {
          refreshAgain = false;
          refreshScreen();
        }
      });
    };

    const applyOutput = (event: TerminalOutputEvent) => {
      if (event.sequence !== undefined) {
        if (event.sequence <= lastOutputSequence) return;
        lastOutputSequence = event.sequence;
      }
      parseOutput(event);
    };

    const unsubscribeOutput = bridge.onTerminalOutput((event) => {
      const terminalId = terminalIdRef.current;
      if (terminalId === null) {
        earlyOutput.push(event);
        if (earlyOutput.length > 256) earlyOutput.shift();
      } else if (event.terminalId === terminalId) {
        applyOutput(event);
      }
    });
    const unsubscribeClosed = bridge.onTerminalClosed((event) => {
      const terminalId = terminalIdRef.current;
      if (terminalId === null) {
        earlyClosed.push(event);
        if (earlyClosed.length > 16) earlyClosed.shift();
      } else if (event.terminalId === terminalId) {
        terminalIdRef.current = null;
        setConnection('closed');
        setScreen((current) => deriveAgyScreenModel(current.rawLines, true));
      }
    });

    writeRawRef.current = (data: string) => {
      const terminalId = terminalIdRef.current;
      if (terminalId === null) return;
      bridge.writeTerminal({ terminalId, dataBase64: textToBase64(data) });
    };

    void bridge
      .openAgentTerminal({ sessionId, cols: AGY_COLS, rows: AGY_ROWS })
      .then((opened) => {
        if (disposed) {
          void bridge.closeTerminal({ terminalId: opened.terminalId });
          return;
        }
        terminalIdRef.current = opened.terminalId;
        if (opened.replayDataBase64 !== undefined) {
          applyOutput({
            terminalId: opened.terminalId,
            dataBase64: opened.replayDataBase64,
            ...(opened.replayThroughSequence === undefined
              ? {}
              : { sequence: opened.replayThroughSequence }),
          });
        }
        // Re-assert the size the parser uses. tmux sizes a pane from its
        // attached client, so this is the only thing keeping the remote screen
        // the same shape as the buffer we read.
        void bridge.resizeTerminal({
          terminalId: opened.terminalId,
          cols: AGY_COLS,
          rows: AGY_ROWS,
        });
        for (const event of earlyOutput) {
          if (event.terminalId === opened.terminalId) applyOutput(event);
        }
        earlyOutput.length = 0;
        const wasClosed = earlyClosed.some(
          (event) => event.terminalId === opened.terminalId,
        );
        earlyClosed.length = 0;
        if (wasClosed) {
          terminalIdRef.current = null;
          setConnection('closed');
          setScreen((current) => deriveAgyScreenModel(current.rawLines, true));
          return;
        }
        setConnection('connected');
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setConnection('error');
        setConnectionError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      unsubscribeOutput();
      unsubscribeClosed();
      writeRawRef.current = () => undefined;
      const terminalId = terminalIdRef.current;
      terminalIdRef.current = null;
      if (terminalId !== null) void bridge.closeTerminal({ terminalId });
      terminal.dispose();
    };
  }, [bridge, sessionId]);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (timeline !== null) timeline.scrollTop = timeline.scrollHeight;
  }, [screen.fingerprint, turns]);

  useEffect(() => {
    // A revived session's history lives in AGY's own store; local caches died
    // with the previous app run. Only an empty timeline asks, and an answer
    // arriving after the user already started typing changes nothing.
    if (turns.length > 0) return;
    let cancelled = false;
    void bridge
      .readAgyTranscript({ sessionId })
      .then(({ turns: recovered }) => {
        if (cancelled || recovered.length === 0) return;
        const seeded = recovered.map((turn, index) => ({
          id: `recovered-${index}`,
          prompt: turn.prompt,
          assistantText: turn.assistantText,
          createdAt: Date.now(),
        }));
        setTurns((current) => {
          if (current.length > 0) return current;
          AGY_TURN_CACHE.set(sessionId, seeded);
          persistTurns(sessionId, seeded);
          return seeded;
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on the session alone: this is a mount-time recovery.
  }, [bridge, sessionId]);

  useEffect(() => {
    // Cancelling can take longer than any fixed timeout — AGY finishes the tool
    // call it is inside first. So a late recovery still counts: keep watching
    // after the warning appears instead of leaving it on screen forever.
    if (
      (stopVerificationRef.current === 'requested' ||
        stopVerificationRef.current === 'unconfirmed') &&
      screen.fingerprint !== stopFingerprintRef.current &&
      screen.mode !== 'running'
    ) {
      stopVerificationRef.current = 'confirmed';
      setStopVerification('confirmed');
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [screen]);

  useEffect(() => {
    if (stopVerification === 'idle') return;
    // The warning is informational; it must not become permanent furniture.
    const timer = window.setTimeout(
      () => {
        stopVerificationRef.current = 'idle';
        setStopVerification('idle');
      },
      stopVerification === 'confirmed' ? 2400 : 12_000,
    );
    return () => window.clearTimeout(timer);
  }, [stopVerification]);

  const sendRaw = (data: string) => writeRawRef.current(data);
  const slashOptions = screen.options
    .map((option, index) => ({ option, index }))
    .filter((entry) => entry.option.command !== undefined);
  const slashAutocomplete =
    draft.trimStart().startsWith('/') && slashOptions.length > 0;
  const activeSlash = slashOptions[Math.min(slashIndex, slashOptions.length - 1)];

  useEffect(() => {
    setSlashIndex(0);
  }, [draft]);

  useEffect(() => {
    // AGY owns which row is really selected; adopt it whenever the screen
    // repaints so a scrolled window and the local highlight stay in agreement.
    const selected = screen.options
      .filter((option) => option.command !== undefined)
      .findIndex((option) => option.selected);
    if (selected >= 0) setSlashIndex(selected);
  }, [screen.fingerprint]);

  useEffect(() => {
    activeSlashItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [slashIndex]);

  useEffect(() => {
    onStatusChange(
      connection === 'closed' || sessionStatus === 'exited'
        ? 'exited'
        : connection === 'error'
          ? 'error'
          : screen.mode === 'running'
            ? 'running'
            : screen.mode === 'approval' || screen.mode === 'question'
              ? 'waiting_approval'
              : screen.mode === 'booting'
                ? 'starting'
                : screen.mode === 'error'
                  ? 'error'
                  : 'ready',
    );
  }, [screen.mode, connection, sessionStatus, onStatusChange]);

  const applyDraft = (next: string, composing: boolean) => {
    let previousRemote = remoteDraftRef.current;
    // Writes to a pseudo-console are not acknowledged. If AGY repainted since
    // the previous write, its visible input row is the best acknowledgement
    // available and can repair a dropped first byte (most noticeably `/`).
    if (
      inputFingerprintRef.current !== '' &&
      inputFingerprintRef.current !== screen.fingerprint &&
      screen.promptLineIndex >= 0
    ) {
      const observed = (screen.rawLines[screen.promptLineIndex] ?? '')
        .replace(/^\s*(?:>|❯|›|→)\s*/u, '')
        .trimEnd();
      if (next.startsWith(observed) || observed.startsWith(next)) {
        previousRemote = observed;
        remoteDraftRef.current = observed;
      }
    }
    const { remote, send } = mirrorAgyDraft(
      previousRemote,
      next,
      composing,
    );
    // Update the product UI before the CLI can redraw. This is what prevents a
    // `/` redraw from disabling the field before the next character is typed.
    remoteDraftRef.current = remote;
    setDraft(next);
    setHistoryIndex(null);
    if (send !== '') {
      inputFingerprintRef.current = screen.fingerprint;
      sendRaw(send);
    }
  };

  const replaceRemoteDraft = (next: string) => applyDraft(next, false);

  const sendPrompt = () => {
    const prompt = draft.trim();
    if (prompt === '' || connection !== 'connected') return;
    if (prompt.startsWith('/')) {
      // Slash commands control AGY's modal terminal surface. Freeze the last
      // conversational turn before the CLI repaints, and never add a temporary
      // slash turn that a later overlay effect would have to remove again.
      activeTurnIdRef.current = null;
    } else {
      const turn: AgyLocalTurn = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        prompt,
        assistantText: '',
        createdAt: Date.now(),
      };
      activeTurnIdRef.current = turn.id;
      updateTurns((current) => [...current, turn]);
    }
    remoteDraftRef.current = '';
    inputFingerprintRef.current = '';
    setDraft('');
    setHistoryIndex(null);
    sendRaw(agyKeySequence('enter'));
  };

  const chooseOption = (index: number) => {
    const option = screen.options[index];
    if (option === undefined) return;
    if (option.command !== undefined) {
      // Complete the text instead of steering AGY's own cursor. Typing the
      // rest of the command narrows its menu to that entry, so what runs is
      // what the user picked here — not whichever row the CLI happened to
      // have highlighted.
      replaceRemoteDraft(option.command);
    } else {
      sendRaw(
        agyOptionSelectionSequence(screen.selectedIndex, index, option.shortcut),
      );
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const interrupt = async () => {
    if (stopping || stopVerificationRef.current === 'requested') return;
    stopFingerprintRef.current = screen.fingerprint;
    stopVerificationRef.current = 'requested';
    setStopVerification('requested');
    try {
      await onInterrupt();
      window.setTimeout(() => {
        if (stopVerificationRef.current !== 'requested') return;
        stopVerificationRef.current = 'unconfirmed';
        setStopVerification('unconfirmed');
      }, 2500);
    } catch (error) {
      stopVerificationRef.current = 'unconfirmed';
      setStopVerification('unconfirmed');
      onNotify(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSurfaceKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLTextAreaElement) return;
    if (screen.mode === 'approval') {
      if (event.key.toLowerCase() === 'y') {
        event.preventDefault();
        sendRaw('y');
        return;
      }
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        sendRaw('n');
        return;
      }
    }
    // A question is the CLI's own control: arrows move its selection, digits
    // answer, and — with the Write-in row focused — ordinary typing lands in
    // its free-text field. Everything printable goes through unchanged, so
    // the dynamic option behaves exactly as it does in the terminal.
    if (screen.mode === 'question') {
      if (event.key === 'Backspace') {
        event.preventDefault();
        sendRaw('');
        return;
      }
      if (
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key.length === 1
      ) {
        event.preventDefault();
        sendRaw(event.key);
        return;
      }
    }
    const key = navigationKeyForEvent(event);
    if (key === null) return;
    event.preventDefault();
    sendRaw(agyKeySequence(key));
  };

  /**
   * While an overlay is open the CLI owns the selection, so navigation goes
   * straight through. Typing a printable character hands control back to the
   * composer instead of being swallowed, so the two never fight over focus.
   */
  const handleOverlayKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const navigationKey = navigationKeyForEvent(event);
    if (navigationKey !== null) {
      event.preventDefault();
      // Without this the event bubbles on to the surface handler, which sends
      // the same key a second time — every arrow press moved the CLI's
      // selection two rows.
      event.stopPropagation();
      sendRaw(agyKeySequence(navigationKey));
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.key.length === 1) {
      // Typing belongs to the overlay: a shortcut answers it, and everything
      // else is filter text for the lists that support searching.
      event.preventDefault();
      event.stopPropagation();
      sendRaw(event.key);
    }
  };

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const navigationKey = navigationKeyForEvent(event);
    // AGY's own controls: Shift+Tab cycles execution mode (default →
    // accept-edits → plan) and Ctrl+O expands tool output. Both belong to the
    // CLI, so they are passed straight through.
    if (event.shiftKey && event.key === 'Tab') {
      event.preventDefault();
      sendRaw('[Z');
      return;
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      sendRaw('');
      return;
    }
    // The suggestion list is navigated locally. Round-tripping every arrow key
    // to the remote CLI and waiting for it to repaint made the menu feel dead
    // over SSH; the highlight has to answer the keypress immediately.
    if (slashAutocomplete && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      setSlashIndex((index) =>
        nextSuggestionIndex(
          index,
          slashOptions.length,
          event.key === 'ArrowDown' ? 'down' : 'up',
        ),
      );
      // Forwarded as well, so pressing past the last visible row scrolls AGY's
      // own window and brings the rest of the commands into reach. The local
      // move is only a prediction; the redraw below corrects it.
      sendRaw(agyKeySequence(event.key === 'ArrowDown' ? 'down' : 'up'));
      return;
    }
    if (slashAutocomplete && event.key === 'Tab') {
      event.preventDefault();
      if (activeSlash !== undefined) chooseOption(activeSlash.index);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      // Enter completes the highlighted command first, then sends it — the
      // same two-step the CLI itself uses, so nothing runs by surprise.
      if (
        slashAutocomplete &&
        activeSlash !== undefined &&
        draft.trim() !== activeSlash.option.command
      ) {
        chooseOption(activeSlash.index);
        return;
      }
      sendPrompt();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (slashAutocomplete) sendRaw(agyKeySequence('escape'));
      replaceRemoteDraft('');
      return;
    }
    if (
      navigationKey !== null &&
      ['left', 'right', 'home', 'end'].includes(navigationKey)
    ) {
      sendRaw(agyKeySequence(navigationKey));
      return;
    }
    // A panel (approval, model picker) is drawn and owned by the CLI, so its
    // selection can only move there.
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      (draft !== '' ||
        screen.mode === 'approval' ||
        screen.mode === 'menu' ||
        screen.mode === 'viewer')
    ) {
      event.preventDefault();
      sendRaw(agyKeySequence(event.key === 'ArrowUp' ? 'up' : 'down'));
      return;
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && draft === '') {
      const prompts = turns.map((turn) => turn.prompt);
      if (prompts.length === 0) return;
      event.preventDefault();
      const nextIndex =
        event.key === 'ArrowUp'
          ? historyIndex === null
            ? prompts.length - 1
            : Math.max(0, historyIndex - 1)
          : historyIndex === null || historyIndex + 1 >= prompts.length
            ? null
            : historyIndex + 1;
      replaceRemoteDraft(nextIndex === null ? '' : prompts[nextIndex]!);
      setHistoryIndex(nextIndex);
    }
  };

  const canCompose =
    isAgyComposerEditable(connection, sessionStatus, screen.mode, draft) &&
    (statusSyncPhase === 'done' || statusSyncPhase === 'failed');
  const overlay = useMemo(
    () => recogniseAgyScreen(screen.rawLines),
    [screen.fingerprint],
  );

  useEffect(() => {
    // Merge rather than replace: model and effort ride on every screen, but
    // context and quota only appear on the screens that report them, and
    // losing them again the moment that screen closes would make the header
    // flicker between known and unknown.
    const next = readAgyStatus(screen.rawLines);
    setStatus((current) => {
      const merged = { ...current, ...next };
      if (JSON.stringify(merged) === JSON.stringify(current)) return current;
      AGY_STATUS_CACHE.set(sessionId, merged);
      return merged;
    });
  }, [screen.fingerprint, sessionId]);

  useEffect(() => {
    if (statusSyncPhase === 'done' || statusSyncPhase === 'failed') return;

    if (
      statusSyncPhase === 'waiting' &&
      connection === 'connected' &&
      screen.mode === 'prompt' &&
      draft === ''
    ) {
      setStatusSyncPhase('context');
      // Keep startup commands as ordinary keystrokes. The Windows pseudo-
      // console can receive the first frame before AGY enables bracketed
      // paste, in which case the wrapper bytes become literal input.
      sendRaw(agyPromptSequence('/context', false));
      return;
    }
    if (statusSyncPhase === 'context' && overlay?.kind === 'contextReport') {
      setStatusSyncPhase('contextClosing');
      sendRaw(agyKeySequence('escape'));
      return;
    }
    if (
      statusSyncPhase === 'contextClosing' &&
      overlay === null &&
      screen.mode === 'prompt'
    ) {
      setStatusSyncPhase('usage');
      sendRaw(agyPromptSequence('/usage', false));
      return;
    }
    if (statusSyncPhase === 'usage' && overlay?.kind === 'quotaReport') {
      setStatusSyncPhase('usageClosing');
      sendRaw(agyKeySequence('escape'));
      return;
    }
    if (
      statusSyncPhase === 'usageClosing' &&
      overlay === null &&
      screen.mode === 'prompt'
    ) {
      setStatusSyncPhase('settling');
    }
  }, [connection, draft, overlay, screen.fingerprint, screen.mode, statusSyncPhase]);

  useEffect(() => {
    if (statusSyncPhase !== 'settling') return;
    // The first printable byte in the same paint as a viewer's Escape can be
    // consumed by AGY's closing key handler. Keep the composer locked for one
    // short settle window so an eager first `/` is not silently dropped.
    const timer = window.setTimeout(() => setStatusSyncPhase('done'), 180);
    return () => window.clearTimeout(timer);
  }, [statusSyncPhase]);

  useEffect(() => {
    if (statusSyncPhase === 'done' || statusSyncPhase === 'failed') return;
    const timer = window.setTimeout(() => setStatusSyncPhase('failed'), 12_000);
    return () => window.clearTimeout(timer);
  }, [statusSyncPhase]);

  useEffect(() => {
    // Keyboard control must not depend on clicking first. While an overlay is
    // up the composer is disabled, so nothing would hold focus and the arrow
    // keys would go nowhere; hand focus to the overlay and give it back when
    // the overlay closes.
    const target = overlay === null ? textareaRef.current : overlayRef.current;
    if (target === null) return;
    const frame = requestAnimationFrame(() => target.focus());
    return () => cancelAnimationFrame(frame);
  }, [overlay?.kind ?? null]);

  useEffect(() => {
    // Same rule for the question and approval cards: the composer is disabled
    // while they are up, so the surface itself takes focus — arrow keys and
    // typing reach the CLI immediately, with no click to refocus first.
    if (overlay !== null) return;
    if (screen.mode !== 'question' && screen.mode !== 'approval') return;
    const frame = requestAnimationFrame(() => surfaceRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [screen.mode, overlay?.kind ?? null]);

  /** Move AGY's own cursor to a row, then let the caller confirm separately. */
  const focusOverlayRow = (target: number) => {
    const current =
      overlay === null
        ? -1
        : overlay.kind === 'modelPicker'
          ? overlay.models.findIndex((model) => model.focused)
          : overlay.kind === 'sessionPicker'
            ? overlay.rows.findIndex((row) => row.focused)
            : overlay.kind === 'permissionScopes'
              ? overlay.scopes.findIndex((scope) => scope.focused)
              : overlay.kind === 'agentPicker'
                ? overlay.agents.findIndex((agent) => agent.focused)
                : -1;
    const from = current < 0 ? 0 : current;
    const step = target > from ? 'down' : 'up';
    sendRaw(agyKeySequence(step).repeat(Math.abs(target - from)));
  };

  const adjustOverlay = (delta: number) => {
    if (delta === 0) return;
    const step = delta > 0 ? 'right' : 'left';
    sendRaw(agyKeySequence(step).repeat(Math.abs(delta)));
  };

  const closeOverlay = () => {
    sendRaw(agyKeySequence('escape'));
  };

  // An open overlay renders the same rows with real controls, so the welcome
  // screen underneath would show every choice twice.
  const showWelcome =
    turns.length === 0 &&
    !slashAutocomplete &&
    overlay === null &&
    (screen.mode === 'booting' ||
      screen.mode === 'welcome' ||
      screen.mode === 'prompt' ||
      screen.mode === 'running');
  // A card answered by typed keys (`1. Yes`, `[y] Allow once`) is shown on its
  // own merit, so keeping the composer usable never costs the user the buttons.
  const hasKeyedChoices = screen.options.some(
    (option) => option.shortcut !== undefined,
  );
  // A recognised overlay always wins: it renders the same screen with real
  // controls, so the generic fallback panel would only duplicate it.
  const showPanel =
    overlay === null &&
    draft === '' &&
    !showWelcome &&
    (hasKeyedChoices ||
      screen.mode === 'approval' ||
      screen.mode === 'question' ||
      screen.mode === 'menu' ||
      screen.mode === 'viewer');
  const copy = panelCopy(screen);
  const running = screen.mode === 'running';

  return (
    <div
      ref={surfaceRef}
      className="agy-chat-surface"
      data-testid="agy-surface"
      data-mode={screen.mode}
      data-status-sync={statusSyncPhase}
      tabIndex={0}
      onKeyDown={handleSurfaceKeyDown}
    >
      <div className="agy-statusline" data-testid="agy-statusline">
        <div className="agy-statusline-primary">
          <span
            className={`agy-statusline-presence${running ? ' agy-statusline-presence-running' : ''}`}
            aria-hidden="true"
          />
          <span className="agy-statusline-model">{status.model ?? 'AGY'}</span>
          {status.effort === undefined ? null : (
            <span className="agy-statusline-effort">{status.effort}</span>
          )}
        </div>
        <div className="agy-statusline-metrics">
        {status.contextUsedPercent === undefined ? null : (
          <span className="agy-statusline-metric" title={status.contextSummary}>
            <small>Context</small>
            <strong>{status.contextUsedPercent}%</strong>
          </span>
        )}
        {(status.limits ?? []).map((limit) => (
          <span className="agy-statusline-metric" key={limit.label} title={limit.note}>
            <small>{limit.label.replace(/\s*limit$/iu, '')}</small>
            <strong>{limit.remainingPercent}%</strong>
          </span>
        ))}
        {statusSyncPhase !== 'done' && statusSyncPhase !== 'failed' ? (
          <span className="agy-statusline-hint agy-statusline-syncing">
            <span aria-hidden="true" />
            Syncing usage…
          </span>
        ) : status.contextUsedPercent === undefined && status.limits === undefined ? (
          <span className="agy-statusline-hint">Usage unavailable</span>
        ) : null}
        </div>
      </div>
      <div className="chat-timeline agy-chat-timeline" ref={timelineRef}>
        {connectionError !== null ? (
          <div className="agy-chat-error" role="alert">
            <strong>Could not connect to AGY</strong>
            <span>{connectionError}</span>
          </div>
        ) : null}

        {showWelcome ? (
          <section
            className="agy-chat-welcome"
            data-testid="agy-welcome"
            aria-label="AGY start screen"
          >
            <div className="agy-chat-mark" aria-hidden="true">A</div>
            <h2>{screen.mode === 'booting' ? 'Starting AGY…' : 'Start with AGY'}</h2>
            <p>
              {screen.mode === 'booting'
                ? 'Connecting to the interactive CLI.'
                : screen.promptHint === 'Message AGY'
                  ? 'Choose how to begin, or type a task below.'
                  : screen.promptHint}
            </p>
            <span className="agy-chat-cwd mono">{cwd}</span>
            {screen.options.length > 0 ? (
              <div className="agy-chat-start-options" role="listbox">
                {screen.options.map((option, index) => (
                  <button
                    type="button"
                    data-testid="agy-start-option"
                    role="option"
                    aria-selected={option.selected}
                    className={option.selected ? 'agy-chat-option-selected' : ''}
                    key={`${option.lineIndex}-${option.label}`}
                    onClick={() => chooseOption(index)}
                  >
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {turns.map((turn, index) => {
          const current = index === turns.length - 1;
          const interactiveTurn =
            current && (screen.mode === 'approval' || screen.mode === 'question');
          const visibleAssistantText =
            interactiveTurn ||
            isStaleAgyReplyCandidate(
              turn.assistantText,
              turns.slice(0, index).map((earlier) => earlier.assistantText),
              current && running,
            )
              ? ''
              : turn.assistantText;
          return (
            <div className="agy-chat-turn" key={turn.id}>
              {turn.prompt === '' ? null : (
                <div className="msg msg-user">
                  <div className="msg-body">{turn.prompt}</div>
                </div>
              )}
              {visibleAssistantText !== '' ? (
                <AgyReply
                  text={visibleAssistantText}
                  streaming={current && running}
                  onToggleToolDetails={() => sendRaw('\u000f')}
                />
              ) : current && running ? (
                <div className="agy-chat-working" role="status">
                  <span className="agy-chat-spinner" aria-hidden="true" />
                  <span>AGY is working…</span>
                </div>
              ) : null}
            </div>
          );
        })}

        {overlay !== null && draft === '' ? (
          <div
            ref={overlayRef}
            tabIndex={-1}
            className="agy-overlay-focus"
            onKeyDown={handleOverlayKeyDown}
          >
            <AgyOverlay
              screen={overlay}
              onFocus={focusOverlayRow}
              onAdjust={adjustOverlay}
              onConfirm={() => sendRaw(agyKeySequence('enter'))}
              onCancel={closeOverlay}
            />
          </div>
        ) : null}

        {showPanel ? (
          <section
            className={`agy-chat-panel${screen.mode === 'approval' ? ' agy-chat-approval' : ''}`}
            data-testid="agy-panel"
            aria-label={
              screen.mode === 'approval'
                ? 'AGY approval'
                : screen.mode === 'question'
                  ? 'AGY question'
                  : 'AGY interactive panel'
            }
          >
            <div className="agy-chat-panel-head">
              <span className="agy-chat-panel-icon" aria-hidden="true">
                {screen.mode === 'approval' ? '!' : screen.mode === 'question' ? '?' : 'A'}
              </span>
              <div>
                <strong>{screen.title}</strong>
                {copy[0] !== undefined ? <span>{copy[0]}</span> : null}
              </div>
            </div>
            {screen.approvalCommand !== undefined ? (
              <code>{screen.approvalCommand}</code>
            ) : null}
            {screen.options.length > 0 ? (
              <div className="agy-chat-panel-options" role="listbox">
                {screen.options.map((option, index) => (
                  <button
                    type="button"
                    data-testid="agy-panel-option"
                    role="option"
                    aria-selected={option.selected}
                    className={option.selected ? 'agy-chat-option-selected' : ''}
                    key={`${option.lineIndex}-${option.label}`}
                    onClick={() => chooseOption(index)}
                  >
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            ) : screen.mode === 'approval' ? (
              <div className="agy-chat-panel-actions">
                <button className="btn-allow" onClick={() => sendRaw('y')}>Allow once</button>
                <button className="btn-deny" onClick={() => sendRaw('n')}>Deny</button>
              </div>
            ) : (
              <div className="agy-chat-panel-actions">
                <button onClick={() => sendRaw(agyKeySequence('enter'))}>Continue</button>
                <button className="ghost" onClick={() => sendRaw(agyKeySequence('escape'))}>
                  Back
                </button>
              </div>
            )}
          </section>
        ) : null}

        {screen.mode === 'error' ? (
          <div className="agy-chat-error" role="alert">
            <strong>{screen.title}</strong>
            <span>{copy.join('\n') || 'AGY reported an error in the CLI session.'}</span>
          </div>
        ) : null}
      </div>

      {stopVerification !== 'idle' ? (
        <div className={`agy-stop-verification agy-stop-${stopVerification}`} role="status">
          {stopVerification === 'requested'
            ? '已送出取消，等待 AGY 交還控制權…'
            : stopVerification === 'confirmed'
              ? 'AGY 已停止，可以繼續輸入。'
              : '已送出取消（Esc），AGY 還沒有回到輸入狀態。'}
        </div>
      ) : null}

      {/*
        While an overlay is up the CLI is modal — it shows no prompt of its
        own, and anything typed goes to the overlay. Leaving a composer on
        screen invites the user to write a message that has nowhere to go.
      */}
      <div className="composer-wrap agy-composer-wrap" hidden={overlay !== null}>
        {slashAutocomplete ? (
          <div className="slash-menu agy-slash-menu" role="listbox" aria-label="AGY slash commands">
            <div className="slash-menu-title">
              <span>AGY commands</span>
              <span>{slashOptions.length}</span>
            </div>
            <div className="slash-menu-items">
              {slashOptions.map(({ option, index }, optionIndex) => {
                const active = optionIndex === Math.min(slashIndex, slashOptions.length - 1);
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    ref={active ? activeSlashItemRef : undefined}
                    className={`slash-item${active ? ' slash-item-active' : ''}`}
                    key={`${option.lineIndex}-${option.command}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setSlashIndex(optionIndex)}
                    onClick={() => chooseOption(index)}
                  >
                    <span className="slash-terminal">/</span>
                    <span className="slash-name">{option.command}</span>
                    <span className="slash-desc">
                      {option.label.slice(option.command?.length ?? 0).trim()}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="slash-hint hint">
              ↑↓ 選擇 · Tab/Enter 帶入 · 完整指令再按 Enter 執行 · Esc 關閉
            </div>
          </div>
        ) : null}
        <div className="composer agy-composer">
          <textarea
            ref={textareaRef}
            data-testid="agy-composer-input"
            value={draft}
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            disabled={!canCompose}
            placeholder={
              running
                ? 'AGY is working…'
                : screen.mode === 'closed'
                  ? 'AGY session closed'
                  : screen.promptHint || 'Message AGY'
            }
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              replaceRemoteDraft(event.currentTarget.value);
            }}
            onChange={(event) =>
              applyDraft(event.currentTarget.value, composingRef.current)
            }
            onKeyDown={handleComposerKeyDown}
          />
          <div className="composer-actions">
            {running || stopVerification === 'requested' || stopVerification === 'unconfirmed' ? (
              <button
                type="button"
                className="composer-stop"
                data-testid="agy-stop"
                disabled={stopping || stopVerification === 'requested'}
                onClick={() => void interrupt()}
              >
                <span className="composer-stop-icon" aria-hidden="true" />
                {stopping || stopVerification === 'requested' ? 'Stopping…' : 'Stop'}
              </button>
            ) : null}
            <button
              type="button"
              className="composer-send"
              data-testid="agy-send"
              disabled={!canCompose || draft.trim() === ''}
              onClick={sendPrompt}
            >
              Send
            </button>
          </div>
        </div>
        <div className="agy-composer-hint">Enter to send · Shift+Enter for a new line</div>
      </div>
    </div>
  );
}
