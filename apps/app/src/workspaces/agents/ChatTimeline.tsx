import {
  Children,
  Component,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import type { ChatItem, ToolCallItem } from '@cozypad/contracts';
import { getBridge } from '../../platform/bridge';
import { AssistantMarkdown, MarkdownView } from './AssistantMarkdown';
import { ThinkingCard } from './ThinkingCard';
import { MessageAttachments } from './MessageAttachments';

export interface ChatTimelineProps {
  sessionId: string;
  items: ChatItem[];
  /** What relative paths in message links resolve against. */
  sessionCwd?: string;
  sessionStatus?: string;
  sessionError?: string;
  /**
   * `optionId` names the agent's own option when the card rendered one;
   * absent on the two-button fallback.
   */
  onResolveApproval(
    itemId: string,
    resolution: 'allowed' | 'denied',
    optionId?: string,
  ): void;
  onAnswerQuestion(itemId: string, optionIndex: number): void;
  /** Refuses a whole question request; used by unrepresentable questions. */
  onDeclineQuestion?(itemId: string): void;
  onRetrySession?(): void;
}

export interface TimelineErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

export interface TimelineErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class TimelineErrorBoundary extends Component<
  TimelineErrorBoundaryProps,
  TimelineErrorBoundaryState
> {
  constructor(props: TimelineErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): TimelineErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('TimelineErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="card timeline-error-boundary" role="alert">
          <div className="timeline-error-head">
            <span>⚠️ Timeline Rendering Error</span>
          </div>
          <p className="timeline-error-msg">
            {this.state.error?.message ?? 'Timeline encountered an error while rendering.'}
          </p>
          <button
            className="timeline-error-reload-btn"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Reload Timeline
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export interface AgentErrorCardProps {
  error?: string;
  onRetry?(): void;
}

export function AgentErrorCard({ error, onRetry }: AgentErrorCardProps) {
  return (
    <div className="card agent-error-card" role="alert">
      <div className="agent-error-head">
        <span className="agent-error-icon" aria-hidden="true">
          ⚠️
        </span>
        <strong>Agent Session Error</strong>
      </div>
      <p className="agent-error-detail">
        {error ?? 'An error occurred during agent session execution.'}
      </p>
      {onRetry ? (
        <button className="agent-error-retry-btn" onClick={onRetry}>
          Resume Session
        </button>
      ) : null}
    </div>
  );
}

export interface ToolStepCardProps {
  item: ToolCallItem;
  isCollapsible?: boolean;
  defaultExpanded?: boolean;
}

/**
 * Format execution elapsed time into human-friendly duration string.
 */
export function formatToolDuration(durationMs?: number, status?: string): string {
  if (status === 'unknown' && durationMs === undefined) {
    return '結果未知';
  }
  if (durationMs === undefined) {
    return status === 'running' ? 'running...' : '';
  }
  return `${durationMs}ms`;
}

/**
 * Step-by-step collapsible panel card for tool execution (Cursor / VS Code inspired).
 */
export function ToolStepCard({
  item,
  isCollapsible = true,
  defaultExpanded,
}: ToolStepCardProps) {
  const isRunning = item.status === 'running';
  const isError = item.status === 'error';
  const isCompleted = item.status === 'completed';
  const hasOutput = item.output !== undefined && item.output !== '';
  const canToggle = isCollapsible && hasOutput;
  const [isOpen, setIsOpen] = useState(defaultExpanded ?? (isRunning || isError));
  const durationText = formatToolDuration(item.durationMs, item.status);
  const outputId = `tool-output-${item.id}`;
  const normalizedName = item.name.trim();
  const normalizedSummary = item.summary.trim();
  const hasDistinctSummary =
    normalizedSummary !== '' && normalizedSummary !== normalizedName;

  useEffect(() => {
    if (defaultExpanded !== undefined) {
      setIsOpen(defaultExpanded);
    } else if (isRunning || isError) {
      setIsOpen(true);
    }
  }, [defaultExpanded, isError, isRunning]);

  const statusBadge = (
    <span className={`tool-status tool-status-${item.status}`}>
      {isRunning ? <span className="tool-spinner" aria-hidden="true" /> : null}
      {isCompleted ? <span className="tool-icon-check" aria-hidden="true">✓ </span> : null}
      {isError ? <span className="tool-icon-cross" aria-hidden="true">✕ </span> : null}
      {item.status === 'running' ? 'Running' : item.status === 'completed' ? 'Success' : item.status === 'error' ? 'Error' : ''}
    </span>
  );

  const headerContent = (
    <>
      {statusBadge}
      <span
        className={`tool-name${hasDistinctSummary ? '' : ' tool-name-primary'}`}
      >
        {item.name}
      </span>
      {hasDistinctSummary ? (
        <span className="tool-summary mono">{item.summary}</span>
      ) : null}
      {durationText ? (
        <span className={`tool-duration${isRunning ? ' tool-duration-running' : ''}`}>
          {durationText}
        </span>
      ) : null}
    </>
  );

  const outputContent = hasOutput ? (
    <div id={outputId} className="tool-output-wrapper" hidden={canToggle && !isOpen}>
      <pre className="tool-output">{item.output}</pre>
    </div>
  ) : null;

  if (!canToggle) {
    return (
      <div className={`card tool-card tool-${item.status}`}>
        <div className="tool-card-header">{headerContent}</div>
        {outputContent}
      </div>
    );
  }

  return (
    <div
      className={`card tool-card tool-${item.status}`}
    >
      <button
        type="button"
        className="tool-card-header tool-card-toggle"
        aria-expanded={isOpen}
        aria-controls={outputId}
        onClick={() => setIsOpen((open) => !open)}
      >
        {headerContent}
        <span className="tool-chevron" aria-hidden="true">▾</span>
      </button>
      {outputContent}
    </div>
  );
}

function DiffBody({ diff }: { diff: string }) {
  return (
    <pre className="diff-body">
      {diff.split('\n').map((line, index) => {
        const cls = line.startsWith('+')
          ? 'diff-add'
          : line.startsWith('-')
            ? 'diff-del'
            : line.startsWith('@@')
              ? 'diff-hunk'
              : '';
        return (
          <span key={index} className={cls}>
            {line}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

function reactNodeText(node: ReactNode): string {
  let text = '';
  Children.forEach(node, (child) => {
    if (typeof child === 'string' || typeof child === 'number' || typeof child === 'bigint') {
      text += String(child);
    } else if (isValidElement<{ children?: ReactNode }>(child)) {
      text += reactNodeText(child.props.children);
    }
  });
  return text;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await getBridge().writeClipboard(text);
      setCopied(true);
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2_000);
    } catch (error) {
      console.error('[ChatTimeline] Clipboard write failed:', error);
    }
  };

  return (
    <button
      type="button"
      className={`chat-copy-button${copied ? ' chat-copy-button-copied' : ''}`}
      aria-label={copied ? '已複製' : label}
      title={copied ? '已複製' : label}
      onClick={() => void copy()}
    >
      {copied ? (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="m4 10 3.25 3.25L16 4.5" />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <rect x="6.5" y="2.5" width="11" height="11" rx="2" />
          <path d="M13.5 13.5v2a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h2" />
        </svg>
      )}
    </button>
  );
}

/**
 * Intercepts ```diff / ```patch code fences in Claude/Codex assistant
 * messages and renders them as rich DiffBody cards instead of plain <pre>.
 */
function ChatTimelineMarkdownPre({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const child = Children.count(children) === 1 ? Children.only(children) : null;
  const text = reactNodeText(child ?? children).replace(/\n$/u, '');
  if (
    isValidElement<{
      className?: string;
      children?: ReactNode;
    }>(child)
  ) {
    const language = child.props.className ?? '';
    if (/\blanguage-(?:diff|patch)\b/u.test(language)) {
      return (
        <div className="chat-code-block">
          <details className="card diff-card" open>
            <summary style={{ padding: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px' }}>
                <span className="mono diff-path">inline diff</span>
              </div>
            </summary>
            <DiffBody diff={text} />
          </details>
          <CopyButton text={text} label="複製程式碼" />
        </div>
      );
    }
  }
  return (
    <div className="chat-code-block">
      <pre {...props}>{children}</pre>
      <CopyButton text={text} label="複製程式碼" />
    </div>
  );
}

export function ChatTimeline({
  sessionId,
  items,
  sessionCwd,
  sessionStatus,
  sessionError,
  onResolveApproval,
  onAnswerQuestion,
  onDeclineQuestion,
  onRetrySession,
}: ChatTimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const lastSession = useRef<string | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (lastSession.current !== sessionId) {
      if (lastSession.current !== null) {
        positions.current.set(lastSession.current, el.scrollTop);
      }
      el.scrollTop = positions.current.get(sessionId) ?? el.scrollHeight;
      lastSession.current = sessionId;
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [sessionId, items]);

  return (
    <div className="chat-timeline" ref={scrollRef}>
      {items.map((item) => {
        switch (item.kind) {
          case 'message':
            const messageAttachments = item.attachments ?? [];
            const isUser = item.role === 'user';
            return (
              <div
                key={item.id}
                className={`msg msg-${item.role}${item.streaming ? ' msg-streaming' : ''}`}
              >
                <div className="msg-wrapper">
                  <div className={`msg-role-bar msg-role-bar-${item.role}`}>
                    <span className={`msg-role-badge msg-role-badge-${item.role}`}>
                      {isUser ? '👤 You' : '🤖 Agent'}
                    </span>
                    {item.streaming ? (
                      <span className="agent-typing-indicator">
                        <span className="typing-dot" />
                        <span className="typing-dot" />
                        <span className="typing-dot" />
                      </span>
                    ) : null}
                  </div>
                  <div
                    className={`msg-body${messageAttachments.length > 0 ? ' msg-body-with-attachments' : ''}`}
                  >
                    {item.role === 'assistant' ? (
                      <div className="markdown">
                        <AssistantMarkdown
                          streaming={item.streaming}
                          fallbackPre={ChatTimelineMarkdownPre}
                          cwd={sessionCwd}
                        >
                          {item.text}
                        </AssistantMarkdown>
                      </div>
                    ) : item.text === '' ? null : (
                      // Your own message gets the same renderer the agent's
                      // does, minus the `<think>` stripping — a link, a fenced
                      // block, a mermaid diagram or a path reads the same on
                      // both sides of the conversation. It used to be a bare
                      // text node, so anything you typed came back as source.
                      <div className="msg-text markdown">
                        <MarkdownView
                          fallbackPre={ChatTimelineMarkdownPre}
                          className="user-markdown-container"
                          cwd={sessionCwd}
                        >
                          {item.text}
                        </MarkdownView>
                      </div>
                    )}
                    <MessageAttachments attachments={messageAttachments} />
                    {item.streaming ? <span className="caret" /> : null}
                    {item.interrupted === true ? (
                      <span className="msg-interrupted">已中斷</span>
                    ) : null}
                    {item.role === 'assistant' && item.streaming !== true && item.text !== '' ? (
                      <div className="chat-response-actions">
                        <CopyButton text={item.text} label="複製回應" />
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          case 'tool_call':
            return <ToolStepCard key={item.id} item={item} />;
          case 'file_diff':
            return (
              <details key={item.id} className="card diff-card" open>
                <summary style={{ padding: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', width: '100%' }}>
                    <span className="mono diff-path">{item.path}</span>
                    <span className="diff-stat">
                      <span className="diff-add">+{item.additions}</span>{' '}
                      <span className="diff-del">−{item.deletions}</span>
                    </span>
                  </div>
                </summary>
                <DiffBody diff={item.diff} />
              </details>
            );
          case 'approval': {
            const options = item.options ?? [];
            const isReject = (kind?: string) =>
              kind !== undefined && (kind.startsWith('reject') || kind.startsWith('deny'));
            const chosenName = options.find(
              (option) => option.optionId === item.selectedOptionId,
            )?.name;
            return (
              <div key={item.id} className={`card approval-card approval-${item.resolution}`}>
                <div className="approval-head">
                  <span className="approval-title">需要核准</span>
                  <span className="approval-risk">{item.riskSummary}</span>
                </div>
                {item.command === undefined ? null : (
                  <code className="approval-command">{item.command}</code>
                )}
                {item.machine === undefined && item.cwd === undefined ? null : (
                  <div className="approval-meta mono">
                    {item.machine === undefined ? '' : `${item.machine} · `}
                    {item.cwd === undefined ? '' : `cwd: ${item.cwd}`}
                  </div>
                )}
                {item.resolution === 'pending' ? (
                  <div className="approval-actions">
                    {options.length > 0 ? (
                      // The agent's own options, in its own words — claude's
                      // "Always Allow" and plan-mode choices included. Two
                      // hardcoded buttons silently dropped all of these.
                      options.map((option) => (
                        <button
                          key={option.optionId}
                          className={isReject(option.kind) ? 'btn-deny' : 'btn-allow'}
                          onClick={() =>
                            onResolveApproval(
                              item.id,
                              isReject(option.kind) ? 'denied' : 'allowed',
                              option.optionId,
                            )
                          }
                        >
                          {option.name}
                        </button>
                      ))
                    ) : (
                      <>
                        <button
                          className="btn-allow"
                          onClick={() => onResolveApproval(item.id, 'allowed')}
                        >
                          Allow once
                        </button>
                        <button
                          className="btn-deny"
                          onClick={() => onResolveApproval(item.id, 'denied')}
                        >
                          Deny
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <span className={`chip chip-${item.resolution}`}>
                    {item.resolution === 'allowed'
                      ? (chosenName ?? 'Allowed')
                      : item.resolution === 'denied'
                        ? (chosenName ?? 'Denied')
                        : 'Expired'}
                  </span>
                )}
              </div>
            );
          }
          case 'question': {
            const batch =
              item.batchId === undefined
                ? []
                : items.filter(
                    (candidate): candidate is Extract<ChatItem, { kind: 'question' }> =>
                      candidate.kind === 'question' &&
                      candidate.batchId === item.batchId,
                  );
            const unanswered = batch.filter(
              (candidate) =>
                candidate.selectedIndex === null && candidate.declined !== true,
            ).length;
            const batchNote =
              batch.length > 1 ? (
                <div className="question-batch-note">
                  本次詢問共 {batch.length} 題，尚有 {unanswered} 題未作答
                </div>
              ) : null;
            const closedChip =
              item.declined === true ? (
                <span className="chip chip-denied">Declined</span>
              ) : item.expired === true && item.selectedIndex === null ? (
                <span className="chip chip-expired">Expired</span>
              ) : null;
            if (item.unrepresentable === true) {
              return (
                <div
                  key={item.id}
                  className="card question-card question-unrepresentable"
                >
                  {batchNote}
                  <div className="question-prompt">
                    CozyPad 尚無法呈現這種題型，原始內容如下：
                  </div>
                  <pre className="question-raw mono">{item.prompt}</pre>
                  {closedChip ?? (
                    <div className="question-actions">
                      <button
                        className="btn-deny"
                        disabled={onDeclineQuestion === undefined}
                        onClick={() => onDeclineQuestion?.(item.id)}
                      >
                        拒絕整個詢問
                      </button>
                    </div>
                  )}
                </div>
              );
            }
            return (
              <div key={item.id} className="card question-card">
                {batchNote}
                <div className="question-prompt">{item.prompt}</div>
                <div className="question-options">
                  {item.options.map((option, index) => {
                    const chosen = item.selectedIndex === index;
                    const answered = item.selectedIndex !== null;
                    return (
                      <button
                        key={option.label}
                        className={`question-option${chosen ? ' question-option-chosen' : ''}`}
                        disabled={
                          answered ||
                          item.expired === true ||
                          item.declined === true
                        }
                        onClick={() => onAnswerQuestion(item.id, index)}
                      >
                        <span className="question-label">{option.label}</span>
                        {option.description ? (
                          <span className="question-desc">{option.description}</span>
                        ) : null}
                        {chosen ? <span className="question-check">✓</span> : null}
                      </button>
                    );
                  })}
                </div>
                {closedChip}
              </div>
            );
          }
          case 'usage':
            return (
              <div key={item.id} className="usage-row">
                usage — in {item.inputTokens.toLocaleString()} / out{' '}
                {item.outputTokens.toLocaleString()} tokens
              </div>
            );
          case 'thought':

            return (

              <div key={item.id} className="msg msg-assistant">

                <div className="msg-wrapper">

                  <ThinkingCard text={item.text} streaming={item.streaming === true} />

                </div>

              </div>

            );

          case 'notice':
            return (
              <div key={item.id} className="timeline-notice" role="note">
                <span>{item.text}</span>
              </div>
            );
        }
      })}
      {sessionStatus === 'error' ? (
        <AgentErrorCard error={sessionError} onRetry={onRetrySession} />
      ) : null}
    </div>
  );
}
