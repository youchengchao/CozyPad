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
  ChatAttachmentSchema,
  MAX_AGENT_ATTACHMENTS,
  base64ToBytes,
  textToBase64,
  type ChatAttachment,
  type AgentSessionStatus,
  type TerminalClosedEvent,
  type TerminalOutputEvent,
} from '@cozypad/contracts';
import { getBridge } from '../../platform/bridge';
import {
  agyKeySequence,
  agyOptionSelectionSequence,
  agyPromptSequence,
  agyReconciledPromptSequence,
  agySurfaceSessionStatus,
  deriveAgyScreenModel,
  extractAgyAssistantText,
  extractAgyPromptDraft,
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
  ATTACHMENT_STATE_LABEL,
  caretIsOnHistoryEdge,
  navigatePromptHistory,
} from './ChatComposer';
import {
  attachmentFileToBase64,
  bufferAttachmentFiles,
  clipboardAttachmentFiles,
  createAgyMediaUploadArchive,
  formatAttachmentSize,
  promptWithAttachmentReferences,
  type ComposerAttachment,
} from './attachmentBuffer';
import {
  isInlineAttachmentImage,
  MessageAttachments,
} from './MessageAttachments';
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

interface AgyTranscriptPreviewProps {
  sessionId: string;
  cwd: string;
}

interface AgyLocalTurn {
  id: string;
  prompt: string;
  assistantText: string;
  createdAt: number;
  /** Exact prompt echoed by AGY; may include hidden @attachment instructions. */
  submittedPrompt?: string;
  /** Files delivered with this turn, retained for transcript rendering. */
  attachments?: ChatAttachment[];
}

interface PendingAgyMediaUpload {
  archiveBase64: string;
  requested: boolean;
  resolveRequested(requested: boolean): void;
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
/**
 * The surface unmounts on every session switch, so reading position and
 * buffered attachments must outlive the component to survive one (SPEC 300,
 * 3050, 3059). They are runtime state, not history: they die with the app run
 * and are dropped when the session is deleted.
 */
const AGY_SCROLL_CACHE = new Map<string, number>();
const AGY_ATTACHMENT_CACHE = new Map<string, ComposerAttachment[]>();

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
        typeof (turn as AgyLocalTurn).createdAt === 'number' &&
        ((turn as AgyLocalTurn).submittedPrompt === undefined ||
          typeof (turn as AgyLocalTurn).submittedPrompt === 'string') &&
        ((turn as AgyLocalTurn).attachments === undefined ||
          (Array.isArray((turn as AgyLocalTurn).attachments) &&
            (turn as AgyLocalTurn).attachments!.every(
              (attachment) => ChatAttachmentSchema.safeParse(attachment).success,
            ))),
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
  AGY_SCROLL_CACHE.delete(sessionId);
  // Attachments buffered for this session hold object URLs; this is the one
  // place they are released now that they outlive the surface.
  AGY_ATTACHMENT_CACHE.get(sessionId)?.forEach((attachment) => {
    if (attachment.previewUrl !== undefined) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  });
  AGY_ATTACHMENT_CACHE.delete(sessionId);
  try {
    window.localStorage.removeItem(turnStorageKey(sessionId));
  } catch {
    // Nothing to clean if storage is unavailable.
  }
}

/**
 * A relaunch gets a new terminal/screen, but its conversation history still
 * belongs to the same CozyPad session. Keep the turns available for the
 * selected-session preview while dropping runtime-only status.
 */
export function clearAgyRuntimeCache(sessionId: string): void {
  AGY_STATUS_CACHE.delete(sessionId);
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
    .filter((line, index) => index > model.promptLineIndex && !optionLines.has(index))
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== '' &&
        !/^agy(?:\s+v?[\d.]+|\s+native|$)/iu.test(line) &&
        !/(?:↑|↓|←|→|arrow|enter\s+select|tab\s+to|ctrl\+|esc\s+to)/iu.test(line),
    )
    .slice(-5);
}

