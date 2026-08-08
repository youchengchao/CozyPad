/**
 * ACP `session/update` → CozyPad `ChatItem`.
 *
 * This is the piece that replaces reading a terminal. Everything the old path
 * inferred from a 120×40 screen — who is speaking, whether a tool is running,
 * what the options are — arrives here as a typed protocol message instead.
 *
 * The rules below are not stylistic. Each one is a shape that was *measured*
 * from at least one of the three agents CozyPad drives, recorded in
 * `tests/fixtures/acp/`, and each would silently corrupt the transcript if
 * written the obvious way. They are stated at the point they apply.
 */
import type {
  ApprovalOption,
  ChatItem,
  QuestionItem,
  ToolCallItem,
} from '@cozypad/contracts';
import type { AcpSessionEvent } from '@cozypad/acp-client';

export interface AcpTimelineState {
  readonly items: readonly ChatItem[];
  /** The assistant message currently being appended to, if any. */
  readonly openAssistantId: string | null;
  /** The thought currently being appended to, if any. */
  readonly openThoughtId: string | null;
  /** `messageId` of the open assistant item, when the agent supplies one. */
  readonly openMessageId: string | null;
  /** `toolCallId` → index in `items`. */
  readonly toolIndex: ReadonlyMap<string, number>;
  /** Update kinds seen and deliberately not mapped, for diagnostics. */
  readonly dropped: readonly string[];
}

export function emptyAcpTimeline(): AcpTimelineState {
  return {
    items: [],
    openAssistantId: null,
    openThoughtId: null,
    openMessageId: null,
    toolIndex: new Map(),
    dropped: [],
  };
}

/** Injected so tests are deterministic and ids are stable across a replay. */
export interface AcpTimelineClock {
  now(): string;
  nextId(prefix: string): string;
}

export function defaultClock(): AcpTimelineClock {
  let counter = 0;
  return {
    now: () => new Date().toISOString(),
    nextId: (prefix) => {
      counter += 1;
      return `${prefix}-${counter}`;
    },
  };
}

function textOf(content: unknown): string {
  if (typeof content !== 'object' || content === null) return '';
  const block = content as { type?: unknown; text?: unknown };
  return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
}

/**
 * ACP tool status → CozyPad's.
 *
 * The two enums differ, and the mapping is not the identity: ACP has `pending`
 * and `in_progress` where CozyPad has one `running`, and says `failed` where
 * CozyPad says `error`. `unknown` has no ACP source at all — CozyPad writes it
 * itself when a session dies with a tool still open.
 */
function toolStatus(status: unknown): ToolCallItem['status'] {
  switch (status) {
    case 'pending':
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'error';
    default:
      return 'running';
  }
}

function approvalOptions(raw: unknown): ApprovalOption[] {
  if (!Array.isArray(raw)) return [];
  const options: ApprovalOption[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const option = entry as { optionId?: unknown; name?: unknown; kind?: unknown };
    if (typeof option.optionId !== 'string' || option.optionId === '') continue;
    const name = typeof option.name === 'string' && option.name !== '' ? option.name : option.optionId;
    options.push(
      typeof option.kind === 'string'
        ? { optionId: option.optionId, name, kind: option.kind }
        : { optionId: option.optionId, name },
    );
  }
  return options;
}

/** Turns an ACP permission request into a pending approval card. */
export function approvalItemFor(
  request: { toolCall?: { title?: string; rawInput?: unknown }; options?: unknown },
  clock: AcpTimelineClock,
): ChatItem {
  const title = request.toolCall?.title;
  return {
    kind: 'approval',
    id: clock.nextId('approval'),
    timestamp: clock.now(),
    riskSummary: typeof title === 'string' && title !== '' ? title : 'The agent is asking permission.',
    options: approvalOptions(request.options),
    resolution: 'pending',
  };
}

/**
 * An `elicitation/create` request as a question card, plus the translation
 * back to the wire answer.
 *
 * Only the shape CozyPad can honestly render becomes options: an object
 * schema with exactly one property whose `enum` lists up to six strings.
 * Anything else is an unrepresentable question — shown raw with a decline
 * button — because guessing at a free-form schema would send the agent an
 * answer the user never gave.
 */
