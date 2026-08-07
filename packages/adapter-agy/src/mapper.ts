/**
 * agy stream-json → ACP session updates.
 *
 * This module is deliberately free of I/O: it is a fold over events, so the
 * whole mapping can be tested against recorded agy output without spawning
 * anything. Everything that needs a process lives behind the transport seam.
 *
 * The table is docs/ACP-MIGRATION.md; the deviations found by recording real
 * runs on 2026-08-07 are called out at each site.
 */
import type {
  PromptResponse,
  SessionNotification,
  ToolKind,
} from '@agentclientprotocol/sdk';
import { parseAgyLine, type AgyEvent, type AgyStep } from './wire.js';

/**
 * One variant of the ACP `session/update` payload.
 *
 * Derived from the SDK, never restated: ACP declares this union inline on
 * {@link SessionNotification}, and `@zed-industries/agent-client-protocol@0.4.5`
 * knew only eight of its thirteen members. Anything this mapper learns to emit
 * later arrives here by upgrading one dependency.
 */
export type AcpSessionUpdate = SessionNotification['update'];

/**
 * ACP's `PromptResponse.stopReason`.
 *
 * Read off the response type rather than written out, for the same reason
 * `packages/acp-client` does it: a hand-copied union is a re-narrowing that
 * goes stale silently the next time the protocol grows a reason, and the two
 * halves of CozyPad would then disagree about what a turn may end with.
 */
export type AcpStopReason = PromptResponse['stopReason'];

/**
 * The fold's accumulator. Immutable — `mapAgyEvent` returns the next state
 * rather than mutating, so a test can replay a prefix without side effects.
 */
export interface AgyTurnState {
  /** Learned from the `init` event; needed for `--conversation` on later turns. */
  readonly conversationId: string | null;
  /**
   * What separates this turn's tool calls from the next turn's.
   *
   * ACP requires `toolCallId` to be unique **within the session**, and agy's
   * `step_index` is only unique within a *turn*: every turn is a fresh
   * `agy -p` process that counts from zero again. Two of the recordings in
   * `tests/fixtures` prove it — `turn-with-tool.ndjson` and
   * `turn-tool-error.ndjson` both put a tool at `step_index` 3, for different
   * tools. Without this component, turn 2's `list_dir` and turn 1's
   * `run_command` are handed to the client under one id, and a client that
   * keys its tool cards by id (which is what the id is *for*) rewrites the
   * finished card sitting in turn 1's transcript instead of drawing a new one.
   *
   * Supplied by the transport, which is the only layer that knows where one
   * turn stops and the next begins.
   */
  readonly turnId: string;
  /** `step_index` values already announced to the client as `tool_call`. */
  readonly announcedToolSteps: readonly number[];
}

/** Something on the wire that the mapping does not model. Never silently dropped. */
export interface AgyDiagnostic {
  readonly reason:
    | 'unmapped_step_type'
    | 'unmapped_event'
    | 'unparseable_line'
    | 'unknown_result_status';
  readonly detail: string;
}

export interface AgyMapStep {
  readonly state: AgyTurnState;
  readonly updates: readonly AcpSessionUpdate[];
  /** Present only on the event that ends the turn. */
  readonly stopReason?: AcpStopReason;
  readonly diagnostics: readonly AgyDiagnostic[];
}

/**
 * The accumulator a turn starts from.
 *
 * `turnId` defaults to `'1'` because the pure entry point {@link mapAgyLines}
 * folds exactly one recorded turn; anything driving several turns into one ACP
 * session must pass a distinct value per turn, or the tool call ids collide —
 * see {@link AgyTurnState.turnId}.
 */
export function initialAgyTurnState(
  conversationId: string | null = null,
  turnId = '1',
): AgyTurnState {
  return { conversationId, turnId, announcedToolSteps: [] };
}

/**
 * agy tool names → ACP `ToolKind`, which is what a client keys its icon and
 * treatment off. The names are the ones agy advertises in its `init` event.
 * Anything unlisted is `other`, which is the honest answer rather than a guess.
 */
const TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  view_file: 'read',
  list_dir: 'read',
  read_resource: 'read',
  notebook_edit: 'edit',
  write_to_file: 'edit',
  replace_file_content: 'edit',
  multi_replace_file_content: 'edit',
  sed_file: 'edit',
  grep_search: 'search',
  find_by_name: 'search',
  search_web: 'search',
  run_command: 'execute',
  send_command_input: 'execute',
  command_status: 'execute',
  read_url_content: 'fetch',
  open_browser_url: 'fetch',
};

