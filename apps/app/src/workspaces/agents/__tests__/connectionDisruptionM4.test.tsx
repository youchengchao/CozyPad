import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
        reconnect={{ attempt: 2, secondsLeft: 5 }}
        profileId="profile-1"
      />,
    );

    expect(html).toContain('agent-disconnected-empty');
    expect(html).toContain('連線中斷 — 正在重連中');
    expect(html).toContain('5s 後進行第 2 次重連嘗試');
    expect(html).not.toContain('session-sidebar');
  });

  it('renders reconnect status pill in session header when reconnecting', () => {
    const html = renderToStaticMarkup(
      <AgentsWorkspace
        connected={false}
        reconnect={{ attempt: 1, secondsLeft: 10 }}
        profileId="profile-1"
      />,
    );

    expect(html).toContain('agent-disconnected-empty');
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

    expect(html).toContain('agent-disconnected-empty');
    expect(html).toContain('尚未連線');
    expect(html).toContain('斷線期間不保留或顯示主機內容');
    expect(html).not.toContain('session-sidebar');
  });

  it('hard-clears host data and never lists sessions while disconnected', () => {
    const source = readFileSync(
      resolve(__dirname, '../AgentsWorkspace.tsx'),
      'utf8',
    );
    const guardStart = source.indexOf('if (!connected || profileId === null)');
    const connectedLoadStart = source.indexOf('let cancelled = false', guardStart);
    const disconnectedBranch = source.slice(guardStart, connectedLoadStart);

    expect(guardStart).toBeGreaterThan(-1);
    expect(disconnectedBranch).toContain('clearHostData();');
    expect(disconnectedBranch).not.toContain('listAgentSessions');
    expect(source).toContain('if (!connectedRef.current) return;');
    expect(source).toContain('void refreshAgentSessions(nextAgent);');
    expect(source).toContain("useState<'current' | 'all'>('all')");
  });

  it('always renders the unified hamburger session menu', () => {
    const html = renderToStaticMarkup(
      <AgentsWorkspace
        connected={false}
        connectionState="disconnected"
        reconnect={null}
        profileId="profile-1"
      />,
    );

    expect(html).toContain('<details class="agent-landscape-menu">');
    expect(html).toContain('class="agent-menu-hamburger"');
    expect(html).toContain('aria-label="Select agent"');
    expect(html).toContain('aria-label="Session workspace"');
    expect(html).toContain('aria-label="Session archive state"');
    expect(html).toContain('aria-label="Session status"');
    expect(html).not.toContain('agent-tabs');
  });

  it('renders interrupted badge when chat message is marked interrupted', () => {
    const items: ChatItem[] = [
      {
        kind: 'message',
        timestamp: '2026-08-08T00:00:00.000Z',
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
        timestamp: '2026-08-08T00:00:00.000Z',
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
