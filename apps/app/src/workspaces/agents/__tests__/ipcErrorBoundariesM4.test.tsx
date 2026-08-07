import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AgentsWorkspaceErrorBoundary,
} from '../AgentsWorkspace';
import {
  AgentErrorCard,
  TimelineErrorBoundary,
  ChatTimeline,
} from '../ChatTimeline';
import { CozyPadIPCError, getBridge } from '../../../platform/bridge';

describe('Milestone 4 - IPC Error Handling & Error Boundaries', () => {
  beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).window = globalThis;
    (globalThis as unknown as Record<string, unknown>).cozypad = {
      kind: 'electron',
      listProfiles: vi.fn().mockResolvedValue([]),
    };
  });

  it('instantiates CozyPadIPCError with proper code, message, and retryable flag', () => {
    const timeoutErr = new CozyPadIPCError('TIMEOUT', 'IPC call timed out after 10s', true);
    expect(timeoutErr.code).toBe('TIMEOUT');
    expect(timeoutErr.message).toBe('IPC call timed out after 10s');
    expect(timeoutErr.isRetryable).toBe(true);

    const failErr = new CozyPadIPCError('IPC_FAILED', 'Connection refused', false);
    expect(failErr.code).toBe('IPC_FAILED');
    expect(failErr.isRetryable).toBe(false);
  });

  it('AgentsWorkspaceErrorBoundary returns updated error state from getDerivedStateFromError', () => {
    const testError = new Error('Workspace render explosion');
    const state = AgentsWorkspaceErrorBoundary.getDerivedStateFromError(testError);
    expect(state.hasError).toBe(true);
    expect(state.error).toBe(testError);

    const boundary = new AgentsWorkspaceErrorBoundary({ children: null });
    boundary.state = state;
    const html = renderToStaticMarkup(boundary.render());
    expect(html).toContain('agent-workspace-error-fallback');
    expect(html).toContain('Workspace render explosion');
    expect(html).toContain('Reload Workspace');
  });

  it('TimelineErrorBoundary returns updated error state from getDerivedStateFromError', () => {
    const testError = new Error('Timeline rendering failure');
    const state = TimelineErrorBoundary.getDerivedStateFromError(testError);
    expect(state.hasError).toBe(true);
    expect(state.error).toBe(testError);

    const boundary = new TimelineErrorBoundary({ children: null });
    boundary.state = state;
    const html = renderToStaticMarkup(boundary.render());
    expect(html).toContain('timeline-error-boundary');
    expect(html).toContain('Timeline rendering failure');
    expect(html).toContain('Reload Timeline');
  });

  it('renders AgentErrorCard when session status is error', () => {
    const html = renderToStaticMarkup(
      <ChatTimeline
        sessionId="session-err-1"
        items={[]}
        sessionStatus="error"
        sessionError="Agent process crashed unexpectedly"
        onResolveApproval={vi.fn()}
        onAnswerQuestion={vi.fn()}
        onRetrySession={vi.fn()}
      />,
    );

    expect(html).toContain('agent-error-card');
    expect(html).toContain('Agent Session Error');
    expect(html).toContain('Agent process crashed unexpectedly');
    expect(html).toContain('Resume Session');
  });

  it('wraps platform bridge methods with resilient proxy in getBridge()', () => {
    const bridge = getBridge();
    expect(typeof bridge.listProfiles).toBe('function');
  });
});