/** Parameter keys whose string values are file paths worth reporting as ACP locations. */
const PATH_KEY = /(path|file|dir|directory)$/i;

function toolKindFor(toolName: string): ToolKind {
  return TOOL_KINDS[toolName] ?? 'other';
}

/**
 * ACP needs a `toolCallId` that is shared by the `tool_call` and its later
 * `tool_call_update`, and unique across the whole session.
 *
 * agy issues no such id. The ACTIVE and DONE/ERROR steps of one tool carry the
 * same `step_index`, which supplies the *sharing* half; the turn id supplies
 * the *uniqueness* half, because `step_index` restarts at zero every turn.
 * The conversation id is carried too — it is not needed for uniqueness once
 * the turn id is there, but it makes an id in a log say which agy conversation
 * it came from.
 */
function toolCallId(state: AgyTurnState, step: AgyStep): string {
  const index = typeof step.step_index === 'number' ? step.step_index : -1;
  return `${state.conversationId ?? 'agy'}:${state.turnId}:${index}`;
}

/** Surface path-like parameters so clients can offer follow-along. */
function locationsFor(parameters: Record<string, unknown> | undefined) {
  if (parameters === undefined) return [];
  return Object.entries(parameters).flatMap(([key, value]) =>
    PATH_KEY.test(key) && typeof value === 'string' && value.trim() !== ''
      ? [{ path: value }]
      : [],
  );
}

/**
 * agy `result.status` → ACP `stopReason`.
 *
 * `ERROR` is the entry worth explaining. agy sets it when *any* tool failed
 * during the turn, regardless of whether the turn itself went anywhere:
 * `turn-tool-error.ndjson` is a recording in which all five requested steps ran,
 * two tools errored, agy reported on each step in prose — and `result.status` is
 * still `"ERROR"`. Mapping that to `refusal`, as this did until 2026-08-07, told
 * the client a completed answer had been declined.
 *
 * `refusal` is also not merely a label. ACP defines it as "the turn ended
 * because the agent refused to continue. The user prompt and everything that
 * comes after it won't be included in the next prompt, so this should be
 * reflected in the UI" (StopReason in the protocol schema). That is an
 * instruction to drop the turn from history — and agy drops nothing: the next
 * turn resumes with `--conversation <id>` and that turn is still in its context.
 * So the old mapping did not just mislabel the turn, it would have pushed the
 * client's transcript out of sync with agy's.
 *
 * `end_turn` ("the turn ended successfully") is the honest answer: the turn did
 * end, and the failures are not swallowed by saying so. Each one already reaches
 * the client as a `tool_call_update` with `status: 'failed'` carrying the tool's
 * own `error.message` — see {@link mapToolStep}. ACP has no "finished, but
 * something failed" stop reason; the failed tool cards are that channel.
 *
 * Returns `undefined` for a status this build of agy has not shown us, so the
 * caller can report it rather than guess.
 */
const STOP_REASONS: Readonly<Record<string, AcpStopReason>> = {
  // Recorded. `SUCCESS` and `ERROR` are the only two statuses agy has ever been
  // seen to emit; both fixtures that end in one are in tests/fixtures.
  SUCCESS: 'end_turn',
  ERROR: 'end_turn',
  // Not recorded — agy has never produced any of these, and the spellings are
  // guesses at a vocabulary we have only seen two members of. They are kept
  // because being right early costs nothing here: an unrecognised status already
  // falls through to `end_turn` with a diagnostic, so a wrong guess degrades to
  // exactly that. Do not read them as evidence.
  CANCELLED: 'cancelled',
  CANCELED: 'cancelled',
  MAX_TOKENS: 'max_tokens',
  MAX_TURNS: 'max_turn_requests',
};

function stopReasonFor(status: string | undefined): AcpStopReason | undefined {
  if (status === undefined) return undefined;
  // `Object.hasOwn` before the lookup: `status` is untrusted wire text, and a
  // plain index would happily return `Object.prototype.toString` for "toString".
  return Object.hasOwn(STOP_REASONS, status) ? STOP_REASONS[status] : undefined;
}

