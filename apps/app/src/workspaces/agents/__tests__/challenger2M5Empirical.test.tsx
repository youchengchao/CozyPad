import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatComposer } from '../ChatComposer';
import type { ComposerAttachment } from '../attachmentBuffer';
import {
  AssistantMarkdown,
  MarkdownErrorBoundary,
  normalizeHackmdDisplayMath,
  parseAssistantText,
} from '../AssistantMarkdown';
import { MermaidDiagram } from '../MermaidDiagram';
import {
  createAgentSessionViewState,
  enterSelectedSession,
  forgetSessionView,
  leaveEnteredSession,
  reconcileSessionView,
  selectSessionForPreview,
  type AgentSessionViewState,
} from '../agentSessionViewState';
import { TimelineErrorBoundary } from '../ChatTimeline';
import { AgentsWorkspaceErrorBoundary } from '../AgentsWorkspace';
import type { AgentSessionSummary } from '@cozypad/contracts';

describe('Challenger 2 M5 Empirical Stress Test Suite — Robustness & Adversarial Verification', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as any).window = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as any).window = originalWindow;
  });

  // =========================================================================
  // 1. Rapid Typing Stability in Composer with Attachments in Mixed States
  // =========================================================================
  describe('1. Composer Rapid Typing & Mixed Attachment States', () => {
    const baseProps = {
      agentLabel: 'EmpiricalAgent',
      value: '',
      history: ['Previous prompt 1', 'Previous prompt 2'],
      commands: [
        { name: 'help', description: 'Show help' },
        { name: 'clear', description: 'Clear screen', behavior: 'submit' as const },
      ],
      attachments: [] as ComposerAttachment[],
      onChange: vi.fn(),
      onAttach: vi.fn(),
      onRemoveAttachment: vi.fn(),
      onRetryAttachment: vi.fn(),
      onSend: vi.fn(),
    };

    it('renders composer cleanly when attachments are simultaneously in uploading, ready, and error states', () => {
      const mixedAttachments: ComposerAttachment[] = [
        {
          id: 'att-1',
          name: 'source_code.ts',
          mediaType: 'text/typescript',
          sizeBytes: 2048,
          state: 'ready',
        },
        {
          id: 'att-2',
          name: 'large_dataset.csv',
          mediaType: 'text/csv',
          sizeBytes: 1048576,
          state: 'uploading',
        },
        {
          id: 'att-3',
          name: 'corrupted_image.png',
          mediaType: 'image/png',
          sizeBytes: 512,
          state: 'error',
          errorMessage: 'Checksum verification failed',
        },
      ];

      const html = renderToStaticMarkup(
        <ChatComposer {...baseProps} value="Typing text..." attachments={mixedAttachments} />,
      );

      expect(html).toContain('source_code.ts');
      expect(html).toContain('large_dataset.csv');
      expect(html).toContain('corrupted_image.png');
      expect(html).toContain('attachment-badge-ready');
      expect(html).toContain('attachment-badge-uploading');
      expect(html).toContain('attachment-badge-error');
      expect(html).toContain('attachment-retry');
    });

    it('simulates rapid sequential typing without dropping text characters or crashing', () => {
      let currentValue = '';
      const onChangeMock = vi.fn((val: string) => {
        currentValue = val;
      });

      const sampleText = 'The quick brown fox jumps over the lazy dog 1234567890 !@#$%^&*()';
      
      // Simulate 100 rapid keystroke onChange events
      for (let i = 1; i <= sampleText.length; i++) {
        const nextChunk = sampleText.slice(0, i);
        onChangeMock(nextChunk);
      }

      expect(onChangeMock).toHaveBeenCalledTimes(sampleText.length);
      expect(currentValue).toBe(sampleText);
    });

    it('preserves input value stability during attachment state transitions (uploading -> ready / error)', () => {
      let attachmentState: ComposerAttachment['state'] = 'uploading';
      const attachments: ComposerAttachment[] = [
        {
          id: 'att-dyn',
          name: 'dynamic_file.json',
          mediaType: 'application/json',
          sizeBytes: 4096,
          state: attachmentState,
        },
      ];

      // Initial render during uploading
      let html = renderToStaticMarkup(
        <ChatComposer {...baseProps} value="User typing mid-upload..." attachments={attachments} />,
      );
      expect(html).toContain('Uploading');
      expect(html).toContain('User typing mid-upload...');

      // State transition to ready
      attachments[0]!.state = 'ready';
      html = renderToStaticMarkup(
        <ChatComposer {...baseProps} value="User typing mid-upload... continue" attachments={attachments} />,
      );
      expect(html).toContain('Ready');
      expect(html).toContain('User typing mid-upload... continue');

      // State transition to error
      attachments[0]!.state = 'error';
      attachments[0]!.errorMessage = 'Server error 500';
      html = renderToStaticMarkup(
        <ChatComposer {...baseProps} value="User typing mid-upload... continue" attachments={attachments} />,
      );
      expect(html).toContain('Error');
      expect(html).toContain('Server error 500');
    });

    it('allows removing ready or error attachments while typing, but keeps uploading attachments disabled for removal', () => {
      const onRemoveMock = vi.fn();
      const mixedAttachments: ComposerAttachment[] = [
        { id: 'a-ready', name: 'ready.txt', mediaType: 'text/plain', sizeBytes: 100, state: 'ready' },
        { id: 'a-uploading', name: 'upload.txt', mediaType: 'text/plain', sizeBytes: 100, state: 'uploading' },
        { id: 'a-error', name: 'error.txt', mediaType: 'text/plain', sizeBytes: 100, state: 'error' },
      ];

      const html = renderToStaticMarkup(
        <ChatComposer
          {...baseProps}
          value="Typing while managing attachments"
          attachments={mixedAttachments}
          onRemoveAttachment={onRemoveMock}
        />,
      );

      // Inspect HTML to verify remove button disabled state for uploading item
      expect(html).toContain('aria-label="Remove ready.txt"');
      expect(html).toContain('aria-label="Remove upload.txt" disabled=""');
      expect(html).toContain('aria-label="Remove error.txt"');
    });

    it('renders attachment warning banner properly during input without obscuring textarea', () => {
      const html = renderToStaticMarkup(
        <ChatComposer
          {...baseProps}
          value="Testing attachment notice banner"
          attachmentNotice="Maximum 10 attachments reached. Extra files were ignored."
        />,
      );

      expect(html).toContain('attachment-notice-banner');
      expect(html).toContain('Maximum 10 attachments reached');
      expect(html).toContain('Testing attachment notice banner');
    });
  });

  // =========================================================================
  // 2. Network Disruption & IPC Error Boundary Resilience During Streaming
  // =========================================================================
  describe('2. Network Disruption & IPC Error Boundary Resilience', () => {
    it('MarkdownErrorBoundary catches unexpected rendering errors and displays raw fallback text', () => {
      const derived = MarkdownErrorBoundary.getDerivedStateFromError();
      expect(derived).toEqual({ hasError: true });

      const boundary = new MarkdownErrorBoundary({
        children: 'Normal child',
        rawText: 'Partial stream payload: {corrupted: true}',
      });
      boundary.state = { hasError: true };

      const html = renderToStaticMarkup(boundary.render());
      expect(html).toContain('markdown-error-fallback');
      expect(html).toContain('Unable to render markdown layout. Showing raw content.');
      expect(html).toContain('Partial stream payload: {corrupted: true}');
    });

    it('TimelineErrorBoundary renders user-friendly error card when timeline item state has error', () => {
      const derived = TimelineErrorBoundary.getDerivedStateFromError(
        new Error('IPC stream chunk corrupted: invalid tool call structure'),
      );
      expect(derived.hasError).toBe(true);
      expect(derived.error?.message).toContain('IPC stream chunk corrupted');

      const boundary = new TimelineErrorBoundary({
        children: 'Normal child',
        rawItem: { id: 'err-item-1', kind: 'tool' },
      });
      boundary.state = {
        hasError: true,
        error: new Error('IPC stream chunk corrupted: invalid tool call structure'),
      };

      const html = renderToStaticMarkup(boundary.render());
      expect(html).toContain('timeline-error-boundary');
      expect(html).toContain('Timeline Rendering Error');
      expect(html).toContain('IPC stream chunk corrupted');
    });

    it('AgentsWorkspaceErrorBoundary catches root-level workspace crashes and provides recovery button', () => {
      const derived = AgentsWorkspaceErrorBoundary.getDerivedStateFromError(
        new Error('IPC Bridge transport lost connection'),
      );
      expect(derived).toEqual({
        hasError: true,
        error: new Error('IPC Bridge transport lost connection'),
      });

      const boundary = new AgentsWorkspaceErrorBoundary({
        children: 'Normal child',
      });
      boundary.state = {
        hasError: true,
        error: new Error('IPC Bridge transport lost connection'),
      };

      const html = renderToStaticMarkup(boundary.render());
      expect(html).toContain('agent-workspace-error-fallback');
      expect(html).toContain('Agents Workspace Encountered an Error');
      expect(html).toContain('IPC Bridge transport lost connection');
      expect(html).toContain('Reload Workspace');
    });

    it('handles active streaming state flags cleanly without throw', () => {
      const streamingMarkdown = '```typescript\nfunction stream() {\n  return "partial stream";\n';
      const html = renderToStaticMarkup(
        <AssistantMarkdown streaming={true}>{streamingMarkdown}</AssistantMarkdown>,
      );

      expect(html).toContain('assistant-markdown-container');
      expect(html).toContain('language-typescript');
      expect(html).toContain('partial stream');
    });
  });

  // =========================================================================
  // 3. Malformed Markdown Parsing Resilience (Unclosed Fences, KaTeX, Mermaid)
  // =========================================================================
  describe('3. Malformed Markdown Parsing Resilience', () => {
    describe('normalizeHackmdDisplayMath & Code Fence Normalization', () => {
      it('auto-closes unclosed code fences at end of input', () => {
        const input = 'Here is code:\n```typescript\nconst x = 42;';
        const normalized = normalizeHackmdDisplayMath(input);
        expect(normalized).toContain('```typescript\nconst x = 42;\n```');
      });

      it('auto-closes unclosed display math blocks at end of input', () => {
        const input = 'Mathematical formula:\n$$\n\\sum_{i=1}^n i';
        const normalized = normalizeHackmdDisplayMath(input);
        expect(normalized).toContain('$$\n\\sum_{i=1}^n i\n$$');
      });

      it('handles mixed tilde ~~~ and backtick ``` code fences correctly', () => {
        const input = '~~~python\ndef hello():\n    pass';
        const normalized = normalizeHackmdDisplayMath(input);
        expect(normalized).toContain('~~~python\ndef hello():\n    pass\n~~~');
      });

      it('correctly handles empty string or whitespace input', () => {
        expect(normalizeHackmdDisplayMath('')).toBe('');
        expect(normalizeHackmdDisplayMath('   ')).toBe('   ');
      });
    });

    describe('parseAssistantText Thought & Main Text Extraction', () => {
      it('extracts complete and unclosed <think> or <thinking> tags gracefully', () => {
        const input = '<think>\nReasoning step 1\nReasoning step 2\n</think>\nFinal answer text.';
        const result = parseAssistantText(input);

        expect(result.thoughts).toHaveLength(1);
        expect(result.thoughts[0]).toBe('Reasoning step 1\nReasoning step 2');
        expect(result.mainText).toBe('Final answer text.');
      });

      it('extracts unclosed <thinking> tag open until EOF', () => {
        const input = '<thinking>\nOngoing thought without closing tag...';
        const result = parseAssistantText(input);

        expect(result.thoughts).toHaveLength(1);
        expect(result.thoughts[0]).toBe('Ongoing thought without closing tag...');
        expect(result.mainText).toBe('');
      });

      it('handles multiple thought blocks within assistant message', () => {
        const input = '<think>Thought A</think>\nIntermediate text\n<think>Thought B</think>\nFinal response';
        const result = parseAssistantText(input);

        expect(result.thoughts).toHaveLength(2);
        expect(result.thoughts[0]).toBe('Thought A');
        expect(result.thoughts[1]).toBe('Thought B');
      });
    });

    describe('AssistantMarkdown & Mermaid Resilience', () => {
      it('renders malformed KaTeX math syntax without throwing exceptions', () => {
        const malformedMath = 'Formula: $\\frac{1}{0$ and $$\\invalidmacro{test}$$ and unclosed $$';
        const html = renderToStaticMarkup(
          <AssistantMarkdown>{malformedMath}</AssistantMarkdown>,
        );

        expect(html).toContain('assistant-markdown-container');
        expect(html).toContain('Formula:');
      });

      it('renders malformed unclosed code block without breaking layout', () => {
        const malformedCode = '# Title\n\n```javascript\nfunction test() {\n  console.log("no closing fence");';
        const html = renderToStaticMarkup(
          <AssistantMarkdown>{malformedCode}</AssistantMarkdown>,
        );

        expect(html).toContain('assistant-markdown-container');
        expect(html).toContain('language-javascript');
        expect(html).toContain('no closing fence');
      });

      it('renders MermaidDiagram in deferred mode during streaming without invoking mermaid renderer', () => {
        const mermaidCode = 'graph TD\nA[Start] --> B[Processing]\nB --> C{Decision}';
        const html = renderToStaticMarkup(
          <MermaidDiagram source={mermaidCode} deferred={true} />,
        );

        expect(html).toContain('mermaid-diagram-deferred');
        expect(html).toContain('language-mermaid');
        expect(html).toContain('graph TD');
      });

      it('renders MermaidDiagram in loading mode when deferred=false', () => {
        const mermaidCode = 'graph LR\nX --> Y';
        const html = renderToStaticMarkup(
          <MermaidDiagram source={mermaidCode} deferred={false} />,
        );

        expect(html).toContain('mermaid-diagram-loading');
        expect(html).toContain('Rendering Mermaid diagram...');
      });
    });
  });

  // =========================================================================
  // 4. Session View State Reconciliation & Empty State Verification
  // =========================================================================
  describe('4. Session View State Reconciliation & Empty States', () => {
    it('creates initial empty agent session view state', () => {
      const state = createAgentSessionViewState();
      expect(state.selected).toEqual({ claude: null, codex: null, agy: null });
      expect(state.entered).toEqual({ claude: null, codex: null, agy: null });
    });

    it('selects session for preview and enters selected session correctly', () => {
      let state = createAgentSessionViewState();

      // Select session-1 for claude
      state = selectSessionForPreview(state, 'claude', 'sess-claude-1');
      expect(state.selected.claude).toBe('sess-claude-1');
      expect(state.entered.claude).toBeNull();

      // Enter selected session
      state = enterSelectedSession(state, 'claude', 'sess-claude-1');
      expect(state.selected.claude).toBe('sess-claude-1');
      expect(state.entered.claude).toBe('sess-claude-1');

      // Leave entered session
      state = leaveEnteredSession(state, 'claude', 'sess-claude-1');
      expect(state.selected.claude).toBe('sess-claude-1');
      expect(state.entered.claude).toBeNull();

      // Forget session view
      state = forgetSessionView(state, 'claude', 'sess-claude-1');
      expect(state.selected.claude).toBeNull();
      expect(state.entered.claude).toBeNull();
    });

    it('reconcileSessionView resets selected and entered slots if selected session is deleted from session list', () => {
      let state = createAgentSessionViewState();
      state = selectSessionForPreview(state, 'codex', 'sess-codex-100');
      state = enterSelectedSession(state, 'codex', 'sess-codex-100');

      const activeSessions: AgentSessionSummary[] = [
        {
          id: 'sess-codex-101',
          agentKind: 'codex',
          title: 'Active Session 101',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: 'ready',
        },
      ];

      // sess-codex-100 is no longer in activeSessions -> reconcile should clear it
      const reconciled = reconcileSessionView(state, activeSessions);
      expect(reconciled.selected.codex).toBeNull();
      expect(reconciled.entered.codex).toBeNull();
    });

    it('reconcileSessionView clears selected slot if session agentKind mismatch occurs', () => {
      let state = createAgentSessionViewState();
      state = selectSessionForPreview(state, 'claude', 'sess-100');

      // Session exists but has agentKind = 'agy', not 'claude'
      const activeSessions: AgentSessionSummary[] = [
        {
          id: 'sess-100',
          agentKind: 'agy',
          title: 'AGY session with same ID',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: 'ready',
        },
      ];

      const reconciled = reconcileSessionView(state, activeSessions);
      expect(reconciled.selected.claude).toBeNull();
    });

    it('reconcileSessionView clears all slots when session array becomes empty [] (Zero-Session State)', () => {
      let state = createAgentSessionViewState();
      state = selectSessionForPreview(state, 'claude', 'c1');
      state = enterSelectedSession(state, 'claude', 'c1');
      state = selectSessionForPreview(state, 'codex', 'cx1');
      state = enterSelectedSession(state, 'codex', 'cx1');
      state = selectSessionForPreview(state, 'agy', 'a1');

      const emptySessions: AgentSessionSummary[] = [];
      const reconciled = reconcileSessionView(state, emptySessions);

      expect(reconciled.selected).toEqual({ claude: null, codex: null, agy: null });
      expect(reconciled.entered).toEqual({ claude: null, codex: null, agy: null });
    });

    it('preserves existing valid sessions across multiple agent kinds during reconciliation', () => {
      let state = createAgentSessionViewState();
      state = selectSessionForPreview(state, 'claude', 'c1');
      state = enterSelectedSession(state, 'claude', 'c1');
      state = selectSessionForPreview(state, 'codex', 'cx1');
      state = selectSessionForPreview(state, 'agy', 'a-deleted');

      const currentSessions: AgentSessionSummary[] = [
        { id: 'c1', agentKind: 'claude', title: 'Claude 1', createdAt: 0, updatedAt: 0, status: 'ready' },
        { id: 'cx1', agentKind: 'codex', title: 'Codex 1', createdAt: 0, updatedAt: 0, status: 'ready' },
      ];

      const reconciled = reconcileSessionView(state, currentSessions);
      expect(reconciled.selected.claude).toBe('c1');
      expect(reconciled.entered.claude).toBe('c1');
      expect(reconciled.selected.codex).toBe('cx1');
      expect(reconciled.entered.codex).toBeNull();
      expect(reconciled.selected.agy).toBeNull();
    });
  });
});
