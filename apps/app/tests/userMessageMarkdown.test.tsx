/**
 * A user's own message renders through the same markdown pipeline the agent's
 * does.
 *
 * It used to be a bare text node — `<div className="msg-text">{item.text}</div>`
 * — so a link, a fenced block, a table or a mermaid diagram you typed came back
 * as source. The asymmetry was invisible in every test because nothing rendered
 * a user message containing markdown.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatItem } from '@cozypad/contracts';
import { ChatTimeline } from '../src/workspaces/agents/ChatTimeline';
import { MarkdownView } from '../src/workspaces/agents/AssistantMarkdown';

const TIMESTAMP = '2026-08-08T08:00:00.000Z';

function timeline(text: string, role: 'user' | 'assistant' = 'user'): string {
  const items: ChatItem[] = [
    { id: 'm1', timestamp: TIMESTAMP, kind: 'message', role, text },
  ];
  return renderToStaticMarkup(
    <ChatTimeline
      sessionId="s1"
      items={items}
      onResolveApproval={() => undefined}
      onAnswerQuestion={() => undefined}
    />,
  );
}

describe('a user message is rendered as markdown, not as source', () => {
  it('turns a bare URL into a link', () => {
    expect(timeline('see https://github.com/youchengchao/CozyPad')).toContain(
      '<a href="https://github.com/youchengchao/CozyPad">',
    );
  });

  it('renders a fenced code block instead of printing the backticks', () => {
    const html = timeline('```ts\nconst a = 1;\n```');
    expect(html).toContain('<code');
    expect(html).not.toContain('```');
  });

  it('renders a table', () => {
    const html = timeline('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toContain('<table>');
  });

  it('renders bold, including with CJK on both sides', () => {
    // Reported as intermittently failing. Measured here rather than assumed:
    // CommonMark's flanking rules are defined on punctuation and whitespace,
    // and CJK is neither, so `**` between two Han characters does open and
    // close. The case that genuinely does not work is intraword `__`, which is
    // deliberate — it keeps `snake_case_names` out of italics.
    expect(timeline('文字**粗體**文字')).toContain('<strong>粗體</strong>');
    expect(timeline('「**深度學習基礎**」')).toContain('<strong>深度學習基礎</strong>');
    expect(timeline('**plain ascii bold**')).toContain('<strong>plain ascii bold</strong>');
    expect(timeline('中文__底線__字')).toContain('中文__底線__字');
  });

  it('leaves a Windows path exactly as typed', () => {
    // The one thing markdown was suspected of mangling, and does not: `_` only
    // opens emphasis at a word boundary, so `report_final_v2.txt` survives.
    const path = String.raw`C:\Users\devbox\report_final_v2.txt`;
    expect(timeline(path)).toContain(path);
  });

  it('escapes raw HTML a user typed instead of executing it', () => {
    // Raw HTML is filtered before rehype-raw parses the four supported tags.
    // Everything else must remain escaped, especially attribute-bearing tags.
    //
    // Asserted on the *element*, not on the substring: the payload survives as
    // escaped text (`&lt;img … onerror=&quot;…&quot;&gt;`), which is the
    // correct and safe outcome. A first draft of this test looked for the
    // string "onerror" and failed on its own success.
    const html = timeline('<img src=x onerror="alert(1)"> and <b>bold</b>');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).not.toMatch(/<img\b/u);
    expect(html).not.toMatch(/<b>bold<\/b>/u);
  });

  it('renders the same content the same way for both roles', () => {
    // The point of sharing MarkdownView rather than duplicating a renderer.
    const source = '**bold** and `code` and [a](https://example.com)';
    const user = timeline(source, 'user');
    const assistant = timeline(source, 'assistant');
    for (const fragment of ['<strong>bold</strong>', '<code>code</code>', 'href="https://example.com"']) {
      expect(user).toContain(fragment);
      expect(assistant).toContain(fragment);
    }
  });
});

describe('MarkdownView is the assistant renderer minus the assistant assumptions', () => {
  it('keeps `<think>` text a human typed, which AssistantMarkdown strips', () => {
    // parseAssistantText deletes everything between <think> tags. Correct for a
    // model that emits them; wrong for a user asking about them, and wrong for
    // the FilesWorkspace draft that also used to go through it.
    const html = renderToStaticMarkup(
      <MarkdownView>{'why does <think> get eaten?'}</MarkdownView>,
    );
    expect(html).toContain('get eaten?');
  });
});
