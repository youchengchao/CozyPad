import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssistantMarkdown } from '../src/workspaces/agents/AssistantMarkdown';

describe('AssistantMarkdown extended syntax', () => {
  it('renders parenthesis and bracket LaTeX delimiters through KaTeX', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown>
        {String.raw`Inline: \(x^2\)

\[
\frac{1}{2}
\]`}
      </AssistantMarkdown>,
    );

    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
    expect(html).not.toContain('\\(x^2\\)');
  });

  it('renders subscript and superscript HTML without exposing attributes', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown>
        {'H<sub>2</sub>O、x<sup>2</sup> and <sub onclick="alert(1)">unsafe</sub>'}
      </AssistantMarkdown>,
    );

    expect(html).toContain('H<sub>2</sub>O');
    expect(html).toContain('x<sup>2</sup>');
    expect(html).not.toMatch(/<sub\s+onclick=/u);
  });

  it('renders details and summary as a native toggle', () => {
    const html = renderToStaticMarkup(
      <AssistantMarkdown>
        {'<details> <summary>可展開區塊</summary>\n這是摺疊區塊內的內容。🎁\n\n</details>'}
      </AssistantMarkdown>,
    );

    expect(html).toContain('<details>');
    expect(html).toContain('<summary>可展開區塊</summary>');
    expect(html).toContain('這是摺疊區塊內的內容。🎁');
  });
});
