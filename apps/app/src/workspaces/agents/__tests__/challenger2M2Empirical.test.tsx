import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatItem, ToolCallItem } from '@cozypad/contracts';
import { ChatTimeline, ToolStepCard, formatToolDuration } from '../ChatTimeline';

describe('Challenger 2 M2 Empirical Verification Suite - Tool Execution Timeline & Timer Logic', () => {
  const dummyProps = {
    sessionId: 'session-challenger-2-m2',
    onResolveApproval: vi.fn(),
    onAnswerQuestion: vi.fn(),
    onDeclineQuestion: vi.fn(),
  };

  describe('1. Tool execution duration formatting edge cases', () => {
    it('formats 0ms duration correctly', () => {
      expect(formatToolDuration(0, 'completed')).toBe('0ms');
      expect(formatToolDuration(0, 'running')).toBe('0ms');
    });

    it('formats sub-second duration (450ms) correctly', () => {
      expect(formatToolDuration(450, 'completed')).toBe('450ms');
    });

    it('formats multi-second durations (1200ms = 1.2s, 65400ms = 65.4s, 3600000ms = 3600s)', () => {
      expect(formatToolDuration(1200, 'completed')).toBe('1200ms');
      expect(formatToolDuration(65400, 'completed')).toBe('65400ms');
      expect(formatToolDuration(3600000, 'completed')).toBe('3600000ms');
    });

    it('formats negative duration values safely without crashing', () => {
      expect(formatToolDuration(-100, 'completed')).toBe('-100ms');
      expect(formatToolDuration(-1, 'running')).toBe('-1ms');
    });

    it('formats undefined duration timestamps based on execution status', () => {
      expect(formatToolDuration(undefined, 'running')).toBe('running...');
      expect(formatToolDuration(undefined, 'unknown')).toBe('結果未知');
      expect(formatToolDuration(undefined, 'completed')).toBe('');
      expect(formatToolDuration(undefined, 'error')).toBe('');
      expect(formatToolDuration(undefined, undefined)).toBe('');
    });
  });

  describe('2. Tool card step expansion/collapse toggles & default states', () => {
    it('defaults running tool cards to open (expanded)', () => {
      const item: ToolCallItem = {
        id: 'tool-run-1',
        kind: 'tool_call',
        timestamp: '2026-08-07T00:00:00.000Z',
        name: 'run_command',
        summary: 'pnpm test',
        status: 'running',
      };
      const html = renderToStaticMarkup(<ToolStepCard item={item} />);
      expect(html).toContain('<details class="card tool-card tool-running" open=""');
    });

    it('defaults error tool cards to open (expanded)', () => {
      const item: ToolCallItem = {
        id: 'tool-err-1',
        kind: 'tool_call',
        timestamp: '2026-08-07T00:00:00.000Z',
        name: 'run_command',
        summary: 'invalid command',
        status: 'error',
        output: 'Command failed with code 1',
      };
      const html = renderToStaticMarkup(<ToolStepCard item={item} />);
      expect(html).toContain('<details class="card tool-card tool-error" open=""');
    });

    it('defaults completed tool cards to closed (collapsed)', () => {
      const item: ToolCallItem = {
        id: 'tool-completed-1',
        kind: 'tool_call',
        timestamp: '2026-08-07T00:00:00.000Z',
        name: 'read_file',
        summary: 'package.json',
        status: 'completed',
        durationMs: 15,
        output: 'file content',
      };
      const html = renderToStaticMarkup(<ToolStepCard item={item} />);
      expect(html).toContain('<details class="card tool-card tool-completed"');
      expect(html).not.toContain('open=""');
    });

    it('respects defaultExpanded prop override when set explicitly to true or false', () => {
      const itemCompleted: ToolCallItem = {
        id: 'tool-completed-override',
        kind: 'tool_call',
        timestamp: '2026-08-07T00:00:00.000Z',
        name: 'read_file',
        summary: 'src/main.ts',
        status: 'completed',
        output: 'done',
      };
      const htmlForceOpen = renderToStaticMarkup(
        <ToolStepCard item={itemCompleted} defaultExpanded={true} />,
      );
      expect(htmlForceOpen).toContain('<details class="card tool-card tool-completed" open=""');

      const itemRunning: ToolCallItem = {
        id: 'tool-running-override',
        kind: 'tool_call',
        timestamp: '2026-08-07T00:00:00.000Z',
        name: 'run_command',
        summary: 'long process',
        status: 'running',
      };
      const htmlForceClose = renderToStaticMarkup(
        <ToolStepCard item={itemRunning} defaultExpanded={false} />,
      );
      expect(htmlForceClose).toContain('<details class="card tool-card tool-running"');
      expect(htmlForceClose).not.toContain('open=""');
    });

    it('renders non-collapsible card when isCollapsible is false', () => {
      const item: ToolCallItem = {
        id: 'tool-non-col',
        kind: 'tool_call',
        timestamp: '2026-08-07T00:00:00.000Z',
        name: 'grep_search',
        summary: 'find pattern',
        status: 'completed',
      };
      const html = renderToStaticMarkup(<ToolStepCard item={item} isCollapsible={false} />);
      expect(html).toContain('<div class="card tool-card tool-completed"');
      expect(html).not.toContain('<details');
      expect(html).not.toContain('tool-chevron');
    });
  });

  describe('3. Multi-step tool call lists in ChatTimeline', () => {
    it('renders sequence of multi-step tool calls with mixed states and outputs', () => {
      const items: ChatItem[] = [
        {
          id: 'step-1',
          kind: 'tool_call',
          timestamp: '2026-08-07T00:00:00.000Z',
          name: 'grep_search',
          summary: 'search for main',
          status: 'completed',
          durationMs: 120,
          output: 'Found 3 matches',
        },
        {
          id: 'step-2',
          kind: 'tool_call',
          timestamp: '2026-08-07T00:00:01.000Z',
          name: 'view_file',
          summary: 'src/main.ts',
          status: 'completed',
          durationMs: 45,
          output: 'const x = 1;',
        },
        {
          id: 'step-3',
          kind: 'tool_call',
          timestamp: '2026-08-07T00:00:02.000Z',
          name: 'run_command',
          summary: 'pnpm test',
          status: 'error',
          durationMs: 2300,
          output: '1 test failed',
        },
        {
          id: 'step-4',
          kind: 'tool_call',
          timestamp: '2026-08-07T00:00:05.000Z',
          name: 'replace_file_content',
          summary: 'fix bug in src/main.ts',
          status: 'running',
        },
      ];

      const html = renderToStaticMarkup(<ChatTimeline {...dummyProps} items={items} />);

      // Verify all 4 tool step cards are rendered in order
      expect(html).toContain('grep_search');
      expect(html).toContain('view_file');
      expect(html).toContain('run_command');
      expect(html).toContain('replace_file_content');

      // Verify status classes and badges
      expect(html).toContain('tool-status-completed');
      expect(html).toContain('tool-status-error');
      expect(html).toContain('tool-status-running');

      // Verify outputs are rendered inside tool-output pre tags
      expect(html).toContain('Found 3 matches');
      expect(html).toContain('const x = 1;');
      expect(html).toContain('1 test failed');
    });
  });
});
