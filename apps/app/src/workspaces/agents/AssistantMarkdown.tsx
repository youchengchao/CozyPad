import {
  Children,
  Component,
  isValidElement,
  useMemo,
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.min.css';
import { MermaidDiagram } from './MermaidDiagram';

type MarkdownProps = ComponentProps<typeof Markdown>;
type PreComponent = ComponentType<ComponentPropsWithoutRef<'pre'>>;

interface MarkdownSyntaxNode {
  type?: unknown;
  value?: unknown;
  children?: unknown;
}

const SAFE_RAW_HTML_TAG = /^<\s*\/?\s*(?:details|summary|sub|sup)\s*>$/iu;

function escapeUnsafeRawHtml(value: string): string {
  return value.replace(/<[^>]*>/gu, (tag) => {
    if (SAFE_RAW_HTML_TAG.test(tag)) return tag;
    return tag
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  });
}

/** Parse only the four raw HTML tags CozyPad intentionally supports. */
function remarkSafeRawHtml() {
  return (tree: unknown): void => {
    const visit = (candidate: unknown): void => {
      if (typeof candidate !== 'object' || candidate === null) return;
      const node = candidate as MarkdownSyntaxNode;
      if (node.type === 'html' && typeof node.value === 'string') {
        node.value = escapeUnsafeRawHtml(node.value);
      }
      if (Array.isArray(node.children)) {
        for (const child of node.children) visit(child);
      }
    };
    visit(tree);
  };
}

function normalizeParenthesizedInlineMath(line: string): string {
  const replaceMath = (text: string) =>
    text.replace(/(?<!\\)\\\((.+?)(?<!\\)\\\)/gu, (_match, expression: string) =>
      '$' + expression + '$',
    );

  const tick = '\x60';
  let normalized = '';
  let cursor = 0;
  while (cursor < line.length) {
    const codeStart = line.indexOf(tick, cursor);
    if (codeStart < 0) return normalized + replaceMath(line.slice(cursor));

    normalized += replaceMath(line.slice(cursor, codeStart));
    let markerLength = 1;
    while (line[codeStart + markerLength] === tick) markerLength += 1;
    const marker = tick.repeat(markerLength);
    const codeEnd = line.indexOf(marker, codeStart + markerLength);
    if (codeEnd < 0) return normalized + line.slice(codeStart);

    const afterCode = codeEnd + markerLength;
    normalized += line.slice(codeStart, afterCode);
    cursor = afterCode;
  }
  return normalized;
}

const REMARK_PLUGINS: NonNullable<MarkdownProps['remarkPlugins']> = [
  remarkGfm,
  remarkMath,
  remarkSafeRawHtml,
];

const REHYPE_PLUGINS: NonNullable<MarkdownProps['rehypePlugins']> = [
  rehypeRaw,
  [
    rehypeKatex,
    {
      throwOnError: false,
      errorColor: '#fb7185',
      strict: false,
    },
  ],
  [
    rehypeHighlight,
    {
      detect: false,
      ignoreMissing: true,
      // These blocks are handled by Mermaid or AGY's purpose-built cards.
      plainText: ['mermaid', 'diff', 'patch', 'gitlog', 'git-log'],
    },
  ],
];

/**
 * Robust error boundary for assistant markdown rendering. Prevents unclosed
 * math tags, bad syntax, or third-party parser errors from crashing React or
 * breaking layout.
 */
interface MarkdownErrorBoundaryProps {
  children: ReactNode;
  rawText?: string;
}

interface MarkdownErrorBoundaryState {
  hasError: boolean;
}

export class MarkdownErrorBoundary extends Component<
  MarkdownErrorBoundaryProps,
  MarkdownErrorBoundaryState
> {
  override state: MarkdownErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): MarkdownErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[AssistantMarkdown] Render exception caught:', error, errorInfo);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="markdown-error-fallback" role="alert">
          <div className="markdown-error-notice">
            ⚠️ Unable to render markdown layout. Showing raw content.
          </div>
          <pre className="markdown-raw-output">{this.props.rawText ?? ''}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * HackMD accepts display-math fences directly beside prose. remark-math
 * requires block boundaries, so add them only around standalone `$$` lines
 * outside fenced code. The Markdown source itself remains untouched.
 *
 * Enhanced with layout guards for unclosed code fences and unclosed math blocks.
 */
export function normalizeHackmdDisplayMath(markdown: string): string {
  if (!markdown) return '';
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  const normalized: string[] = [];
  let codeFence: { marker: '`' | '~'; length: number } | null = null;
  let displayMathOpen = false;
  let bracketDisplayMathOpen = false;

  const ensureBlank = () => {
    if (normalized.length > 0 && normalized.at(-1)?.trim() !== '') normalized.push('');
  };

  for (const line of lines) {
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/u)?.[1];
    if (fence !== undefined) {
      const marker = fence[0] as '`' | '~';
      if (codeFence === null) codeFence = { marker, length: fence.length };
      else if (marker === codeFence.marker && fence.length >= codeFence.length) {
        codeFence = null;
      }
      normalized.push(line);
      continue;
    }
    if (codeFence !== null) {
      normalized.push(line);
      continue;
    }

    const trimmed = line.trim();
    const bracketSingleLineDisplay = trimmed.match(/^\\\[(.+)\\\]$/u);
    if (bracketSingleLineDisplay?.[1] !== undefined) {
      ensureBlank();
      const indentation = line.match(/^\s*/u)?.[0] ?? '';
      normalized.push(
        indentation + '$$',
        indentation + bracketSingleLineDisplay[1],
        indentation + '$$',
        '',
      );
      continue;
    }
    if (!displayMathOpen && trimmed === '\\[') {
      ensureBlank();
      const indentation = line.match(/^\s*/u)?.[0] ?? '';
      normalized.push(indentation + '$$');
      displayMathOpen = true;
      bracketDisplayMathOpen = true;
      continue;
    }
    if (displayMathOpen && bracketDisplayMathOpen && trimmed === '\\]') {
      const indentation = line.match(/^\s*/u)?.[0] ?? '';
      normalized.push(indentation + '$$', '');
      displayMathOpen = false;
      bracketDisplayMathOpen = false;
      continue;
    }
    const singleLineDisplay = /^\$\$.+\$\$$/u.test(trimmed);
    if (singleLineDisplay) {
      ensureBlank();
      const indentation = line.match(/^\s*/u)?.[0] ?? '';
      normalized.push(
        `${indentation}$$`,
        `${indentation}${trimmed.slice(2, -2)}`,
        `${indentation}$$`,
        '',
      );
      continue;
    }
    if (trimmed === '$$') {
      if (!displayMathOpen) ensureBlank();
      normalized.push(line);
      displayMathOpen = !displayMathOpen;
      if (!displayMathOpen) normalized.push('');
      continue;
    }
    normalized.push(displayMathOpen ? line : normalizeParenthesizedInlineMath(line));
  }

  // Layout guard: Close unclosed display math tag if open at EOF
  if (displayMathOpen) {
    normalized.push('$$');
  }

  // Layout guard: Close unclosed code fence if open at EOF
  if (codeFence !== null) {
    normalized.push(codeFence.marker.repeat(codeFence.length));
  }

  return normalized.join('\n');
}

