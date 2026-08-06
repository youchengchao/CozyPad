import type { ComponentPropsWithoutRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssistantMarkdown } from '../src/workspaces/agents/AssistantMarkdown';

describe('AssistantMarkdown', () => {
  it('renders inline and display equations through KaTeX', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown>
        {'Euler: $e^{i\\pi} + 1 = 0$\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$'}
      </AssistantMarkdown>,
    );

    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
    expect(html).toContain('aria-hidden="true"');
  });

  it('recognises a completed Mermaid fence without rendering source as code', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown>
        {'~~~mermaid\ngraph TD\n  A --> B\n~~~'}
      </AssistantMarkdown>,
    );

    expect(html).toContain('mermaid-diagram-loading');
    expect(html).toContain('Rendering Mermaid diagram');
    expect(html).not.toContain('language-mermaid');
  });

  it('defers Mermaid rendering while the assistant response is streaming', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown streaming>
        {'~~~mermaid\ngraph TD\n  A --> B\n~~~'}
      </AssistantMarkdown>,
    );

    expect(html).toContain('mermaid-diagram-deferred');
    expect(html).toContain('language-mermaid');
    expect(html).toContain('A --&gt; B');
  });

  it('keeps AGY custom code-block rendering as the non-Mermaid fallback', () => {
    function FallbackPre({
      children,
    }: ComponentPropsWithoutRef<'pre'>) {
      return <section data-testid="agy-code-card">{children}</section>;
    }

    const html = renderToStaticMarkup(
      <AssistantMarkdown fallbackPre={FallbackPre}>
        {'~~~diff\n-old\n+new\n~~~'}
      </AssistantMarkdown>,
    );

    expect(html).toContain('data-testid="agy-code-card"');
    expect(html).toContain('-old');
    expect(html).toContain('+new');
  });

  it('routes Mermaid before an AGY fallback renderer', () => {
    function FallbackPre({
      children,
    }: ComponentPropsWithoutRef<'pre'>) {
      return <section data-testid="agy-code-card">{children}</section>;
    }

    const html = renderToStaticMarkup(
      <AssistantMarkdown fallbackPre={FallbackPre}>
        {'~~~mermaid\nsequenceDiagram\n  A->>B: Hello\n~~~'}
      </AssistantMarkdown>,
    );

    expect(html).toContain('mermaid-diagram-loading');
    expect(html).not.toContain('data-testid="agy-code-card"');
  });
});
