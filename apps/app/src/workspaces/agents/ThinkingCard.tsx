/**
 * The agent's reasoning, collapsed behind a disclosure.
 *
 * Kept from the deleted AGY terminal surface, which is where the design was
 * worked out — it is the one piece of that file that was about presentation
 * rather than about parsing a screen. It now renders the `thought` ChatItem,
 * which comes from ACP's own `agent_thought_chunk` instead of from a `<think>`
 * tag regexed out of prose.
 */
import { MarkdownView } from './AssistantMarkdown';

export interface ThinkingCardProps {
  text: string;
  /** Shown in the summary, e.g. a duration. Empty renders a bare "Thought". */
  meta?: string;
  /** Open while the thought is still arriving, collapsed once it has landed. */
  streaming?: boolean;
}

export function ThinkingCard({ text, meta = '', streaming = false }: ThinkingCardProps) {
  const label = meta.trim() === '' ? 'Thought' : `Thought for ${meta.trim()}`;
  return (
    <details
      className="card agy-thinking-card"
      data-testid="agy-thinking-card"
      open={streaming}
    >
      <summary>
        <span className="agy-thinking-icon" aria-hidden="true" />
        <span className="agy-thinking-label">{label}</span>
        <span className="agy-thinking-chevron" aria-hidden="true">
          ▾
        </span>
      </summary>
      {text === '' ? null : (
        <div className="agy-thinking-body">
          <MarkdownView>{text}</MarkdownView>
        </div>
      )}
    </details>
  );
}
