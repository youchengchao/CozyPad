import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatItem } from '@cozypad/contracts';
import {
  AssistantMarkdown,
  normalizeHackmdDisplayMath,
  parseAssistantText,
  MarkdownErrorBoundary,
} from '../AssistantMarkdown';
import { MermaidDiagram } from '../MermaidDiagram';
import { ChatTimeline } from '../ChatTimeline';

describe('Challenger 1 - Empirical Stress Harness for Milestone 2', () => {
  beforeAll(() => {
    (globalThis as any).window = (globalThis as any).window || {
      cozypad: {
        fsReadBytes: vi.fn().mockResolvedValue({ dataBase64: '' }),
      },
    };
  });

  describe('1. Unclosed Code Fences & Math Normalization', () => {
    it('normalizes unclosed 3-tick code fence at EOF', () => {
      const input = 'PROSE BEFORE\n```typescript\nconst x = 1;';
      const output = normalizeHackmdDisplayMath(input);
      expect(output).toBe('PROSE BEFORE\n```typescript\nconst x = 1;\n```');
    });

    it('normalizes unclosed 4-tick code fence at EOF', () => {
      const input = 'PROSE BEFORE\n````python\ndef foo():\n    return 42';
      const output = normalizeHackmdDisplayMath(input);
      expect(output).toBe('PROSE BEFORE\n````python\ndef foo():\n    return 42\n````');
    });

    it('normalizes unclosed ~~~ code fence at EOF', () => {
      const input = 'PROSE BEFORE\n~~~bash\necho "hello world"';
      const output = normalizeHackmdDisplayMath(input);
      expect(output).toBe('PROSE BEFORE\n~~~bash\necho "hello world"\n~~~');
    });

    it('normalizes unclosed display math $$ at EOF', () => {
      const input = 'Calculus:\n$$\n\\int_0^1 x dx';
      const output = normalizeHackmdDisplayMath(input);
      expect(output).toBe('Calculus:\n\n$$\n\\int_0^1 x dx\n$$');
    });

    it('handles mixed unclosed code fence AND unclosed display math', () => {
      const input = 'Text:\n$$\n\\sum x_i\n```js\nlet a = 1;';
      const output = normalizeHackmdDisplayMath(input);
      expect(() => {
        renderToStaticMarkup(<AssistantMarkdown>{input}</AssistantMarkdown>);
      }).not.toThrow();
    });

    it('does not alter $$ math syntax inside valid fenced code blocks', () => {
      const input = '```sh\necho $$PID\nexport PRICE=$$100\n```';
      const output = normalizeHackmdDisplayMath(input);
      expect(output).toBe(input);
    });
  });

  describe('2. Malformed HTML & XML Tag Resilience', () => {
    it('handles unclosed <div class="test"> tag without crashing React', () => {
      const malformed = 'Prose <div class="test" style="color:red"> unmatched content';
      const html = renderToStaticMarkup(<AssistantMarkdown>{malformed}</AssistantMarkdown>);
      expect(html).toContain('Prose');
      expect(html).toContain('unmatched content');
    });

    it('handles dangerous script tags and inline handlers safely', () => {
      const malicious = 'Test <script>alert(1)</script><img src=x onerror=alert(2) />';
      const html = renderToStaticMarkup(<AssistantMarkdown>{malicious}</AssistantMarkdown>);
      expect(html).not.toContain('<script>');
      expect(html).toContain('Test');
    });

    it('parses unclosed <think> tag gracefully into thoughts', () => {
      const unclosedThink = '<think>\nCurrently analyzing code base...\nStill analyzing without closing tag';
      const parsed = parseAssistantText(unclosedThink);
      expect(parsed.thoughts).toHaveLength(1);
      expect(parsed.thoughts[0]).toContain('Currently analyzing code base...');
      expect(parsed.mainText).toBe('');
    });

    it('handles multiple nested or consecutive think tags', () => {
      const multiThink = '<think>Thought 1</think>\nProse 1\n<thinking>Thought 2</thinking>\nFinal answer';
      const parsed = parseAssistantText(multiThink);
      expect(parsed.thoughts).toHaveLength(2);
      expect(parsed.thoughts[0]).toBe('Thought 1');
      expect(parsed.thoughts[1]).toBe('Thought 2');
      expect(parsed.mainText).toContain('Prose 1');
      expect(parsed.mainText).toContain('Final answer');
    });
  });

  describe('3. Extremely Long Strings & High Volume Stress', () => {
    it('renders unbroken 50,000-character string without crash', () => {
      const longToken = 'A'.repeat(50000);
      const html = renderToStaticMarkup(<AssistantMarkdown>{longToken}</AssistantMarkdown>);
      expect(html.length).toBeGreaterThan(50000);
    });

    it('renders 10,000 lines of code fence without memory overflow or stack overflow', () => {
      const lines = Array.from({ length: 10000 }, (_, i) => `const val_${i} = ${i};`).join('\n');
      const markdown = `\`\`\`javascript\n${lines}\n\`\`\``;
      const html = renderToStaticMarkup(<AssistantMarkdown>{markdown}</AssistantMarkdown>);
      expect(html).toContain('language-javascript');
      expect(html).toContain('val_9999');
    });

    it('renders timeline with 200 items smoothly', () => {
      const items: ChatItem[] = Array.from({ length: 200 }, (_, i): ChatItem => {
        if (i % 2 === 0) {
          return {
            id: `item-${i}`,
            kind: 'message',
            timestamp: '2026-08-07T00:00:00.000Z',
            role: i % 4 === 0 ? 'user' : 'assistant',
            text: `Message index ${i} with code \`const x = ${i}\``,
          };
        }
        return {
          id: `item-${i}`,
          kind: 'tool_call',
          timestamp: '2026-08-07T00:00:00.000Z',
          name: 'bash_command',
          summary: `git commit -m "step ${i}"`,
          status: 'completed',
          durationMs: i * 5,
          output: `Output for step ${i}`,
        };
      });

      const dummyProps = {
        sessionId: 'stress-session-200',
        onResolveApproval: vi.fn(),
        onAnswerQuestion: vi.fn(),
      };

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('Message index 0');
      expect(html).toContain('Message index 198');
      expect(html).toContain('Output for step 199');
    });
  });

  describe('4. Corrupt Mermaid Diagram Resilience', () => {
    it('renders corrupt mermaid diagram in loading state statically without crashing', () => {
      const corruptMermaid = '```mermaid\nthis is invalid syntax @#$%^&*()\n```';
      const html = renderToStaticMarkup(<AssistantMarkdown>{corruptMermaid}</AssistantMarkdown>);
      expect(html).toContain('mermaid-diagram-loading');
    });

    it('renders corrupt mermaid diagram in deferred (streaming) state without crashing', () => {
      const corruptMermaid = '```mermaid\ngraph TD\nA ---> B -->\n```';
      const html = renderToStaticMarkup(<AssistantMarkdown streaming>{corruptMermaid}</AssistantMarkdown>);
      expect(html).toContain('mermaid-diagram-deferred');
      expect(html).toContain('A ---&gt; B --&gt;');
    });

    it('renders MermaidDiagram directly in error state', () => {
      const html = renderToStaticMarkup(<MermaidDiagram source="invalid syntax" deferred={false} />);
      expect(html).toContain('mermaid-diagram');
    });
  });

  describe('5. Error Boundary Fallback Test', () => {
    it('MarkdownErrorBoundary derived state from error produces fallback UI', () => {
      const derived = MarkdownErrorBoundary.getDerivedStateFromError();
      expect(derived).toEqual({ hasError: true });

      const boundaryInstance = new MarkdownErrorBoundary({ rawText: 'Raw markdown snippet', children: null });
      boundaryInstance.state = { hasError: true };

      const html = renderToStaticMarkup(boundaryInstance.render() as any);
      expect(html).toContain('markdown-error-fallback');
      expect(html).toContain('Unable to render markdown layout');
      expect(html).toContain('Raw markdown snippet');
    });
  });
});
