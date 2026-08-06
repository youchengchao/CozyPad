import { useEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatItem } from '@cozypad/contracts';
import { MessageAttachments } from './MessageAttachments';

interface ChatTimelineProps {
  sessionId: string;
  items: ChatItem[];
  interactive?: boolean;
  onResolveApproval(itemId: string, resolution: 'allowed' | 'denied'): void;
  onAnswerQuestion(itemId: string, optionIndex: number): void;
  /** Refuses a whole question request; used by unrepresentable questions. */
  onDeclineQuestion?(itemId: string): void;
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

export function ChatTimeline({
  sessionId,
  items,
  interactive = true,
  onResolveApproval,
  onAnswerQuestion,
  onDeclineQuestion,
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
            return (
              <div
                key={item.id}
                className={`msg msg-${item.role}${item.streaming ? ' msg-streaming' : ''}`}
              >
                <div
                  className={`msg-body${messageAttachments.length > 0 ? ' msg-body-with-attachments' : ''}`}
                >
                  {item.role === 'assistant' ? (
                    <div className="markdown">
                      <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
                    </div>
                  ) : item.text === '' ? null : (
                    <div className="msg-text">{item.text}</div>
                  )}
                  <MessageAttachments attachments={messageAttachments} />
                  {item.streaming ? <span className="caret" /> : null}
                  {item.interrupted === true ? (
                    <span className="msg-interrupted">已中斷</span>
                  ) : null}
                </div>
              </div>
            );
          case 'tool_call':
            return (
              <details key={item.id} className={`card tool-card tool-${item.status}`}>
                <summary>
                  <span className={`tool-status tool-status-${item.status}`} />
                  <span className="tool-name">{item.name}</span>
                  <span className="tool-summary mono">{item.summary}</span>
                  {item.status === 'unknown' ? (
                    <span className="tool-duration">結果未知</span>
                  ) : item.durationMs !== undefined ? (
                    <span className="tool-duration">{item.durationMs}ms</span>
                  ) : null}
                </summary>
                {item.output ? <pre className="tool-output">{item.output}</pre> : null}
              </details>
            );
          case 'file_diff':
            return (
              <details key={item.id} className="card diff-card" open>
                <summary>
                  <span className="mono diff-path">{item.path}</span>
                  <span className="diff-stat">
                    <span className="diff-add">+{item.additions}</span>{' '}
                    <span className="diff-del">−{item.deletions}</span>
                  </span>
                </summary>
                <DiffBody diff={item.diff} />
              </details>
            );
          case 'approval':
            return (
              <div key={item.id} className={`card approval-card approval-${item.resolution}`}>
                <div className="approval-head">
                  <span className="approval-title">需要核准</span>
                  <span className="approval-risk">{item.riskSummary}</span>
                </div>
                <code className="approval-command">{item.command}</code>
                <div className="approval-meta mono">
                  {item.machine === undefined ? '' : `${item.machine} · `}cwd: {item.cwd}
                </div>
                {item.resolution === 'pending' ? (
                  <div className="approval-actions">
                    <button
                      className="btn-allow"
                      disabled={!interactive}
                      onClick={() => onResolveApproval(item.id, 'allowed')}
                    >
                      Allow once
                    </button>
                    <button
                      className="btn-deny"
                      disabled={!interactive}
                      onClick={() => onResolveApproval(item.id, 'denied')}
                    >
                      Deny
                    </button>
                  </div>
                ) : (
                  <span className={`chip chip-${item.resolution}`}>
                    {item.resolution === 'allowed'
                      ? 'Allowed'
                      : item.resolution === 'denied'
                        ? 'Denied'
                        : 'Expired'}
                  </span>
                )}
              </div>
            );
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
              // SPEC 3.4.6: a question the card cannot express still shows
              // its raw content and can be refused — one refusal answers the
              // whole request, so the agent is never left waiting on nothing.
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
                        disabled={!interactive || onDeclineQuestion === undefined}
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
                          !interactive ||
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
          case 'notice':
            // A CozyPad marker (e.g. the new-native-conversation boundary),
            // deliberately styled as a divider so it never reads as agent
            // output (SPEC 277).
            return (
              <div key={item.id} className="timeline-notice" role="note">
                <span>{item.text}</span>
              </div>
            );
        }
      })}
    </div>
  );
}