/**
 * Extracts <think>...</think> or <thinking>...</thinking> blocks from assistant markdown text.
 */
export interface ParsedMarkdownContent {
  thoughts: string[];
  mainText: string;
}

export function parseAssistantText(text: string): ParsedMarkdownContent {
  if (!text) return { thoughts: [], mainText: '' };

  const thoughts: string[] = [];
  const thinkRegex = /<(?:think|thinking)>([\s\S]*?)(?:<\/(?:think|thinking)>|$)/giu;
  let match: RegExpExecArray | null;

  while ((match = thinkRegex.exec(text)) !== null) {
    const content = match[1]?.trim();
    if (content) {
      thoughts.push(content);
    }
  }

  const mainText = thoughts.length > 0
    ? text.replace(/<(?:think|thinking)>[\s\S]*?(?:<\/(?:think|thinking)>|$)/giu, '').trim()
    : text;

  return { thoughts, mainText };
}

interface MarkdownPreProps extends ComponentPropsWithoutRef<'pre'> {
  streaming: boolean;
  fallbackPre?: PreComponent;
}

function MarkdownPre({
  children,
  streaming,
  fallbackPre: FallbackPre,
  ...props
}: MarkdownPreProps) {
  const child = Children.count(children) === 1 ? Children.only(children) : null;
  if (
    isValidElement<{
      className?: string;
      children?: ReactNode;
    }>(child) &&
    /\blanguage-mermaid\b/iu.test(child.props.className ?? '')
  ) {
    const source = String(child.props.children ?? '').replace(/\n$/u, '');
    return <MermaidDiagram source={source} deferred={streaming} />;
  }

  if (FallbackPre !== undefined) {
    return <FallbackPre {...props}>{children}</FallbackPre>;
  }
  return <pre {...props}>{children}</pre>;
}

export interface MarkdownViewProps {
  children: string;
  /** Defers Mermaid rendering while text is still arriving. */
  streaming?: boolean;
  /** AGY keeps its existing diff/git-log code-block cards through this hook. */
  fallbackPre?: PreComponent;
  className?: string;
  /** What relative paths in links are relative to — the session's cwd. */
  cwd?: string;
}

/**
 * Markdown with this app's plugin set, and nothing that assumes an assistant
 * wrote it.
 *
 * Split out from {@link AssistantMarkdown} because two of its three callers are
 * not assistants: a user's own message in the timeline, and a draft in
 * FilesWorkspace. Both were previously either rendered as plain text or run
 * through {@link parseAssistantText}, which deletes anything between `<think>`
 * tags — fine for a model that emits them, wrong for a human who types them.
 *
 * Everything else is deliberately shared rather than duplicated: the same
 * GFM/KaTeX/highlight plugins, the same Mermaid hook, the same error boundary.
 * A user pasting a mermaid fence should get the same diagram the agent would.
 */
/**
 * The href, when it names something the Files workspace could open; null for
 * everything else. `#anchor`, `mailto:` and other schemes used to dispatch
 * too, yanking the user out of the chat with nothing to show for it.
 */
