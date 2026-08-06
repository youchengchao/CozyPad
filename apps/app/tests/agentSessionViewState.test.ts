import { describe, expect, it } from 'vitest';
import type { AgentSessionSummary } from '@cozypad/contracts';
import {
  createAgentSessionViewState,
  enterSelectedSession,
  leaveEnteredSession,
  reconcileSessionView,
  selectSessionForPreview,
} from '../src/workspaces/agents/agentSessionViewState';

const session: AgentSessionSummary = {
  id: 'session-1',
  agentKind: 'claude',
  title: 'Conversation',
  host: 'localhost',
  project: 'project',
  cwd: 'D:/project',
  status: 'exited',
  unread: 0,
  slashCommands: [],
  updatedAt: '2026-08-04T00:00:00.000Z',
};

describe('agent session view state', () => {
  it('starts blank and does not auto-select a restored conversation', () => {
    const state = reconcileSessionView(createAgentSessionViewState(), [session]);

    expect(state.selected.claude).toBeNull();
    expect(state.entered.claude).toBeNull();
  });

  it('selects a conversation for preview without entering it', () => {
    const state = selectSessionForPreview(
      createAgentSessionViewState(),
      'claude',
      session.id,
    );

    expect(state.selected.claude).toBe(session.id);
    expect(state.entered.claude).toBeNull();
  });

  it('enters only the currently selected conversation after Resume', () => {
    const blank = createAgentSessionViewState();
    const ignored = enterSelectedSession(blank, 'claude', session.id);
    const selected = selectSessionForPreview(blank, 'claude', session.id);
    const entered = enterSelectedSession(selected, 'claude', session.id);

    expect(ignored).toBe(blank);
    expect(entered.entered.claude).toBe(session.id);
  });

  it('returns an ended entered conversation to selected preview state', () => {
    const selected = selectSessionForPreview(
      createAgentSessionViewState(),
      'claude',
      session.id,
    );
    const entered = enterSelectedSession(selected, 'claude', session.id);

    expect(leaveEnteredSession(entered, 'claude', session.id)).toEqual({
      selected: { claude: session.id, codex: null, agy: null },
      entered: { claude: null, codex: null, agy: null },
    });
  });
});
