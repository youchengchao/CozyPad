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
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.min.css';
import { MermaidDiagram } from './MermaidDiagram';

type MarkdownProps = ComponentProps<typeof Markdown>;
type PreComponent = ComponentType<ComponentPropsWithoutRef<'pre'>>;

const REMARK_PLUGINS: NonNullable<MarkdownProps['remarkPlugins']> = [
  remarkGfm,
  remarkMath,
];

const REHYPE_PLUGINS: NonNullable<MarkdownProps['rehypePlugins']> = [
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
    normalized.push(line);
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

export interface AssistantMarkdownProps {
  children: string;
  streaming?: boolean;
  /** AGY keeps its existing diff/git-log code-block cards through this hook. */
  fallbackPre?: PreComponent;
}

export function AssistantMarkdown({
  children,
  streaming = false,
  fallbackPre,
}: AssistantMarkdownProps) {
  if (children === '') return null;

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
    }),
    [fallbackPre, streaming],
  );

  return (
    <MarkdownErrorBoundary rawText={children}>
      <div className="assistant-markdown-container">
        {normalizedThoughts.map((thought, index) => (
          <details
            key={`thought-${index}`}
            className="card thinking-card"
            open={streaming}
          >
            <summary className="thinking-summary">
              <span className="thinking-icon" aria-hidden="true">💡</span>
              <span className="thinking-title">Thought Process</span>
              {streaming ? (
                <span className="thinking-pulse" title="Thinking..." />
              ) : null}
            </summary>
            <div className="thinking-body">
              <Markdown
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
