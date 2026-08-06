import {
  Children,
  isValidElement,
  useMemo,
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ComponentType,
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
  rehypeKatex,
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
    <Markdown
      components={components}
      rehypePlugins={REHYPE_PLUGINS}
      remarkPlugins={REMARK_PLUGINS}
    >
      {children}
    </Markdown>
  );
}
