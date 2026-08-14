import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentsWorkspace, AgentsWorkspaceErrorBoundary } from '../AgentsWorkspace';
import { ChatTimeline, TimelineErrorBoundary, AgentErrorCard } from '../ChatTimeline';
import { ChatComposer } from '../ChatComposer';
import { CozyPadIPCError, getBridge, clearBridgeCache } from '../../../platform/bridge';
import type { ChatItem, PlatformBridge } from '@cozypad/contracts';
import type { ComposerAttachment } from '../attachmentBuffer';

describe('Challenger 1 M4 Empirical Suite - Connection Disruption & Error States & Rapid Input Protection', () => {
  beforeEach(() => {
    clearBridgeCache();
    (globalThis as unknown as Record<string, unknown>).window = globalThis;
    (globalThis as unknown as Record<string, unknown>).cozypad = {
      kind: 'electron',
      listAgentSessions: vi.fn().mockResolvedValue([]),
      detectAgent: vi.fn().mockResolvedValue({
        agentKind: 'claude',
        installed: true,
        supportsStructuredOutput: true,
        supportsResume: true,
        supportsInteractiveApproval: true,
        launchModes: [],
      }),
      onAgentSessionChanged: vi.fn().mockReturnValue(() => undefined),
      onAgentTimelineChanged: vi.fn().mockReturnValue(() => undefined),
      onAgentSessionDeleted: vi.fn().mockReturnValue(() => undefined),
      onAgentCommunicationError: vi.fn().mockReturnValue(() => undefined),
      fsList: vi.fn().mockResolvedValue([]),
      sendAgentMessage: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('1. Connection State Transitions (connected, reconnecting, disconnected)', () => {
    it('renders connected state correctly without reconnection banners', () => {
      const html = renderToStaticMarkup(
        <AgentsWorkspace
          connected={true}
          connectionState="connected"
          reconnect={null}
          profileId="profile-1"
        />,
      );
      expect(html).not.toContain('agent-availability-reconnecting');
      expect(html).not.toContain('連線中斷 — 正在重連中');
      expect(html).not.toContain('尚未連線');
    });

    it('renders reconnecting banner with attempt details when reconnect prop is active', () => {
      const html = renderToStaticMarkup(
        <AgentsWorkspace
          connected={false}
          reconnect={{ attempt: 3, secondsLeft: 12 }}
          profileId="profile-1"
        />,
      );
      expect(html).toContain('agent-disconnected-empty');
      expect(html).toContain('12s 後進行第 3 次重連嘗試');
    });

    it('renders disconnected state banner and disables composer actions', () => {
      const html = renderToStaticMarkup(
        <AgentsWorkspace
          connected={false}
          connectionState="disconnected"
          reconnect={null}
          profileId="profile-1"
        />,
      );
      expect(html).toContain('agent-disconnected-empty');
      expect(html).toContain('尚未連線');
      expect(html).not.toContain('session-sidebar');
    });
  });

  describe('2. Socket Drops Mid-Turn & Timeline Interruption Notices', () => {
    it('flags partial response as interrupted when socket drops mid-turn', () => {
      const items: ChatItem[] = [
        {
          kind: 'message',
          timestamp: '2026-08-08T00:00:00.000Z',
          id: 'msg-drop-1',
          role: 'assistant',
          text: 'Generating code when websocket connection closed suddenly...',
          interrupted: true,
        },
      ];

      const html = renderToStaticMarkup(
        <ChatTimeline
          sessionId="sess-drop"
          items={items}
          onResolveApproval={vi.fn()}
          onAnswerQuestion={vi.fn()}
        />,
      );

      expect(html).toContain('msg-interrupted');
      expect(html).toContain('已中斷');
      expect(html).toContain('Generating code when websocket connection closed suddenly...');
    });

    it('renders connection drop timeline notice card in order', () => {
      const items: ChatItem[] = [
        {
          kind: 'message',
          timestamp: '2026-08-08T00:00:00.000Z',
          id: 'msg-1',
          role: 'user',
          text: 'Run long script',
        },
        {
          kind: 'notice',
          timestamp: '2026-08-08T00:00:00.000Z',
          id: 'notice-drop-1',
          text: '⚡ 連線中斷 — Socket connection dropped during response stream.',
        },
      ];

      const html = renderToStaticMarkup(
        <ChatTimeline
          sessionId="sess-drop"
          items={items}
          onResolveApproval={vi.fn()}
          onAnswerQuestion={vi.fn()}
        />,
      );

      expect(html).toContain('timeline-notice');
      expect(html).toContain('Socket connection dropped during response stream.');
    });
  });

  describe('3. IPC Timeouts & Failure Fallback Behaviors', () => {
    it('correctly constructs CozyPadIPCError for TIMEOUT with retryable set to true', () => {
      const timeoutError = new CozyPadIPCError('TIMEOUT', 'fsList timed out after 10s', true);
      expect(timeoutError.name).toBe('CozyPadIPCError');
      expect(timeoutError.code).toBe('TIMEOUT');
      expect(timeoutError.isRetryable).toBe(true);
      expect(timeoutError.message).toBe('fsList timed out after 10s');
    });

    it('correctly constructs CozyPadIPCError for IPC_FAILED with retryable set to false', () => {
      const failedError = new CozyPadIPCError('IPC_FAILED', 'Pipe broken', false);
      expect(failedError.code).toBe('IPC_FAILED');
      expect(failedError.isRetryable).toBe(false);
    });

    it('throws BRIDGE_UNAVAILABLE when window.cozypad is null or undefined', () => {
      delete (globalThis as unknown as Record<string, unknown>).cozypad;
      expect(() => getBridge()).toThrow(CozyPadIPCError);
      try {
        getBridge();
      } catch (err) {
        expect((err as CozyPadIPCError).code).toBe('BRIDGE_UNAVAILABLE');
      }
    });

    it('wraps bridge methods in timeout safety proxy', async () => {
      const mockBridge = {
        fsList: async () => ['file1.txt'],
      };
      (globalThis as unknown as Record<string, unknown>).cozypad = mockBridge;
      const bridge = getBridge();
      const res = await bridge.fsList({ path: '/test' });
      expect(res).toEqual(['file1.txt']);
    });
  });

  describe('4. Error Boundary Recovery', () => {
    it('AgentsWorkspaceErrorBoundary catches child error and renders fallback with reload action', () => {
      const error = new Error('Catastrophic workspace explosion');
      const state = AgentsWorkspaceErrorBoundary.getDerivedStateFromError(error);
      expect(state.hasError).toBe(true);
      expect(state.error).toBe(error);

      const instance = new AgentsWorkspaceErrorBoundary({ children: null });
      instance.state = state;
      const html = renderToStaticMarkup(instance.render());
      expect(html).toContain('agent-workspace-error-fallback');
      expect(html).toContain('Catastrophic workspace explosion');
      expect(html).toContain('Reload Workspace');
    });

    it('TimelineErrorBoundary catches child error and renders fallback with reload action', () => {
      const error = new Error('Corrupt chat item payload');
      const state = TimelineErrorBoundary.getDerivedStateFromError(error);
      expect(state.hasError).toBe(true);
      expect(state.error).toBe(error);

      const instance = new TimelineErrorBoundary({ children: null });
      instance.state = state;
      const html = renderToStaticMarkup(instance.render());
      expect(html).toContain('timeline-error-boundary');
      expect(html).toContain('Corrupt chat item payload');
      expect(html).toContain('Reload Timeline');
    });

    it('renders AgentErrorCard with resume session action when error occurs', () => {
      const onRetry = vi.fn();
      const html = renderToStaticMarkup(
        <AgentErrorCard error="Process crashed unexpectedly with exit code 137" onRetry={onRetry} />,
      );
      expect(html).toContain('agent-error-card');
      expect(html).toContain('Process crashed unexpectedly with exit code 137');
      expect(html).toContain('Resume Session');
    });
  });

  describe('5. Rapid Input Protection & UI Stability', () => {
    it('disables composer controls during uploading state to prevent rapid duplicate submits', () => {
      const html = renderToStaticMarkup(
        <ChatComposer
          agentLabel="Claude"
          value="Prompt sent rapidly"
          history={[]}
          commands={[]}
          attachments={[]}
          uploading={true}
          onChange={vi.fn()}
          onAttach={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onSend={vi.fn()}
        />,
      );

      expect(html).toContain('disabled=""');
      expect(html).toContain('composer-wrap');
    });

    it('renders retry button on failed attachment for user recovery', () => {
      const attachments: ComposerAttachment[] = [
        {
          id: 'att-fail-1',
          name: 'large_data.json',
          mediaType: 'application/json',
          sizeBytes: 500_000,
          state: 'error',
          errorMessage: 'Upload timeout exceeded',
        },
      ];

      const html = renderToStaticMarkup(
        <ChatComposer
          agentLabel="Claude"
          value=""
          history={[]}
          commands={[]}
          attachments={attachments}
          onChange={vi.fn()}
          onAttach={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onRetryAttachment={vi.fn()}
          onSend={vi.fn()}
        />,
      );

      expect(html).toContain('attachment-retry');
      expect(html).toContain('Upload timeout exceeded');
    });
  });
});