export function elicitationQuestion(
  request: {
    message?: unknown;
    requestedSchema?: unknown;
  },
  clock: AcpTimelineClock,
): {
  item: QuestionItem;
  /** `answer` is the chosen option index as text; null declines. */
  respond(answer: string | null):
    | { action: 'accept'; content: Record<string, unknown> }
    | { action: 'decline' };
} {
  const message = typeof request.message === 'string' ? request.message : '';
  const schema =
    typeof request.requestedSchema === 'object' && request.requestedSchema !== null
      ? (request.requestedSchema as Record<string, unknown>)
      : {};
  const properties =
    typeof schema['properties'] === 'object' && schema['properties'] !== null
      ? (schema['properties'] as Record<string, unknown>)
      : {};
  const keys = Object.keys(properties);
  const soleProperty =
    keys.length === 1 ? (properties[keys[0]!] as Record<string, unknown>) : undefined;
  const enumValues = Array.isArray(soleProperty?.['enum'])
    ? soleProperty['enum'].filter(
        (value): value is string => typeof value === 'string' && value !== '',
      )
    : [];
  const representable = enumValues.length > 0 && enumValues.length <= 6;

  const item: QuestionItem = {
    kind: 'question',
    id: clock.nextId('question'),
    timestamp: clock.now(),
    prompt: representable
      ? (message === '' ? '請選擇一項' : message)
      : `${message === '' ? 'Agent 送出了一個表單詢問' : message}\n${JSON.stringify(schema, null, 2)}`,
    options: representable ? enumValues.map((value) => ({ label: value })) : [],
    selectedIndex: null,
    ...(representable ? {} : { unrepresentable: true }),
  };

  return {
    item,
    respond: (answer) => {
      const index = answer === null ? Number.NaN : Number.parseInt(answer, 10);
      const chosen = enumValues[index];
      if (chosen === undefined) return { action: 'decline' };
      return { action: 'accept', content: { [keys[0]!]: chosen } };
    },
  };
}

/** Update kinds with no ChatItem, listed so silence here is a decision. */
const DELIBERATELY_DROPPED = new Set([
  // No plan UI exists yet. Recorded rather than ignored so "the agent's todo
  // list is invisible" stays a known gap instead of becoming folklore.
  'plan',
  'plan_update',
  'plan_removed',
  // Consumed by the session service for the composer's command menu and the
  // model picker, not by the transcript.
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
]);

/**
 * Folds one ACP event into the timeline.
 *
 * Pure: same state and event always give the same result, which is what makes
 * the recorded fixtures a usable regression net.
 */