function pathTargetOf(href: string): string | null {
  if (href.startsWith('file:')) return href;
  // Checked before the scheme test: `C:\notes.md` is a drive path, not a URL.
  if (/^[A-Za-z]:[\\/]/u.test(href)) return href;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(href)) return null;
  if (href.startsWith('#')) return null;
  return href;
}

function MarkdownLink({
  href,
  cwd,
  children,
  ...props
}: ComponentPropsWithoutRef<'a'> & { cwd?: string }) {
  const handleClick = (e: React.MouseEvent) => {
    if (!href) return;
    const target = pathTargetOf(href);
    if (target === null) return;
    e.preventDefault();
    window.dispatchEvent(
      new CustomEvent('cozypad:open-file', {
        // The session's cwd rides along: agents emit repo-relative paths,
        // and only the sender knows what they are relative to.
        detail: { path: target, ...(cwd === undefined ? {} : { cwd }) },
      }),
    );
  };
  return (
    <a href={href} onClick={handleClick} {...props}>
      {children}
    </a>
  );
}

export function MarkdownView({
  children,
  streaming = false,
  fallbackPre,
  className = 'assistant-markdown-container',
  cwd,
}: MarkdownViewProps) {
  const normalized = useMemo(
    () => normalizeHackmdDisplayMath(children),
    [children],
  );

  const components = useMemo<Components>(
    () => ({
      pre: (componentProps) => {
        const { node, ...props } = componentProps;
        void node;
        return (
          <MarkdownPre {...props} fallbackPre={fallbackPre} streaming={streaming} />
        );
      },
      a: (componentProps) => {
        const { node, ...props } = componentProps;
        void node;
        return <MarkdownLink {...props} cwd={cwd} />;
      },
    }),
    [fallbackPre, streaming, cwd],
  );

  if (children === '') return null;

  return (
    <MarkdownErrorBoundary rawText={children}>
      <div className={className}>
        {normalized === '' ? null : (
          <Markdown
            urlTransform={(url) => url}
            components={components}
            rehypePlugins={REHYPE_PLUGINS}
            remarkPlugins={REMARK_PLUGINS}
          >
            {normalized}
          </Markdown>
        )}
      </div>
    </MarkdownErrorBoundary>
  );
}

export interface AssistantMarkdownProps {
  children: string;
  streaming?: boolean;
  /** AGY keeps its existing diff/git-log code-block cards through this hook. */
  fallbackPre?: PreComponent;
  /** What relative paths in links are relative to — the session's cwd. */
  cwd?: string;
}

export function AssistantMarkdown({
  children,
  streaming = false,
  fallbackPre,
  cwd,
}: AssistantMarkdownProps) {
  // The empty-text check lives BELOW the hooks: an assistant message's first
  // render is reliably `text: ''` (claude's first chunk is empty), and an
  // early return here changes the hook count between renders — React throws
  // and the whole timeline is replaced by the error card.
  const { thoughts, mainText } = useMemo(
    () => parseAssistantText(children),
    [children],
  );

  const normalizedThoughts = useMemo(
    () => thoughts.map((t) => normalizeHackmdDisplayMath(t)),
    [thoughts],
  );

  const normalizedMainText = useMemo(
    () => normalizeHackmdDisplayMath(mainText),
    [mainText],
  );

  const components = useMemo<Components>(
    () => ({
      pre: (componentProps) => {
        const { node, ...props } = componentProps;
        void node;
        return (
          <MarkdownPre
            {...props}
            fallbackPre={fallbackPre}
            streaming={streaming}
          />
        );
      },
      a: (componentProps) => {
        const { node, ...props } = componentProps;
        void node;
        return <MarkdownLink {...props} cwd={cwd} />;
      },
    }),
    [fallbackPre, streaming, cwd],
  );

  if (children === '') return null;

  return (
    <MarkdownErrorBoundary rawText={children}>
      <div className="assistant-markdown-container">
        {normalizedThoughts.map((thought, index) => (
          <details
            key={`thought-${index}`}
            className="card thinking-card"
            open={streaming}
          >
            <summary className="thinking-summary" style={{ padding: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px' }}>
                <span className="thinking-icon" aria-hidden="true">💡</span>
                <span className="thinking-title">Thought Process</span>
                {streaming ? (
                  <span className="thinking-pulse" title="Thinking..." />
                ) : null}
              </div>
            </summary>
            <div className="thinking-body">
              <Markdown
                urlTransform={(url) => url}
                components={components}
                rehypePlugins={REHYPE_PLUGINS}
                remarkPlugins={REMARK_PLUGINS}
              >
                {thought}
              </Markdown>
            </div>
          </details>
        ))}

        {normalizedMainText !== '' ? (
          <Markdown
            urlTransform={(url) => url}
            components={components}
            rehypePlugins={REHYPE_PLUGINS}
            remarkPlugins={REMARK_PLUGINS}
          >
            {normalizedMainText}
          </Markdown>
        ) : null}
      </div>
    </MarkdownErrorBoundary>
  );
}
