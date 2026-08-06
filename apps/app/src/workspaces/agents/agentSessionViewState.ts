import type { AgentKind, AgentSessionSummary } from '@cozypad/contracts';

const AGENT_KINDS: AgentKind[] = ['claude', 'codex', 'agy'];

export type AgentSessionSlots = Record<AgentKind, string | null>;

export interface AgentSessionViewState {
  /** The conversation whose history is being previewed on each agent page. */
  selected: AgentSessionSlots;
  /** The selected conversation the user explicitly resumed into. */
  entered: AgentSessionSlots;
}

function emptySlots(): AgentSessionSlots {
  return { claude: null, codex: null, agy: null };
}

export function createAgentSessionViewState(): AgentSessionViewState {
  return { selected: emptySlots(), entered: emptySlots() };
}

export function selectSessionForPreview(
  state: AgentSessionViewState,
  agentKind: AgentKind,
  sessionId: string,
): AgentSessionViewState {
  if (state.selected[agentKind] === sessionId) return state;
  return {
    selected: { ...state.selected, [agentKind]: sessionId },
    entered: { ...state.entered, [agentKind]: null },
  };
}

export function enterSelectedSession(
  state: AgentSessionViewState,
  agentKind: AgentKind,
  sessionId: string,
): AgentSessionViewState {
  if (state.selected[agentKind] !== sessionId) return state;
  if (state.entered[agentKind] === sessionId) return state;
  return {
    ...state,
    entered: { ...state.entered, [agentKind]: sessionId },
  };
}

export function leaveEnteredSession(
  state: AgentSessionViewState,
  agentKind: AgentKind,
  sessionId: string,
): AgentSessionViewState {
  if (state.entered[agentKind] !== sessionId) return state;
  return {
    ...state,
    entered: { ...state.entered, [agentKind]: null },
  };
}

export function forgetSessionView(
  state: AgentSessionViewState,
  agentKind: AgentKind,
  sessionId: string,
): AgentSessionViewState {
  const selected =
    state.selected[agentKind] === sessionId
      ? { ...state.selected, [agentKind]: null }
      : state.selected;
  const entered =
    state.entered[agentKind] === sessionId
      ? { ...state.entered, [agentKind]: null }
      : state.entered;
  return selected === state.selected && entered === state.entered
    ? state
    : { selected, entered };
}

/** Keep valid choices, but never fill an empty slot from the session list. */
export function reconcileSessionView(
  state: AgentSessionViewState,
  sessions: AgentSessionSummary[],
): AgentSessionViewState {
  let selected = state.selected;
  let entered = state.entered;
  for (const agentKind of AGENT_KINDS) {
    const selectedId = selected[agentKind];
    const selectionExists =
      selectedId !== null &&
      sessions.some(
        (session) =>
          session.id === selectedId && session.agentKind === agentKind,
      );
    if (selectedId !== null && !selectionExists) {
      selected = { ...selected, [agentKind]: null };
    }
    if (
      entered[agentKind] !== null &&
      (entered[agentKind] !== selected[agentKind] || !selectionExists)
    ) {
      entered = { ...entered, [agentKind]: null };
    }
  }
  return selected === state.selected && entered === state.entered
    ? state
    : { selected, entered };
}