/** SPEC 1362-1364: a disabled composer names its reason and the next step. */
function agyComposerUnavailableHint(
  connection: ConnectionState,
  sessionStatus: AgentSessionStatus,
  mode: AgyScreenModel['mode'],
  statusSyncPhase: StatusSyncPhase,
): string {
  if (connection === 'connecting') return '正在連線到 AGY…';
  if (connection === 'closed' || sessionStatus === 'exited') {
    return 'AGY session 已結束——按 Resume 重新啟動';
  }
  if (connection === 'error') return '連線發生錯誤——按 Resume 重試';
  if (mode === 'running') return 'AGY 正在執行——等待完成或按 Stop 中止';
  if (mode === 'approval' || mode === 'question') {
    return 'AGY 正在等待你的回覆——在上方卡片作答';
  }
  if (mode === 'menu' || mode === 'viewer') {
    return 'AGY 顯示選單中——以上方選項操作，或按 Esc 返回';
  }
  if (statusSyncPhase !== 'done' && statusSyncPhase !== 'failed') {
    return '正在同步用量資訊，完成後即可輸入';
  }
  return '目前無法輸入';
}

function DiffLines({ diff }: { diff: string }) {
  // Kept line-for-line identical to ChatTimeline's DiffBody: every agent's
  // diff must render the same way (SPEC 1055), and the Claude path cannot be
  // re-verified on this machine, so AGY aligns to it rather than the reverse.
  return (
    <pre className="diff-body">
      {diff.split('\n').map((line, index) => {
        const className = line.startsWith('+')
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
  showNativeToolControl = true,
}: {
  text: string;
  streaming: boolean;
  onToggleToolDetails(): void;
  showNativeToolControl?: boolean;
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
              {/* The summary row already shows a single-line detail in full;
                  repeating it as output printed the same text twice. */}
              {block.detail.includes('\n') ? (
                <pre className="tool-output">{block.detail}</pre>
              ) : null}
              {showNativeToolControl ? (
                <button
                  type="button"
                  className="agy-tool-native-view"
                  data-testid="agy-tool-native-view"
                  onClick={onToggleToolDetails}
                >
                  View in AGY
                </button>
              ) : null}
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

/**
 * Read-only AGY history for a selected session. This intentionally never
 * opens a terminal: selecting an exited session may inspect its conversation
 * without reviving the process or changing the session status.
 */
export function AgyTranscriptPreview({
  sessionId,
  cwd,
}: AgyTranscriptPreviewProps) {
  const bridge = useMemo(() => getBridge(), []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollPlacedRef = useRef(false);
  const [turns, setTurns] = useState<AgyLocalTurn[]>(() => [
    ...(AGY_TURN_CACHE.get(sessionId) ?? readPersistedTurns(sessionId)),
  ]);

  useEffect(() => {
    // Open at the session's saved position, or the newest entry — the same
    // rule as every other timeline (SPEC 3050). Turns may arrive
    // asynchronously, so the first non-empty render is the one to place.
    const el = scrollRef.current;
    if (el === null || scrollPlacedRef.current || turns.length === 0) return;
    scrollPlacedRef.current = true;
    el.scrollTop = AGY_SCROLL_CACHE.get(sessionId) ?? el.scrollHeight;
  }, [sessionId, turns.length]);

  useEffect(() => {
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
          createdAt: Date.now() + index,
        }));
        AGY_TURN_CACHE.set(sessionId, seeded);
        persistTurns(sessionId, seeded);
        setTurns(seeded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge, sessionId, turns.length]);

  return (
    <div
      className="chat-timeline agy-chat-timeline agy-transcript-preview"
      data-testid="agy-transcript-preview"
      ref={scrollRef}
      onScroll={(event) =>
        AGY_SCROLL_CACHE.set(sessionId, event.currentTarget.scrollTop)
      }
    >
      {turns.length === 0 ? (
        <section className="agy-chat-welcome" aria-label="AGY conversation preview">
          <div className="agy-chat-mark" aria-hidden="true">A</div>
          <h2>尚無已保存的對話內容</h2>
          <p>這裡只顯示歷史內容；按 Resume 才會連回 AGY。</p>
          <span className="agy-chat-cwd mono">{cwd}</span>
        </section>
      ) : (
        turns.map((turn, index) => {
          const visibleAssistantText = isStaleAgyReplyCandidate(
            turn.assistantText,
            turns.slice(0, index).map((earlier) => earlier.assistantText),
            false,
          )
            ? ''
            : turn.assistantText;
          return (
            <div className="agy-chat-turn" key={turn.id}>
              {turn.prompt === '' && (turn.attachments?.length ?? 0) === 0 ? null : (
                <div className="msg msg-user">
                  <div
                    className={`msg-body${(turn.attachments?.length ?? 0) > 0 ? ' msg-body-with-attachments' : ''}`}
                  >
                    {turn.prompt === '' ? null : turn.prompt}
                    <MessageAttachments attachments={turn.attachments ?? []} />
                  </div>
                </div>
              )}
              {visibleAssistantText === '' ? null : (
                <AgyReply
                  text={visibleAssistantText}
                  streaming={false}
                  onToggleToolDetails={() => undefined}
                  showNativeToolControl={false}
                />
              )}
            </div>
          );
        })
      )}
    </div>
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
  const scrollRestoredRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const terminalIdRef = useRef<string | null>(null);
  const writeRawRef = useRef<(data: string) => void>(() => undefined);
  const remoteDraftRef = useRef('');
  const inputFingerprintRef = useRef('');
  const draftTouchedRef = useRef(false);
  const activeTurnIdRef = useRef<string | null>(null);
  const composingRef = useRef(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const stopFingerprintRef = useRef('');
  const stopVerificationRef = useRef<StopVerification>('idle');
  const attachmentUploadRef = useRef(false);
  const pendingMediaUploadRef = useRef<PendingAgyMediaUpload | null>(null);
  /** Upload bytes by remote id, kept for a retry paste (SPEC 315). */
  const encodedBytesRef = useRef(new Map<string, string>());
  /** Media already pasted into AGY; a retry must not paste them twice. */
  const pastedMediaIdsRef = useRef(new Set<string>());
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
  const historyDraftRef = useRef('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(
    () => AGY_ATTACHMENT_CACHE.get(sessionId) ?? [],
  );
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
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
    attachmentsRef.current = attachments;
    // Buffered files survive leaving the session (SPEC 300/3059) — switching
    // away unmounts this surface, and dropping the tray here lost them
    // silently. clearAgySessionCache revokes their object URLs on delete.
    AGY_ATTACHMENT_CACHE.set(sessionId, attachments);
  }, [attachments, sessionId]);

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
    let uploadControlTail = '';
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
      if (!draftTouchedRef.current) {
        const recoveredDraft = extractAgyPromptDraft(next);
        if (recoveredDraft !== '') {
          remoteDraftRef.current = recoveredDraft;
          setDraft((current) => (current === '' ? recoveredDraft : current));
        }
      }
      setTurns((current) => {
        if (current.length === 0) return current;
        // An approval or question frame is the CLI's own control, not reply
        // text. Freeze the transcript for its duration: the answer streamed
        // so far stays visible next to the card instead of being replaced by
        // scraped panel furniture (SPEC 2608).
        if (next.mode === 'approval' || next.mode === 'question') return current;
        const latest = current.at(-1)!;
        // Terminal redraws are global to the CLI session. Only the ordinary
        // prompt that initiated the active turn may consume them; otherwise a
        // later `/model` or `/usage` repaint can overwrite a completed reply.
        if (latest.id !== activeTurnIdRef.current) return current;
        // A recovered turn's text came from AGY's store in full; the screen
        // only shows its tail and would overwrite better with worse.
        if (latest.id.startsWith('recovered-')) return current;
        const submittedPrompt = latest.submittedPrompt ?? latest.prompt;
        if (!mayScrapeAgyReply(submittedPrompt, next.rawLines, latest.assistantText)) {
          return current;
        }
        const assistantText = extractAgyAssistantText(
          next,
          submittedPrompt,
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
      const bytes = base64ToBytes(event.dataBase64);
      uploadControlTail = `${uploadControlTail}${new TextDecoder().decode(bytes)}`.slice(
        -512,
      );
      const pendingUpload = pendingMediaUploadRef.current;
      if (
        pendingUpload !== null &&
        !pendingUpload.requested &&
        uploadControlTail.includes('RequestUpload=format=tgz')
      ) {
        pendingUpload.requested = true;
        writeRawRef.current(`ok\n${pendingUpload.archiveBase64}\n`);
        pendingUpload.resolveRequested(true);
        uploadControlTail = '';
      }
      writePending = true;
      terminal.write(bytes, () => {
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
      pendingMediaUploadRef.current?.resolveRequested(false);
      pendingMediaUploadRef.current = null;
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
    // Restore the session's reading position once, then auto-follow only
    // while the user is already near the bottom (SPEC 1329-1331). The screen
    // fingerprint changes on every spinner frame, so an unconditional scroll
    // here pulled the user back down several times a second.
    const timeline = timelineRef.current;
    if (timeline === null) return;
    if (!scrollRestoredRef.current) {
      scrollRestoredRef.current = true;
      timeline.scrollTop =
        AGY_SCROLL_CACHE.get(sessionId) ?? timeline.scrollHeight;
      return;
    }
    const nearBottom =
      timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 160;
    if (nearBottom) timeline.scrollTop = timeline.scrollHeight;
  }, [screen.fingerprint, turns, sessionId]);

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
    draft.trimStart().startsWith('/') && slashOptions.length > 0 && !slashDismissed;
  const activeSlash = slashOptions[Math.min(slashIndex, slashOptions.length - 1)];

  useEffect(() => {
    setSlashIndex(0);
    // A dismissal lasts for the current command only, as in ChatComposer.
    if (!draft.trimStart().startsWith('/')) setSlashDismissed(false);
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
      agySurfaceSessionStatus(connection, sessionStatus, screen.mode),
    );
  }, [screen.mode, connection, sessionStatus, onStatusChange]);

  const applyDraft = (next: string, composing: boolean) => {
    draftTouchedRef.current = true;
    let previousRemote = remoteDraftRef.current;
    // Writes to a pseudo-console are not acknowledged. If AGY repainted since
    // the previous write, its visible input row is the best acknowledgement
    // available and can repair a dropped first byte (most noticeably `/`).
    if (
      inputFingerprintRef.current !== '' &&
      inputFingerprintRef.current !== screen.fingerprint &&
      screen.promptLineIndex >= 0
    ) {
      let observed = (screen.rawLines[screen.promptLineIndex] ?? '')
        .replace(/^\s*(?:>|❯|›|→)\s*/u, '')
        .trimEnd();
      // Terminal rows are space-padded to the right edge. `trimEnd()` removes
      // that padding, but it also destroys any trailing spaces the user actually
      // typed. If `observed` matches what we sent minus the spaces, trust the
      // spaces we sent are still there so we can actually send Backspaces to delete them.
      if (remoteDraftRef.current.trimEnd() === observed) {
        observed = remoteDraftRef.current;
      }
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

  const attachFiles = (files: File[]) => {
    if (files.length === 0 || uploadingAttachments) return;
    const buffered = bufferAttachmentFiles(files, attachments.length);
    if (buffered.attachments.length > 0) {
      setAttachments((current) => [...current, ...buffered.attachments]);
    }
    const rejected = [
      buffered.oversizedCount > 0
        ? `${buffered.oversizedCount} attachment(s) exceeded the 20 MB limit`
        : '',
      buffered.limitCount > 0
        ? `${buffered.limitCount} attachment(s) exceeded the ${MAX_AGENT_ATTACHMENTS}-file limit`
        : '',
    ].filter(Boolean);
    if (rejected.length > 0) {
      onNotify(`${rejected.join('; ')}. The remaining files are buffered locally.`);
    }
  };

  const removeAttachment = (attachmentId: string) => {
    encodedBytesRef.current.delete(attachmentId);
    pastedMediaIdsRef.current.delete(attachmentId);
    setAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === attachmentId);
      if (removed?.previewUrl !== undefined) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((attachment) => attachment.id !== attachmentId);
    });
  };

  const retryAttachment = async (attachmentId: string) => {
    const target = attachments.find((a) => a.id === attachmentId);
    if (!target) return;
    setAttachments((current) =>
      current.map((a) =>
        a.id === attachmentId ? { ...a, state: 'packaging' as const } : a
      )
    );
    try {
      let remote = target;
      if (target.file !== undefined) {
        const dataBase64 = await attachmentFileToBase64(target.file);
        setAttachments((current) =>
          current.map((a) =>
            a.id === attachmentId ? { ...a, state: 'transferring' as const } : a
          )
        );
        const uploaded = await bridge.uploadAgentAttachments({
          sessionId,
          attachments: [
            { name: target.name, mediaType: target.mediaType, dataBase64 }
          ]
        });
        const firstUploaded = uploaded[0];
        if (!firstUploaded) throw new Error('Upload returned no result');
        encodedBytesRef.current.set(firstUploaded.id, dataBase64);
        remote = {
          id: firstUploaded.id,
          name: firstUploaded.name,
          mediaType: firstUploaded.mediaType,
          sizeBytes: firstUploaded.sizeBytes,
          state: 'ready' as const,
          remotePath: firstUploaded.remotePath,
          ...(target.previewUrl === undefined ? {} : { previewUrl: target.previewUrl }),
        };
        setAttachments((current) =>
          current.map((a) => (a.id === attachmentId ? remote : a))
        );
      }
      if (isInlineAttachmentImage(remote.mediaType) && !pastedMediaIdsRef.current.has(remote.id)) {
        setAttachments((current) =>
          current.map((a) =>
            a.id === remote.id ? { ...a, state: 'verifying' as const } : a
          )
        );
        await pasteNativeAgyMedia([remote], encodedBytesRef.current);
        setAttachments((current) =>
          current.map((a) =>
            a.id === remote.id ? { ...a, state: 'ready' as const } : a
          )
        );
      }
    } catch (error) {
      setAttachments((current) =>
        current.map((a) =>
          a.id === attachmentId
            ? { ...a, state: 'error' as const, errorMessage: error instanceof Error ? error.message : String(error) }
            : a
        )
      );
      onNotify(error instanceof Error ? error.message : String(error));
    }
  };


  const pasteNativeAgyMedia = async (
    mediaAttachments: ComposerAttachment[],
    encodedByAttachmentId: Map<string, string>,
  ): Promise<void> => {
    if (mediaAttachments.length === 0) return;
    const archiveBase64 = await createAgyMediaUploadArchive(
      // A retry batch no longer holds Files; the cached upload bytes fill in.
      mediaAttachments.map((attachment) => ({
        mediaType: attachment.mediaType,
        file: attachment.file,
        dataBase64: encodedByAttachmentId.get(attachment.id),
      })),
    );
    let resolveRequested!: (requested: boolean) => void;
    const requested = new Promise<boolean>((resolve) => {
      resolveRequested = resolve;
    });
    pendingMediaUploadRef.current = {
      archiveBase64,
      requested: false,
      resolveRequested,
    };

    try {
      const first = mediaAttachments[0]!;
      const firstDataBase64 = encodedByAttachmentId.get(first.id);
      if (firstDataBase64 === undefined) {
        throw new Error(`Missing buffered image bytes for ${first.name}`);
      }
      if (bridge.writeClipboardImage !== undefined) {
        await bridge.writeClipboardImage({
          name: first.name,
          mediaType: first.mediaType,
          dataBase64: firstDataBase64,
        });
      }
      sendRaw('\u0016');
      const remoteUpload = await Promise.race([
        requested,
        new Promise<boolean>((resolve) =>
          window.setTimeout(() => resolve(false), 700),
        ),
      ]);

      if (!remoteUpload) {
        if (bridge.writeClipboardImage === undefined) {
          throw new Error('This AGY host did not accept the terminal media upload');
        }
        // Track each image as it lands so a retry after a mid-loop failure
        // pastes only the remainder instead of duplicating the first ones.
        pastedMediaIdsRef.current.add(first.id);
        for (const attachment of mediaAttachments.slice(1)) {
          const dataBase64 = encodedByAttachmentId.get(attachment.id);
          if (dataBase64 === undefined) continue;
          await bridge.writeClipboardImage({
            name: attachment.name,
            mediaType: attachment.mediaType,
            dataBase64,
          });
          sendRaw('\u0016');
          await new Promise((resolve) => window.setTimeout(resolve, 180));
          pastedMediaIdsRef.current.add(attachment.id);
        }
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        // The archive path delivers the whole batch in one request.
        for (const attachment of mediaAttachments) {
          pastedMediaIdsRef.current.add(attachment.id);
        }
      }
    } finally {
      pendingMediaUploadRef.current = null;
    }
  };

  const sendPrompt = async () => {
    const prompt = draft.trim();
    if (
      (prompt === '' && attachments.length === 0) ||
      connection !== 'connected' ||
      attachmentUploadRef.current
    ) {
      return;
    }
    if (prompt.startsWith('/') && attachments.length > 0) {
      onNotify('Attachments can be sent with a normal AGY prompt, not a slash command.');
      return;
    }
    let submittedPrompt = prompt;
    let deliveredAttachments: ChatAttachment[] = [];
    const pendingAttachments = attachments;
    let mediaToPaste: ComposerAttachment[] = [];
    if (pendingAttachments.length > 0) {
      attachmentUploadRef.current = true;
      setUploadingAttachments(true);
      try {
        // SPEC 315: only still-buffered files are encoded and uploaded. Items
        // that landed in a previous attempt (upload succeeded, paste failed)
        // are reused verbatim — re-uploading duplicated files on the host and
        // re-pasted images into the prompt.
        const buffered = pendingAttachments.filter(
          (attachment): attachment is ComposerAttachment & { file: File } =>
            attachment.file !== undefined,
        );
        setAttachments((current) =>
          current.map((attachment) =>
            attachment.file === undefined
              ? attachment
              : { ...attachment, state: 'transferring' as const },
          ),
        );
        const encodedAttachments = await Promise.all(
          buffered.map(async (attachment) => ({
            attachment,
            dataBase64: await attachmentFileToBase64(attachment.file),
          })),
        );
        const uploaded =
          buffered.length === 0
            ? []
            : await bridge.uploadAgentAttachments({
                sessionId,
                attachments: encodedAttachments.map(
                  ({ attachment, dataBase64 }) => ({
                    name: attachment.name,
                    mediaType: attachment.mediaType,
                    dataBase64,
                  }),
                ),
              });
        if (uploaded.length !== buffered.length) {
          throw new Error('The attachment batch returned an incomplete result');
        }
        const remoteByLocalId = new Map(
          buffered.map((attachment, index) => [attachment.id, uploaded[index]!]),
        );
        uploaded.forEach((remote, index) => {
          encodedBytesRef.current.set(
            remote.id,
            encodedAttachments[index]!.dataBase64,
          );
        });
        // The tray becomes the delivered batch (remote ids, no Files) before
        // the fragile paste step, mirroring the unified path's swap — a retry
        // re-enters with this form and skips the upload entirely.
        const delivered = pendingAttachments.map((attachment) => {
          const remote = remoteByLocalId.get(attachment.id);
          if (remote === undefined) return attachment;
          return {
            id: remote.id,
            name: remote.name,
            mediaType: remote.mediaType,
            sizeBytes: remote.sizeBytes,
            state: 'ready' as const,
            remotePath: remote.remotePath,
            ...(attachment.previewUrl === undefined
              ? {}
              : { previewUrl: attachment.previewUrl }),
          };
        });
        setAttachments(delivered);
        deliveredAttachments = delivered.map(
          ({ id, name, mediaType, sizeBytes, remotePath }) => ({
            id,
            name,
            mediaType,
            sizeBytes,
            remotePath: remotePath!,
          }),
        );
        submittedPrompt = promptWithAttachmentReferences(
          prompt,
          deliveredAttachments.filter(
            (attachment) => !isInlineAttachmentImage(attachment.mediaType),
          ),
        );
        mediaToPaste = delivered.filter(
          (attachment) =>
            isInlineAttachmentImage(attachment.mediaType) &&
            !pastedMediaIdsRef.current.has(attachment.id),
        );
        await pasteNativeAgyMedia(mediaToPaste, encodedBytesRef.current);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const mediaToPasteIds = new Set(mediaToPaste.map((a) => a.id));
        setAttachments((current) =>
          current.map((attachment) => {
            const isPending = pendingAttachments.some((p) => p.id === attachment.id);
            if (!isPending) return attachment;
            if (attachment.file !== undefined || mediaToPasteIds.has(attachment.id)) {
              return { ...attachment, state: 'error' as const, errorMessage };
            }
            return attachment;
          })
        );
        onNotify(errorMessage);
        return;
      } finally {
        attachmentUploadRef.current = false;
        setUploadingAttachments(false);
      }
    }
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
        ...(submittedPrompt === prompt ? {} : { submittedPrompt }),
        ...(deliveredAttachments.length === 0
          ? {}
          : { attachments: deliveredAttachments }),
      };
      activeTurnIdRef.current = turn.id;
      updateTurns((current) => [...current, turn]);
    }
    const mirroredPrompt = remoteDraftRef.current;
    remoteDraftRef.current = '';
    inputFingerprintRef.current = '';
    setDraft('');
    setHistoryIndex(null);
    if (pendingAttachments.length > 0) {
      // The visible prompt is already mirrored into AGY. Append only the
      // non-media path suffix, then submit; pasting the whole prompt here used
      // to duplicate the user's text before every attachment turn.
      sendRaw(agyReconciledPromptSequence(mirroredPrompt, submittedPrompt));
      pendingAttachments.forEach((attachment) => {
        if (attachment.previewUrl !== undefined) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
      setAttachments([]);
      // The batch is delivered; the retry caches go with it.
      encodedBytesRef.current.clear();
      pastedMediaIdsRef.current.clear();
    } else {
      sendRaw(agyKeySequence('enter'));
    }
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
      void sendPrompt();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      // Esc closes the suggestion list and nothing else — the same key on the
      // Claude composer. Clearing the draft here destroyed long prompts with
      // no undo. The CLI clears its own input row on Escape; the next edit
      // re-syncs it from the observed prompt line in applyDraft. Without a
      // menu the key stays local: forwarding it would empty the remote row
      // while the draft stays visible, so a bare Enter would submit nothing.
      if (slashAutocomplete) {
        setSlashDismissed(true);
        sendRaw(agyKeySequence('escape'));
      }
      return;
    }
    if (
      navigationKey !== null &&
      ['left', 'right', 'home', 'end'].includes(navigationKey)
    ) {
      sendRaw(agyKeySequence(navigationKey));
      return;
    }
    if (
      (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
      // SPEC 1350: history only at the caret's boundary — inside a recalled
      // multi-line prompt the arrows must not swap the entry being edited.
      caretIsOnHistoryEdge(
        event.currentTarget,
        event.key === 'ArrowUp' ? 'previous' : 'next',
      ) &&
      screen.mode !== 'approval' &&
      screen.mode !== 'menu' &&
      screen.mode !== 'viewer'
    ) {
      const prompts = turns
        .map((turn) => turn.prompt)
        .filter((prompt) => prompt !== '');
      if (event.key === 'ArrowUp' && historyIndex === null) {
        historyDraftRef.current = draft;
      }
      const result = navigatePromptHistory(
        prompts,
        historyIndex,
        historyDraftRef.current,
        event.key === 'ArrowUp' ? 'previous' : 'next',
      );
      if (result !== null) {
        event.preventDefault();
        replaceRemoteDraft(result.value);
        setHistoryIndex(result.index);
        return;
      }
    }
    // A panel (approval, model picker) is drawn and owned by the CLI, so its
    // selection can only move there. Ordinary arrows also stay with the CLI
    // once the user has started editing a fresh draft.
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
  };

  const overlay = useMemo(
    () => recogniseAgyScreen(screen.rawLines),
    [screen.fingerprint],
  );
  // While an overlay is up the CLI is modal, so the composer is unavailable
  // regardless of the draft; it stays in the layout, disabled (SPEC 1057).
  const canCompose =
    overlay === null &&
    isAgyComposerEditable(connection, sessionStatus, screen.mode, draft) &&
    (statusSyncPhase === 'done' || statusSyncPhase === 'failed');

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
    // The startup sync opened this report itself; a busy CLI (observed while
    // AGY was mid eligibility-check) can swallow the closing Escape, and the
    // sync then times out to 'failed' with its overlay still covering the
    // conversation. Close what we opened instead of leaving it to the user.
    if (statusSyncPhase !== 'failed') return;
    if (overlay?.kind !== 'contextReport' && overlay?.kind !== 'quotaReport') {
      return;
    }
    sendRaw(agyKeySequence('escape'));
  }, [statusSyncPhase, overlay?.kind ?? null]);

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
        ) : status.contextUsedPercent === undefined || status.limits === undefined ? (
          // Either figure missing is worth saying. Requiring both to be absent
          // meant a known context silently covered for unknown quota, and the
          // gap read as "there is nothing here" rather than "we could not tell".
          <span className="agy-statusline-hint">
            {status.limits === undefined && status.contextUsedPercent === undefined
              ? 'Usage unavailable'
              : status.limits === undefined
                ? 'Quota unavailable'
                : 'Context unavailable'}
          </span>
        ) : null}
        </div>
      </div>
      <div
        className="chat-timeline agy-chat-timeline"
        ref={timelineRef}
        onScroll={(event) =>
          AGY_SCROLL_CACHE.set(sessionId, event.currentTarget.scrollTop)
        }
      >
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
          const visibleAssistantText = isStaleAgyReplyCandidate(
            turn.assistantText,
            turns.slice(0, index).map((earlier) => earlier.assistantText),
            current && running,
          )
            ? ''
            : turn.assistantText;
          return (
            <div className="agy-chat-turn" key={turn.id}>
              {turn.prompt === '' && (turn.attachments?.length ?? 0) === 0 ? null : (
                <div className="msg msg-user">
                  <div
                    className={`msg-body${(turn.attachments?.length ?? 0) > 0 ? ' msg-body-with-attachments' : ''}`}
                  >
                    {turn.prompt === '' ? null : turn.prompt}
                    <MessageAttachments attachments={turn.attachments ?? []} />
                  </div>
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

        {overlay !== null ? (
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
        The composer never leaves the layout (SPEC 1057): while an overlay is
        up it is disabled and the hint below names the reason, so the layout
        does not jump and focus has somewhere to return to.
      */}
      <div className="composer-wrap agy-composer-wrap">
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
        <div
          className={`composer agy-composer${attachments.length > 0 ? ' composer-with-attachments' : ''}`}
        >
          {attachments.length > 0 ? (
            <div className="composer-attachments">
              {attachments.map((attachment) => (
                <div className="composer-attachment" key={attachment.id}>
                  {attachment.previewUrl === undefined ? (
                    <span className="composer-file-icon">FILE</span>
                  ) : (
                    <img src={attachment.previewUrl} alt="" />
                  )}
                  <span>
                    <strong>{attachment.name}</strong>
                    <small
                      className={
                        attachment.state === 'error' ? 'attachment-state-error' : ''
                      }
                      title={attachment.errorMessage}
                    >
                      {ATTACHMENT_STATE_LABEL[attachment.state]} ·{' '}
                      {attachment.mediaType} ·{' '}
                      {formatAttachmentSize(attachment.sizeBytes)}
                    </small>
                  </span>
                  {attachment.state === 'error' ? (
                    <button
                      type="button"
                      className="attachment-retry"
                      title={`Retry ${attachment.name}`}
                      onClick={() => retryAttachment(attachment.id)}
                    >
                      重試
                    </button>
                  ) : null}
                  <button
                    type="button"
                    title="Remove attachment"
                    aria-label={`Remove ${attachment.name}`}
                    disabled={
                      attachment.state === 'packaging' ||
                      attachment.state === 'transferring' ||
                      attachment.state === 'verifying'
                    }
                    onClick={() => removeAttachment(attachment.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            data-testid="agy-composer-input"
            value={draft}
            rows={Math.min(6, Math.max(1, draft.split('\n').length))}
            disabled={!canCompose || uploadingAttachments}
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
            onPaste={(event) => {
              const files = clipboardAttachmentFiles(
                event.clipboardData.items,
                event.clipboardData.files,
              );
              if (files.length === 0) return;
              if (event.clipboardData.getData('text') === '') event.preventDefault();
              attachFiles(files);
            }}
            onKeyDown={handleComposerKeyDown}
          />
          <div className="composer-actions">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = '';
                if (files.length > 0) attachFiles(files);
              }}
            />
            <button
              type="button"
              className="composer-attach"
              title="Attach image or file"
              aria-label="Attach image or file"
              disabled={
                !canCompose ||
                uploadingAttachments ||
                attachments.length >= MAX_AGENT_ATTACHMENTS
              }
              onClick={() => fileInputRef.current?.click()}
            >
              {uploadingAttachments ? 'Packaging…' : '＋ Attach'}
            </button>
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
              disabled={
                !canCompose ||
                uploadingAttachments ||
                (draft.trim() === '' && attachments.length === 0)
              }
              onClick={() => void sendPrompt()}
            >
              Send
            </button>
          </div>
        </div>
        <div className="agy-composer-hint">
          {overlay !== null
            ? '選單開啟中，先完成或取消上方的選單才能輸入'
            : canCompose
              ? 'Enter to send · Shift+Enter for a new line'
              : agyComposerUnavailableHint(
                  connection,
                  sessionStatus,
                  screen.mode,
                  statusSyncPhase,
                )}
        </div>
      </div>
    </div>
  );
}