export function reduceAcpEvent(
  state: AcpTimelineState,
  event: AcpSessionEvent,
  clock: AcpTimelineClock,
): AcpTimelineState {
  const update = event.update as Record<string, unknown>;

  switch (event.kind) {
    case 'user_message_chunk': {
      // **Discarded, on purpose.** CozyPad appends the user's message itself
      // at send time, and claude-agent-acp launches the CLI with
      // `replay-user-messages`, which echoes it straight back. Accepting both
      // puts every message the user sends into the transcript twice. (A
      // `session/load` replay never reaches this reducer either — the runtime
      // drops the whole stream and seeds the persisted transcript instead.)
      return { ...state, dropped: [...state.dropped, event.kind] };
    }

    case 'agent_message_chunk': {
      const text = textOf(update['content']);
      const messageId = typeof update['messageId'] === 'string' ? update['messageId'] : null;

      // **`messageId` cannot be the accumulation key.** codex sends one, and
      // claude-agent-acp and adapter-agy never do — keying on it would give
      // those two a fresh bubble per token. The rule is the other way round: a
      // *different* id ends the open message; its absence changes nothing.
      const startsNew =
        state.openAssistantId === null ||
        (messageId !== null && state.openMessageId !== null && messageId !== state.openMessageId);

      if (!startsNew) {
        // claude's first chunk is `{"text":""}`. An empty chunk must not close
        // the message — the real text arrives in the next one.
        if (text === '') return state;
        return {
          ...state,
          items: state.items.map((item) =>
            item.id === state.openAssistantId && item.kind === 'message'
              ? { ...item, text: item.text + text }
              : item,
          ),
        };
      }

      const id = clock.nextId('assistant');
      return {
        ...state,
        items: [
          ...state.items,
          { kind: 'message', id, timestamp: clock.now(), role: 'assistant', text, streaming: true },
        ],
        openAssistantId: id,
        openMessageId: messageId,
        openThoughtId: null,
      };
    }

    case 'agent_thought_chunk': {
      const text = textOf(update['content']);
      if (state.openThoughtId !== null) {
        if (text === '') return state;
        return {
          ...state,
          items: state.items.map((item) =>
            item.id === state.openThoughtId && item.kind === 'thought'
              ? { ...item, text: item.text + text }
              : item,
          ),
        };
      }
      const id = clock.nextId('thought');
      return {
        ...state,
        items: [
          ...state.items,
          { kind: 'thought', id, timestamp: clock.now(), text, streaming: true },
        ],
        openThoughtId: id,
        openAssistantId: null,
        openMessageId: null,
      };
    }

    case 'tool_call':
    case 'tool_call_update': {
      const toolCallId = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : null;
      if (toolCallId === null) return { ...state, dropped: [...state.dropped, event.kind] };

      const title = typeof update['title'] === 'string' ? update['title'] : undefined;
      // **`name` is optional and UNSTABLE in ACP**, and adapter-agy sets only
      // `title`. `ToolCallItemSchema.name` is `.min(1)`, so taking `name`
      // alone makes every agy tool call fail to parse.
      const name = typeof update['name'] === 'string' && update['name'] !== '' ? update['name'] : title;
      const existingIndex = state.toolIndex.get(toolCallId);

      if (existingIndex === undefined) {
        const item: ToolCallItem = {
          kind: 'tool_call',
          id: toolCallId,
          timestamp: clock.now(),
          name: name ?? 'tool',
          summary: title ?? name ?? '',
          status: toolStatus(update['status']),
        };
        const toolIndex = new Map(state.toolIndex);
        toolIndex.set(toolCallId, state.items.length);
        return {
          ...state,
          items: [...state.items, item],
          toolIndex,
          openAssistantId: null,
          openMessageId: null,
          openThoughtId: null,
        };
      }

      // An update carries only what changed, so every field is merged rather
      // than replaced — a `tool_call_update` with just a status must not blank
      // the name the original call established.
      const items = [...state.items];
      const previous = items[existingIndex];
      if (previous === undefined || previous.kind !== 'tool_call') return state;
      items[existingIndex] = {
        ...previous,
        ...(name === undefined ? {} : { name }),
        ...(title === undefined ? {} : { summary: title }),
        ...(update['status'] === undefined ? {} : { status: toolStatus(update['status']) }),
      };
      return { ...state, items };
    }

    case 'usage_update': {
      // `usage_update` is context pressure — `{used, size, cost}`. It is NOT
      // the turn's token counts, which arrive separately on `PromptResponse`,
      // and neither can be derived from the other. Both land on the same item
      // kind in different fields; see UsageItemSchema.
      const used = typeof update['used'] === 'number' ? update['used'] : undefined;
      const size = typeof update['size'] === 'number' ? update['size'] : undefined;
      const cost = update['cost'] as { amount?: unknown } | undefined;
      const amount = typeof cost?.amount === 'number' ? cost.amount : undefined;
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: 'usage',
            id: clock.nextId('usage'),
            timestamp: clock.now(),
            inputTokens: 0,
            outputTokens: 0,
            ...(used === undefined ? {} : { contextUsed: used }),
            ...(size === undefined ? {} : { contextSize: size }),
            ...(amount === undefined ? {} : { costUsd: amount }),
          },
        ],
      };
    }

    default: {
      const kind: string = event.kind;
      if (DELIBERATELY_DROPPED.has(kind)) {
        return { ...state, dropped: [...state.dropped, kind] };
      }
      // A variant the protocol added and this reducer has not learned yet.
      // Recorded rather than thrown: a new ACP release must not break a turn.
      return { ...state, dropped: [...state.dropped, kind] };
    }
  }
}

/** Closes any open streaming item at the end of a turn. */
export function settleAcpTimeline(state: AcpTimelineState): AcpTimelineState {
  return {
    ...state,
    items: state.items.map((item) => {
      if (
        (item.id === state.openAssistantId && item.kind === 'message') ||
        (item.id === state.openThoughtId && item.kind === 'thought')
      ) {
        return { ...item, streaming: false };
      }
      // A permission request dies with its turn: after a cancel or a failure
      // there is no agent waiting on the answer, and a card left 'pending'
      // would keep the session labelled as needing input forever.
      if (item.kind === 'approval' && item.resolution === 'pending') {
        return { ...item, resolution: 'expired' as const };
      }
      if (
        item.kind === 'question' &&
        item.selectedIndex === null &&
        item.declined !== true &&
        item.expired !== true
      ) {
        return { ...item, expired: true };
      }
      return item;
    }),
    openAssistantId: null,
    openThoughtId: null,
    openMessageId: null,
  };
}
