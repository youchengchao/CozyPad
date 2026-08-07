import {
  Children,
  isValidElement,
  useMemo,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { AssistantMarkdown } from './AssistantMarkdown';
import { segmentAgyReply } from './agyTerminalModel';

/**
 * Rendering for one AGY reply.
 *
 * Split out of `AgyCliSurface` so the terminal plumbing and the chat
 * presentation can be changed independently: everything here is a pure
 * function of already-extracted reply text, and the live surface and the
 * read-only transcript preview share it verbatim — which is what keeps the
 * before-Resume and after-Resume views identical.
 */

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

export function AgyDiffCard({ diff }: { diff: string }) {
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

export function MarkdownPre({ children }: ComponentPropsWithoutRef<'pre'>) {
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
 * The agent's reasoning, closed by default.
 *
 * AGY prints `Thought for 3s` and, underneath it, the one-line summary it
 * shows while collapsed. Putting that summary in the `<summary>` element meant
 * the disclosure had nothing to disclose and the reasoning sat permanently in
 * the middle of the answer. The duration is the label; the reasoning is the
 * content — the same shape every other agent surface uses for a tool card.
 */
export function AgyThinkingCard({ meta, title }: { meta: string; title: string }) {
  const label = meta.trim() === '' ? 'Thought' : `Thought for ${meta.trim()}`;
  return (
    <details className="card agy-thinking-card" data-testid="agy-thinking-card">
      <summary>
        <span className="agy-thinking-icon" aria-hidden="true" />
        <span className="agy-thinking-label">{label}</span>
        <span className="agy-thinking-chevron" aria-hidden="true">
          ▾
        </span>
      </summary>
      {title === '' ? null : <p className="agy-thinking-body">{title}</p>}
    </details>
  );
}

export interface AgyReplyProps {
  text: string;
  streaming: boolean;
  onToggleToolDetails(): void;
  showNativeToolControl?: boolean;
}

/**
 * Render one reply the way the rest of the product renders a turn: prose as a
 * reading column, each tool run as its own card, and the agent's reasoning
 * collapsed behind a disclosure — rather than one block of terminal text.
 */
export function AgyReply({
  text,
  streaming,
  onToggleToolDetails,
  showNativeToolControl = true,
}: AgyReplyProps) {
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
          return <AgyThinkingCard key={index} meta={block.meta} title={block.title} />;
        }
        if (block.kind === 'notice') {
          // AGY talking about the session — "this conversation is also open in
          // another CLI" — not the model answering. Marked as such so it is
          // never mistaken for a reply.
          return (
            <aside
              className="card agy-notice-card"
              data-testid="agy-notice-card"
              role="note"
              key={index}
            >
              <span className="agy-notice-icon" aria-hidden="true">
                ⚠
              </span>
              <div>
                <strong>{block.title}</strong>
                {block.detail === '' ? null : <p>{block.detail}</p>}
                <span className="agy-notice-source">AGY CLI</span>
              </div>
            </aside>
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
              <AssistantMarkdown
                fallbackPre={MarkdownPre}
                streaming={streaming && last}
              >
                {block.text}
              </AssistantMarkdown>
              {streaming && last ? <span className="caret" /> : null}
            </div>
          </div>
        );
      })}
    </>
  );
}