function withConversationId(state: AgyTurnState, id: unknown): AgyTurnState {
  if (typeof id !== 'string' || id === '' || state.conversationId === id) return state;
  return { ...state, conversationId: id };
}

function mapToolStep(state: AgyTurnState, step: AgyStep): AgyMapStep {
  const id = toolCallId(state, step);
  const index = typeof step.step_index === 'number' ? step.step_index : -1;
  const toolName = step.tool_name ?? step.tool_info?.name ?? 'tool';
  const parameters = step.tool_info?.parameters;
  const locations = locationsFor(parameters);
  const announced = state.announcedToolSteps.includes(index);

  const openingUpdate: AcpSessionUpdate = {
    sessionUpdate: 'tool_call',
    toolCallId: id,
    title: toolName,
    kind: toolKindFor(toolName),
    status: 'in_progress',
    ...(parameters === undefined ? {} : { rawInput: parameters }),
    ...(locations.length === 0 ? {} : { locations }),
  };

  if (step.state === 'ACTIVE') {
    // A repeated ACTIVE for a step we already opened is an update, not a
    // second call — re-announcing would leave the client with a duplicate card.
    if (announced) {
      return {
        state,
        updates: [{ ...openingUpdate, sessionUpdate: 'tool_call_update' }],
        diagnostics: [],
      };
    }
    return {
      state: { ...state, announcedToolSteps: [...state.announcedToolSteps, index] },
      updates: [openingUpdate],
      diagnostics: [],
    };
  }

  const failed = step.state === 'ERROR' || step.tool_info?.error !== undefined;
  // A tool's result reaches a *rendering* client through `content`. agy puts a
  // failure in `tool_info.error.message` and a success in `tool_info.output`;
  // dropping the latter is what left completed tool cards blank. Error first
  // when both are present — the reason a call ended matters more than what it
  // managed to emit.
  const resultTexts = [step.tool_info?.error?.message, step.tool_info?.output].filter(
    (text): text is string => typeof text === 'string' && text !== '',
  );
  // ACP's channel for the tool's *unrendered* result, and the one field this
  // adapter could not populate before the library migration: ACP declares
  // `rawOutput` unstructured (`unknown`), but
  // `@zed-industries/agent-client-protocol@0.4.5` typed it
  // `Record<string, unknown>` — and agy's output is a bare string, so it did
  // not fit and was omitted. The same 0.4.5 narrowing is what made a client on
  // that version drop these very updates on the floor; see
  // packages/acp-client. Sent alongside `content`, not instead of it: `content`
  // is what a UI draws, `rawOutput` is what a client inspects, diffs or logs.
  const rawOutput = step.tool_info?.output;
  const closingUpdate: AcpSessionUpdate = {
    sessionUpdate: 'tool_call_update',
    toolCallId: id,
    status: failed ? 'failed' : 'completed',
    ...(parameters === undefined ? {} : { rawInput: parameters }),
    ...(rawOutput === undefined ? {} : { rawOutput }),
    ...(resultTexts.length === 0
      ? {}
      : {
          content: resultTexts.map((text) => ({
            type: 'content' as const,
            content: { type: 'text' as const, text },
          })),
        }),
  };

  // A terminal state for a tool we never announced would leave the client
  // updating a card it does not have. Open it first, then close it.
  if (!announced) {
    return {
      state: { ...state, announcedToolSteps: [...state.announcedToolSteps, index] },
      updates: [openingUpdate, closingUpdate],
      diagnostics: [],
    };
  }
  return { state, updates: [closingUpdate], diagnostics: [] };
}

