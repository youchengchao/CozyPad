import { Component, useEffect, useId, useRef, useState, type ErrorInfo, type ReactNode } from 'react';

type MermaidApi = (typeof import('mermaid'))['default'];
type DiagramState = 'deferred' | 'loading' | 'ready' | 'error';

let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'dark',
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
    });
    return mermaid;
  });
  return mermaidPromise;
}

export interface MermaidDiagramProps {
  source: string;
  /** Incomplete fenced blocks should stay source text until streaming ends. */
  deferred?: boolean;
}

interface MermaidErrorBoundaryProps {
  children: ReactNode;
  source: string;
}

interface MermaidErrorBoundaryState {
  hasError: boolean;
}

class MermaidErrorBoundary extends Component<
  MermaidErrorBoundaryProps,
  MermaidErrorBoundaryState
> {
  override state: MermaidErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): MermaidErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[MermaidDiagram] Error boundary caught render error:', error, errorInfo);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <figure className="mermaid-diagram mermaid-diagram-error" aria-label="Mermaid diagram">
          <div className="mermaid-diagram-error" role="alert">
            Unable to render Mermaid diagram. Showing its source instead.
          </div>
          <pre className="mermaid-diagram-source">
            <code className="language-mermaid">{this.props.source}</code>
          </pre>
        </figure>
      );
    }
    return this.props.children;
  }
}

/**
 * Render one fenced Mermaid block without coupling diagram state to the agent
 * transport or terminal parser. Mermaid is loaded only when a completed
 * response actually contains a diagram.
 */
export function MermaidDiagram({
  source,
  deferred = false,
}: MermaidDiagramProps) {
  const targetRef = useRef<HTMLDivElement>(null);
  const reactId = useId();
  const svgId = 'cozypad-mermaid-' + reactId.replace(/[^A-Za-z0-9_-]/gu, '');
  const [state, setState] = useState<DiagramState>(
    deferred ? 'deferred' : 'loading',
  );

  useEffect(() => {
    const target = targetRef.current;
    if (target === null) return;

    target.replaceChildren();
    if (deferred) {
      setState('deferred');
      return;
    }

    let cancelled = false;
    setState('loading');

    void loadMermaid()
      .then(async (mermaid) => {
        const parsed = await mermaid.parse(source, { suppressErrors: true });
        if (parsed === false) throw new Error('Invalid Mermaid diagram');

        const { svg, bindFunctions } = await mermaid.render(
          svgId,
          source,
          target,
        );
        if (cancelled) return;

        target.innerHTML = svg;
        bindFunctions?.(target);
        setState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        target.replaceChildren();
        setState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [deferred, source, svgId]);

  return (
    <MermaidErrorBoundary source={source}>
      <figure
        className={'mermaid-diagram mermaid-diagram-' + state}
        aria-label="Mermaid diagram"
      >
        <div className="mermaid-diagram-canvas" ref={targetRef} />
        {state === 'loading' ? (
          <div className="mermaid-diagram-status" role="status">
            Rendering Mermaid diagram...
          </div>
        ) : null}
        {state === 'deferred' ? (
          <pre className="mermaid-diagram-source">
            <code className="language-mermaid">{source}</code>
          </pre>
        ) : null}
        {state === 'error' ? (
          <>
            <div className="mermaid-diagram-error" role="alert">
              Unable to render Mermaid diagram. Showing its source instead.
            </div>
            <pre className="mermaid-diagram-source">
              <code className="language-mermaid">{source}</code>
            </pre>
          </>
        ) : null}
      </figure>
    </MermaidErrorBoundary>
  );
}
