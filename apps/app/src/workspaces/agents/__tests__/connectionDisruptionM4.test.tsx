import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentsWorkspace } from '../AgentsWorkspace';
import { ChatTimeline } from '../ChatTimeline';
import type { ChatItem } from '@cozypad/contracts';

describe('Milestone 4 - Connection Disruption & Reconnect Status Indicators', () => {
  beforeEach(() => {
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
    };
  });

  it('renders reconnecting status banner with countdown timer in sidebar', () => {
    const html = renderToStaticMarkup(
      <AgentsWorkspace
        connected={false}
        connectionState="reconnecting"
        reconnect={{ attempt: 2, secondsLeft: 5 }}
        profileId="profile-1"
      />,
    );

    expect(html).toContain('agent-availability-reconnecting');
    expect(html).toContain('連線中斷 — 正在重連中');
    expect(html).toContain('5s 後進行第 2 次重連嘗試');
  });

  it('renders reconnect status pill in session header when reconnecting', () => {
    const html = renderToStaticMarkup(
      <AgentsWorkspace
        connected={false}
        connectionState="reconnecting"
        reconnect={{ attempt: 1, secondsLeft: 10 }}
        profileId="profile-1"
      />,
    );

    expect(html).toContain('agent-availability-banner');
    expect(html).toContain('連線中斷 — 正在重連中');
  });

  it('renders disconnected state banner when connection state is disconnected', () => {
    const html = renderToStaticMarkup(
      <AgentsWorkspace
        connected={false}
        connectionState="disconnected"
        reconnect={null}
        profileId="profile-1"
      />,
    );

    expect(html).toContain('agent-availability-banner');
    expect(html).toContain('尚未連線');
  });

  it('renders interrupted badge when chat message is marked interrupted', () => {
    const items: ChatItem[] = [
      {
        kind: 'message',
        id: 'msg-1',
        role: 'assistant',
        text: 'Partial response before drop...',
        interrupted: true,
      },
    ];

    const html = renderToStaticMarkup(
      <ChatTimeline
        sessionId="session-1"
        items={items}
        onResolveApproval={vi.fn()}
        onAnswerQuestion={vi.fn()}
      />,
    );

    expect(html).toContain('msg-interrupted');
    expect(html).toContain('已中斷');
  });

  it('renders timeline notice card when connection drop notice is in items', () => {
    const items: ChatItem[] = [
      {
        kind: 'notice',
        id: 'notice-1',
        text: '⚡ 連線中斷 — Agent 執行已中斷',
      },
    ];

    const html = renderToStaticMarkup(
      <ChatTimeline
        sessionId="session-1"
        items={items}
        onResolveApproval={vi.fn()}
        onAnswerQuestion={vi.fn()}
      />,
    );

    expect(html).toContain('timeline-notice');
    expect(html).toContain('⚡ 連線中斷 — Agent 執行已中斷');
  });
});
