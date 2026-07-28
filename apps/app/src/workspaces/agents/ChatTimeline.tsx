import { useEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatItem } from '@cozypad/contracts';

interface ChatTimelineProps {
  sessionId: string;
  items: ChatItem[];
  onResolveApproval(itemId: string, resolution: 'allowed' | 'denied'): void;
  onAnswerQuestion(itemId: string, optionIndex: number): void;
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
  onResolveApproval,
  onAnswerQuestion,
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
            return (
              <div
                key={item.id}
                className={`msg msg-${item.role}${item.streaming ? ' msg-streaming' : ''}`}
              >
                <div className="msg-body">
                  {item.role === 'assistant' ? (
                    <div className="markdown">
                      <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
                    </div>
                  ) : (
                    item.text
                  )}
                  {item.streaming ? <span className="caret" /> : null}
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
                  {item.durationMs !== undefined ? (
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
                <div className="approval-meta mono">cwd: {item.cwd}</div>
                {item.resolution === 'pending' ? (
                  <div className="approval-actions">
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
                  </div>
                ) : (
                  <span className={`chip chip-${item.resolution}`}>
                    {item.resolution === 'allowed' ? 'Allowed' : 'Denied'}
                  </span>
                )}
              </div>
            );
          case 'question':
            return (
              <div key={item.id} className="card question-card">
                <div className="question-prompt">{item.prompt}</div>
                <div className="question-options">
                  {item.options.map((option, index) => {
                    const chosen = item.selectedIndex === index;
                    const answered = item.selectedIndex !== null;
                    return (
                      <button
                        key={option.label}
                        className={`question-option${chosen ? ' question-option-chosen' : ''}`}
                        disabled={answered}
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
              </div>
            );
          case 'usage':
            return (
              <div key={item.id} className="usage-row">
                usage — in {item.inputTokens.toLocaleString()} / out{' '}
                {item.outputTokens.toLocaleString()} tokens
              </div>
            );
        }
      })}
    </div>
  );
}