function mapStepUpdate(state: AgyTurnState, step: AgyStep): AgyMapStep {
  const next = withConversationId(state, step.conversation_id);
  const none = { state: next, updates: [], diagnostics: [] } as const;

  switch (step.step_type) {
    case 'agent_response': {
      // Text arrives on both ACTIVE and DONE steps, so state is not a filter
      // here: one recorded response streamed "0\n" (ACTIVE) then "\n" (DONE).
      const delta = step.text_delta;
      if (typeof delta !== 'string' || delta === '') return none;
      return {
        state: next,
        updates: [
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } },
        ],
        diagnostics: [],
      };
    }
    case 'tool':
      return mapToolStep(next, step);

    // Deliberately silent: the client sent the prompt itself, `unknown` is an
    // internal marker (observed at index 1 with ~0s duration), and `checkpoint`
    // carries usage only.
    case 'user_input':
    case 'unknown':
    case 'checkpoint':
      return none;

    // Not in the migration table — found by recording. It marks a tool call agy
    // refused *before* running it, and it carries no text at all: no
    // `text_delta`, no message, and — verified across two recordings — no tool
    // step anywhere for the refused call. So there is nothing to render, and
    // nothing this mapper can turn into a tool card. The only account of the
    // refusal is the agent's own prose, which does reach the client as
    // `agent_message_chunk`. Recorded as a diagnostic so a future agy build that
    // starts attaching text (or a real tool step) is noticed rather than eaten.
    case 'error_message':
      return {
        ...none,
        diagnostics: [
          { reason: 'unmapped_step_type', detail: summarize(step) },
        ],
      };

    default:
      return {
        ...none,
        diagnostics: [{ reason: 'unmapped_step_type', detail: summarize(step) }],
      };
  }
}

function summarize(value: unknown, maxLength = 200): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * Map a single agy event onto ACP. Pure: same input, same output, no I/O.
 */
export function mapAgyEvent(event: AgyEvent, state: AgyTurnState): AgyMapStep {
  switch (event.event) {
    case 'init': {
      const init = event as { conversation_id?: unknown; init?: { conversation_id?: unknown } };
      // Observed at the top level; the nested spelling is a defensive fallback.
      const next = withConversationId(
        state,
        init.conversation_id ?? init.init?.conversation_id,
      );
      // The advertised tool list is a capability announcement, not conversation
      // content, so it produces no session update.
      return { state: next, updates: [], diagnostics: [] };
    }
    case 'step_update': {
      const step = (event as { step_update?: AgyStep }).step_update;
      if (step === undefined) {
        return {
          state,
          updates: [],
          diagnostics: [{ reason: 'unmapped_event', detail: summarize(event) }],
        };
      }
      return mapStepUpdate(state, step);
    }
    case 'result': {
      const result = (event as { result?: { conversation_id?: unknown; status?: unknown } })
        .result;
      const next = withConversationId(state, result?.conversation_id);
      const status = typeof result?.status === 'string' ? result.status : undefined;
      const stopReason = stopReasonFor(status);
      return {
        state: next,
        updates: [],
        // An unrecognised status must not be guessed into a reason that changes
        // what the client does with the turn. `end_turn` is the least-claiming
        // answer — the turn ended, which is the one thing a `result` event does
        // prove — and the diagnostic keeps the unknown value visible instead of
        // letting it hide behind that default.
        stopReason: stopReason ?? 'end_turn',
        diagnostics:
          stopReason === undefined
            ? [{ reason: 'unknown_result_status', detail: summarize(status ?? result) }]
            : [],
      };
    }
    default:
      return {
        state,
        updates: [],
        diagnostics: [{ reason: 'unmapped_event', detail: summarize(event) }],
      };
  }
}

export interface AgyMapResult {
  readonly state: AgyTurnState;
  readonly updates: readonly AcpSessionUpdate[];
  /** Absent when the stream ended without a `result` event. */
  readonly stopReason?: AcpStopReason;
  readonly diagnostics: readonly AgyDiagnostic[];
}

/**
 * Fold whole NDJSON lines through {@link mapAgyEvent}. This is what the tests
 * point at a recorded transcript.
 */
export function mapAgyLines(
  lines: Iterable<string>,
  initial: AgyTurnState = initialAgyTurnState(),
): AgyMapResult {
  let state = initial;
  const updates: AcpSessionUpdate[] = [];
  const diagnostics: AgyDiagnostic[] = [];
  let stopReason: AcpStopReason | undefined;

  for (const line of lines) {
    if (line.trim() === '') continue;
    const event = parseAgyLine(line);
    if (event === undefined) {
      diagnostics.push({ reason: 'unparseable_line', detail: summarize(line.slice(0, 120)) });
      continue;
    }
    const step = mapAgyEvent(event, state);
    state = step.state;
    updates.push(...step.updates);
    diagnostics.push(...step.diagnostics);
    if (step.stopReason !== undefined) stopReason = step.stopReason;
  }

  return {
    state,
    updates,
    ...(stopReason === undefined ? {} : { stopReason }),
    diagnostics,
  };
}
