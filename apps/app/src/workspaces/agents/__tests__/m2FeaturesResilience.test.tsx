import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatItem } from '@cozypad/contracts';
import { AssistantMarkdown, parseAssistantText, normalizeHackmdDisplayMath } from '../AssistantMarkdown';
import { ChatTimeline, ToolStepCard, formatToolDuration } from '../ChatTimeline';

describe('Milestone 2 Features & Resilience Test Suite', () => {
  beforeAll(() => {
    (globalThis as any).window = (globalThis as any).window || {
      cozypad: {
        fsReadBytes: vi.fn().mockResolvedValue({ dataBase64: '' }),
      },
    };
  });

  const dummyProps = {
    sessionId: 'session-m2-test',
    onResolveApproval: vi.fn(),
    onAnswerQuestion: vi.fn(),
    onDeclineQuestion: vi.fn(),
  };

  describe('ToolStepCard & Timeline Tool Execution Panels', () => {
    it('formats duration correctly for various execution times', () => {
      expect(formatToolDuration(42, 'completed')).toBe('42ms');
      expect(formatToolDuration(1500, 'completed')).toBe('1500ms');
      expect(formatToolDuration(undefined, 'running')).toBe('running...');
      expect(formatToolDuration(undefined, 'unknown')).toBe('結果未知');
    });

    it('renders ToolStepCard with running status badge and animated spinner', () => {
      const item: Extract<ChatItem, { kind: 'tool_call' }> = {
        id: 'tool-run',
        kind: 'tool_call',
        timestamp: '2026-08-07T00:00:00.000Z',
        name: 'bash',
        summary: 'npm run build',
        status: 'running',
      };

      const html = renderToStaticMarkup(<ToolStepCard item={item} />);
      expect(html).toContain('class="card tool-card tool-running"');
      expect(html).toContain('class="tool-status tool-status-running"');
      expect(html).toContain('class="tool-spinner"');
      expect(html).toContain('Running');
      expect(html).toContain('npm run build');
    });

    it('renders ToolStepCard with completed/success status and output', () => {
      const item: Extract<ChatItem, { kind: 'tool_call' }> = {
        id: 'tool-ok',
        kind: 'tool_call',
        timestamp: '2026-08-07T00:00:00.000Z',
        name: 'write_file',
        summary: 'src/index.ts',
        status: 'completed',
        durationMs: 120,
        output: 'Wrote 520 bytes',
      };

      const html = renderToStaticMarkup(<ToolStepCard item={item} />);
      expect(html).toContain('class="card tool-card tool-completed"');
      expect(html).toContain('Success');
      expect(html).toContain('120ms');
      expect(html).toContain('Wrote 520 bytes');
    });

    it('renders ToolStepCard with error status and error output', () => {
      const item: Extract<ChatItem, { kind: 'tool_call' }> = {
        id: 'tool-err',
        kind: 'tool_call',
        timestamp: '2026-08-07T00:00:00.000Z',
        name: 'grep_search',
        summary: 'invalid regex (',
        status: 'error',
        durationMs: 15,
        output: 'Regex parse error',
      };

      const html = renderToStaticMarkup(<ToolStepCard item={item} />);
      expect(html).toContain('class="card tool-card tool-error"');
      expect(html).toContain('Error');
      expect(html).toContain('Regex parse error');
    });

    it('renders ToolStepCard with unknown status', () => {
      const item: Extract<ChatItem, { kind: 'tool_call' }> = {
        id: 'tool-unk',
        kind: 'tool_call',
        timestamp: '2026-08-07T00:00:00.000Z',
        name: 'terminal_cmd',
        summary: 'aborted process',
        status: 'unknown',
      };

      const html = renderToStaticMarkup(<ToolStepCard item={item} />);
      expect(html).toContain('class="card tool-card tool-unknown"');
      expect(html).toContain('結果未知');
    });
  });

  describe('Agent Thoughts & Collapsible Thinking Cards', () => {
    it('parses <think> tags from assistant text into thoughts and main answer', () => {
      const input = '<think>\nFirst, let us analyze the code structure.\nThen check tests.\n</think>\n\nHere is the resolution.';
      const parsed = parseAssistantText(input);

      expect(parsed.thoughts).toHaveLength(1);
      expect(parsed.thoughts[0]).toContain('First, let us analyze');
      expect(parsed.mainText).toBe('Here is the resolution.');
    });

    it('renders collapsible thinking card when assistant text contains <think> block', () => {
      const input = '<think>Checking dependencies...</think>\nAll packages are up to date.';
      const html = renderToStaticMarkup(<AssistantMarkdown>{input}</AssistantMarkdown>);

      expect(html).toContain('class="card thinking-card"');
      expect(html).toContain('Thought Process');
      expect(html).toContain('Checking dependencies...');
      expect(html).toContain('All packages are up to date.');
    });

    it('renders animated pulse indicator when thinking card is streaming', () => {
      const input = '<think>Currently reasoning...</think>';
      const html = renderToStaticMarkup(
        <AssistantMarkdown streaming>{input}</AssistantMarkdown>,
      );

      expect(html).toContain('class="card thinking-card"');
      expect(html).toContain('class="thinking-pulse"');
    });
  });

  describe('User vs Agent Role Distinctions & Indicators', () => {
    it('renders distinct role badges for User vs Agent messages', () => {
      const items: ChatItem[] = [
        {
          id: 'u1',
          kind: 'message',
          timestamp: '2026-08-07T00:00:00.000Z',
          role: 'user',
          text: 'What is the project status?',
        },
        {
          id: 'a1',
          kind: 'message',
          timestamp: '2026-08-07T00:00:00.000Z',
          role: 'assistant',
          text: 'Project is active.',
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('msg-role-badge-user');
      expect(html).toContain('👤 You');
      expect(html).toContain('msg-role-badge-assistant');
      expect(html).toContain('🤖 Agent');
    });

    it('renders animated typing dots when assistant message is streaming', () => {
      const items: ChatItem[] = [
        {
          id: 'a-stream',
          kind: 'message',
          timestamp: '2026-08-07T00:00:00.000Z',
          role: 'assistant',
          text: 'Typing response...',
          streaming: true,
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('agent-typing-indicator');
      expect(html).toContain('class="typing-dot"');
      expect(html).toContain('class="caret"');
    });
  });

  describe('Markdown Hardening & Layout Guards', () => {
    it('automatically closes unclosed display math at EOF to prevent layout breakdown', () => {
      const unclosedMath = 'The equation is:\n$$\n\\int_0^\\infty e^{-x} dx';
      const normalized = normalizeHackmdDisplayMath(unclosedMath);
      expect(normalized.endsWith('$$')).toBe(true);

      const html = renderToStaticMarkup(<AssistantMarkdown>{unclosedMath}</AssistantMarkdown>);
      expect(html).toContain('The equation is:');
    });

    it('automatically closes unclosed code fence at EOF to prevent layout leaking', () => {
      const unclosedCode = 'Here is snippet:\n```js\nconsole.log("hello");';
      const normalized = normalizeHackmdDisplayMath(unclosedCode);
      expect(normalized.endsWith('```')).toBe(true);

      const html = renderToStaticMarkup(<AssistantMarkdown>{unclosedCode}</AssistantMarkdown>);
      expect(html).toContain('language-js');
    });

    it('renders invalid math syntax without crashing React using KaTeX error fallback', () => {
      const invalidMath = 'Bad math formula: $$\\invalidCommandName{foo}$$';
      expect(() => {
        renderToStaticMarkup(<AssistantMarkdown>{invalidMath}</AssistantMarkdown>);
      }).not.toThrow();
    });

    it('renders malformed HTML tags safely without crashing', () => {
      const malformedHtml = 'Safe markdown with <div class="unclosed" attr=test>text';
      expect(() => {
        renderToStaticMarkup(<AssistantMarkdown>{malformedHtml}</AssistantMarkdown>);
      }).not.toThrow();
    });
  });
});
