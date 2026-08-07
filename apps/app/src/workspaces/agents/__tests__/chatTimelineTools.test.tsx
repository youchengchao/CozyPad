import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatItem } from '@cozypad/contracts';
import { ChatTimeline } from '../ChatTimeline';

describe('ChatTimeline & Tool Execution Cards Suite', () => {
  beforeAll(() => {
    (globalThis as any).window = (globalThis as any).window || {
      cozypad: {
        fsReadBytes: vi.fn().mockResolvedValue({ dataBase64: '' }),
      },
    };
  });

  const dummyProps = {
    sessionId: 'session-test-1',
    onResolveApproval: vi.fn(),
    onAnswerQuestion: vi.fn(),
    onDeclineQuestion: vi.fn(),
  };

  describe('User & Assistant Message Cards', () => {
    it('renders user text message correctly', () => {
      const items: ChatItem[] = [
        {
          id: 'msg-1',
          kind: 'message',
          timestamp: '2026-08-07T00:00:00.000Z',
          role: 'user',
          text: 'Hello CozyPad Agent!',
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('class="msg msg-user"');
      expect(html).toContain('Hello CozyPad Agent!');
    });

    it('renders assistant markdown message with streaming caret', () => {
      const items: ChatItem[] = [
        {
          id: 'msg-2',
          kind: 'message',
          timestamp: '2026-08-07T00:00:00.000Z',
          role: 'assistant',
          text: 'Generating response **bold**...',
          streaming: true,
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('class="msg msg-assistant msg-streaming"');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('class="caret"');
    });

    it('renders interrupted assistant message tag', () => {
      const items: ChatItem[] = [
        {
          id: 'msg-3',
          kind: 'message',
          timestamp: '2026-08-07T00:00:00.000Z',
          role: 'assistant',
          text: 'Aborted execution',
          streaming: false,
          interrupted: true,
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('class="msg-interrupted"');
      expect(html).toContain('已中斷');
    });
  });

  describe('Tool Call Execution Panels', () => {
    it('renders collapsible tool_call card with running status', () => {
      const items: ChatItem[] = [
        {
          id: 'tool-1',
          kind: 'tool_call',
          timestamp: '2026-08-07T00:00:00.000Z',
          name: 'bash',
          summary: 'git status',
          status: 'running',
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('class="card tool-card tool-running"');
      expect(html).toContain('class="tool-status tool-status-running"');
      expect(html).toContain('bash');
      expect(html).toContain('git status');
    });

    it('renders completed tool_call card with duration and output preview', () => {
      const items: ChatItem[] = [
        {
          id: 'tool-2',
          kind: 'tool_call',
          timestamp: '2026-08-07T00:00:00.000Z',
          name: 'read_file',
          summary: 'package.json',
          status: 'completed',
          durationMs: 42,
          output: '{"name": "cozypad"}',
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('class="card tool-card tool-completed"');
      expect(html).toContain('42ms');
      expect(html).toContain('cozypad');
      expect(html).toContain('class="tool-output"');
    });

    it('renders failed tool_call card', () => {
      const items: ChatItem[] = [
        {
          id: 'tool-3',
          kind: 'tool_call',
          timestamp: '2026-08-07T00:00:00.000Z',
          name: 'command',
          summary: 'cargo build',
          status: 'error',
          durationMs: 1500,
          output: 'error[E0425]: cannot find value `foo`',
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('class="card tool-card tool-error"');
      expect(html).toContain('1500ms');
      expect(html).toContain('error[E0425]');
    });
  });

  describe('Diff Cards & Inline Diff Interceptor', () => {
    it('renders file_diff card with line syntax highlighting', () => {
      const items: ChatItem[] = [
        {
          id: 'diff-1',
          kind: 'file_diff',
          timestamp: '2026-08-07T00:00:00.000Z',
          path: 'src/App.tsx',
          additions: 5,
          deletions: 2,
          diff: '@@ -10,2 +10,5 @@\n-old line\n+new line',
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('class="card diff-card"');
      expect(html).toContain('src/App.tsx');
      expect(html).toContain('+5');
      expect(html).toContain('−2');
      expect(html).toContain('class="diff-hunk"');
      expect(html).toContain('class="diff-del"');
      expect(html).toContain('class="diff-add"');
    });

    it('intercepts inline ```diff fences in assistant markdown into rich diff cards', () => {
      const items: ChatItem[] = [
        {
          id: 'msg-diff',
          kind: 'message',
          timestamp: '2026-08-07T00:00:00.000Z',
          role: 'assistant',
          text: 'Here is the patch:\n\n```diff\n@@ -1,3 +1,3 @@\n-const oldVal = 1;\n+const newVal = 2;\n```',
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('class="card diff-card"');
      expect(html).toContain('inline diff');
      expect(html).toContain('diff-del');
      expect(html).toContain('diff-add');
    });
  });

  describe('Approval & Question Interactive Cards', () => {
    it('renders pending approval card with action buttons', () => {
      const items: ChatItem[] = [
        {
          id: 'app-1',
          kind: 'approval',
          timestamp: '2026-08-07T00:00:00.000Z',
          riskSummary: 'High risk shell execution',
          command: 'rm -rf /tmp/scratch',
          cwd: '/workspace',
          machine: 'local-dev',
          resolution: 'pending',
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('class="card approval-card approval-pending"');
      expect(html).toContain('High risk shell execution');
      expect(html).toContain('rm -rf /tmp/scratch');
      expect(html).toContain('btn-allow');
      expect(html).toContain('btn-deny');
    });

    it('renders resolved approval card with chip status', () => {
      const items: ChatItem[] = [
        {
          id: 'app-2',
          kind: 'approval',
          timestamp: '2026-08-07T00:00:00.000Z',
          riskSummary: 'File write',
          command: 'touch test.txt',
          cwd: '/workspace',
          resolution: 'allowed',
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('chip chip-allowed');
      expect(html).toContain('Allowed');
      expect(html).not.toContain('btn-allow');
    });

    it('renders interactive question card with selectable options', () => {
      const items: ChatItem[] = [
        {
          id: 'q-1',
          kind: 'question',
          timestamp: '2026-08-07T00:00:00.000Z',
          prompt: 'Which framework should we use?',
          options: [
            { label: 'React', description: 'Popular UI library' },
            { label: 'Vue', description: 'Progressive framework' },
          ],
          selectedIndex: 0,
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('Which framework should we use?');
      expect(html).toContain('question-option question-option-chosen');
      expect(html).toContain('✓');
    });

    it('renders unrepresentable question fallback card with refuse option', () => {
      const items: ChatItem[] = [
        {
          id: 'q-unrep',
          kind: 'question',
          timestamp: '2026-08-07T00:00:00.000Z',
          prompt: 'Complex custom wizard payload',
          options: [],
          selectedIndex: null,
          unrepresentable: true,
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('question-unrepresentable');
      expect(html).toContain('CozyPad 尚無法呈現這種題型');
      expect(html).toContain('拒絕整個詢問');
    });
  });

  describe('Notice & Usage Cards', () => {
    it('renders timeline notice divider', () => {
      const items: ChatItem[] = [
        {
          id: 'n-1',
          kind: 'notice',
          timestamp: '2026-08-07T00:00:00.000Z',
          text: 'Agent session restarted',
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('class="timeline-notice"');
      expect(html).toContain('role="note"');
      expect(html).toContain('Agent session restarted');
    });

    it('renders token usage indicator row', () => {
      const items: ChatItem[] = [
        {
          id: 'u-1',
          kind: 'usage',
          timestamp: '2026-08-07T00:00:00.000Z',
          inputTokens: 1250,
          outputTokens: 450,
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);
      expect(html).toContain('class="usage-row"');
      expect(html).toContain('1,250');
      expect(html).toContain('450');
    });
  });
});
