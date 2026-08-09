/**
 * The ACP → ChatItem reducer, driven by recordings of all three real agents.
 *
 * The fixtures in `tests/fixtures/acp/` are the verbatim `updates` arrays from
 * `scripts/probe-acp-agent.mts` runs against claude-agent-acp 0.23.1, codex-acp
 * 1.1.14 and our own adapter. Real wire data, fully deterministic, and it costs
 * no quota to re-run — which is what makes this the regression net the cutover
 * actually rests on.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ChatItemSchema, type ChatItem } from '@cozypad/contracts';
import type { AcpSessionEvent } from '@cozypad/acp-client';
import {
  emptyAcpTimeline,
  reduceAcpEvent,
  settleAcpTimeline,
  approvalItemFor,
  type AcpTimelineClock,
  type AcpTimelineState,
} from '../src/main/acp/acpTimeline';

const fixtureDir = path.join(
  path.dirname(fileURLToPath(new URL('.', import.meta.url))),
  'tests',
  'fixtures',
  'acp',
);

interface Recording {
  agent: string;
  prompt: string;
  updates: AcpSessionEvent[];
  promptResponse?: { stopReason?: string };
}

function recording(name: 'agy' | 'claude' | 'codex'): Recording {
  return JSON.parse(readFileSync(path.join(fixtureDir, `${name}.json`), 'utf8')) as Recording;
}

/** Deterministic ids and timestamps, so assertions can name them. */
function clock(): AcpTimelineClock {
  let n = 0;
  return {
    now: () => '2026-08-08T00:00:00.000Z',
    nextId: (prefix) => {
      n += 1;
      return `${prefix}-${n}`;
    },
  };
}

function fold(events: readonly AcpSessionEvent[]): AcpTimelineState {
  const c = clock();
  let state = emptyAcpTimeline();
  for (const event of events) state = reduceAcpEvent(state, event, c);
  return settleAcpTimeline(state);
}

function assistantText(state: AcpTimelineState): string {
  return state.items
    .filter((i): i is Extract<ChatItem, { kind: 'message' }> => i.kind === 'message' && i.role === 'assistant')
    .map((i) => i.text)
    .join('');
}

describe('every recorded agent folds into a valid timeline', () => {
  it.each(['agy', 'claude', 'codex'] as const)('%s', (name) => {
    const state = fold(recording(name).updates);
    // Every item must satisfy the contract, not merely look plausible. A
    // tool_call whose `name` came back undefined fails `.min(1)` right here.
    for (const item of state.items) {
      expect(() => ChatItemSchema.parse(item)).not.toThrow();
    }
    expect(state.items.length).toBeGreaterThan(0);
  });

  it('recovers the exact reply each agent gave', () => {
    // agy's recording is the interactive-riddle probe, where print mode
    // auto-answered its own ask_question — so the reply is prose about having
    // skipped the question, and no tool call reaches the wire at all.
    expect(assistantText(fold(recording('claude').updates))).toBe('OK');
    expect(assistantText(fold(recording('codex').updates))).toBe('OK');
    expect(assistantText(fold(recording('agy').updates))).toContain('地圖');
  });

  it('leaves nothing streaming once the turn is settled', () => {
    for (const name of ['agy', 'claude', 'codex'] as const) {
      const state = fold(recording(name).updates);
      expect(state.items.some((i) => 'streaming' in i && i.streaming === true)).toBe(false);
    }
  });
});

describe('the three shapes that would silently corrupt a transcript', () => {
  const session = 's1';
  const chunk = (text: string, messageId?: string): AcpSessionEvent =>
    ({
      sessionId: session,
      kind: 'agent_message_chunk',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        ...(messageId === undefined ? {} : { messageId }),
      },
    }) as unknown as AcpSessionEvent;

  it('accumulates chunks that carry no messageId into ONE message', () => {
    // claude-agent-acp's whole dist contains zero occurrences of `messageId`,
    // and adapter-agy never sets it. Keying accumulation on it would give both
    // agents one bubble per token.
    const state = fold([chunk('Hel'), chunk('lo, '), chunk('world')]);
    const messages = state.items.filter((i) => i.kind === 'message');
    expect(messages).toHaveLength(1);
    expect(assistantText(state)).toBe('Hello, world');
  });

  it('starts a new message when a DIFFERENT messageId arrives', () => {
    // codex does send them, and two ids mean two answers.
    const state = fold([chunk('first', 'm1'), chunk(' more', 'm1'), chunk('second', 'm2')]);
    const messages = state.items.filter((i) => i.kind === 'message');
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => (m.kind === 'message' ? m.text : ''))).toEqual(['first more', 'second']);
  });

  it('keeps accumulating after an agent that started with an id stops sending one', () => {
    // The asymmetry the rule exists for: a *different* id ends the open
    // message, but the absence of one means nothing. Reading it as
    // `messageId !== openMessageId` looks equivalent and is not — it splits
    // the message the moment an agent stops labelling its chunks.
    const state = fold([chunk('one', 'm1'), chunk(' two')]);
    expect(state.items.filter((i) => i.kind === 'message')).toHaveLength(1);
    expect(assistantText(state)).toBe('one two');
  });

  it('does not end a message on an empty chunk in the middle of one', () => {
    // The empty chunk claude opens with is not special — an empty chunk
    // anywhere carries no text and must change nothing. Treating it as a
    // terminator splits a reply in half at whatever point the agent happened
    // to flush.
    const state = fold([chunk('He'), chunk(''), chunk('llo')]);
    expect(state.items.filter((i) => i.kind === 'message')).toHaveLength(1);
    expect(assistantText(state)).toBe('Hello');
  });

  it('survives claude opening a turn with an empty chunk', () => {
    // Measured: claude's first agent_message_chunk is literally {"text":""}.
    // Treating an empty chunk as an end-of-message closes the bubble before a
    // single character of the answer arrives.
    const state = fold([chunk(''), chunk('OK')]);
    expect(state.items.filter((i) => i.kind === 'message')).toHaveLength(1);
    expect(assistantText(state)).toBe('OK');
  });

  it('discards a replayed user message', () => {
    // CozyPad appends the user's message itself when it sends, and
    // claude-agent-acp launches the CLI with `replay-user-messages`, which
    // echoes it back. Accepting both doubles every message the user sends.
    // (A session/load replay never reaches this reducer — the runtime drops
    // the whole stream and seeds the persisted transcript instead.)
    const replay = {
      sessionId: session,
      kind: 'user_message_chunk',
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } },
    } as unknown as AcpSessionEvent;

    const live = fold([replay, chunk('hi')]);
    expect(live.items.filter((i) => i.kind === 'message' && i.role === 'user')).toHaveLength(0);
    expect(live.dropped).toContain('user_message_chunk');
  });

  it('names a tool call that only has a title', () => {
    // ACP's ToolCall.name is optional and marked UNSTABLE; adapter-agy sets
    // only `title` (mapper.ts). ToolCallItemSchema requires a non-empty name,
    // so reading `name` alone makes every agy tool call fail to parse.
    const state = fold([
      {
        sessionId: session,
        kind: 'tool_call',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'list_dir',
          status: 'pending',
        },
      } as unknown as AcpSessionEvent,
    ]);
    const tool = state.items.find((i) => i.kind === 'tool_call');
    expect(tool).toBeDefined();
    expect(() => ChatItemSchema.parse(tool)).not.toThrow();
    expect(tool?.kind === 'tool_call' && tool.name).toBe('list_dir');
    // ACP `pending` is CozyPad `running`; the enums are not the same.
    expect(tool?.kind === 'tool_call' && tool.status).toBe('running');
  });

  it('merges a tool_call_update instead of replacing the call', () => {
    // An update carries only what changed. Replacing would blank the name the
    // original call established, and `.min(1)` would then reject it.
    const state = fold([
      {
        sessionId: session,
        kind: 'tool_call',
        update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'run_command', status: 'pending' },
      } as unknown as AcpSessionEvent,
      {
        sessionId: session,
        kind: 'tool_call_update',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' },
      } as unknown as AcpSessionEvent,
    ]);
    const tools = state.items.filter((i) => i.kind === 'tool_call');
    expect(tools).toHaveLength(1);
    // The fields the update did not mention must survive it. A replace here
    // blanks `name`, and `.min(1)` then rejects the item — so the tool card
    // disappears from the transcript at the exact moment it reports failing.
    expect(tools[0]?.kind === 'tool_call' && tools[0].name).toBe('run_command');
    expect(tools[0]?.kind === 'tool_call' && tools[0].summary).toBe('run_command');
    expect(tools[0]?.kind === 'tool_call' && tools[0].id).toBe('t1');
    expect(() => ChatItemSchema.parse(tools[0])).not.toThrow();
    // ACP says `failed`; CozyPad says `error`.
    expect(tools[0]?.kind === 'tool_call' && tools[0].status).toBe('error');
  });

  it('keeps Codex command output from rawOutput objects', () => {
    const state = fold([
      {
        sessionId: session,
        kind: 'tool_call_update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'codex-command',
          title: 'Write-Output test',
          status: 'completed',
          rawOutput: {
            formatted_output: 'shell tool: OK\n',
            exit_code: 0,
          },
        },
      } as unknown as AcpSessionEvent,
    ]);
    const tool = state.items.find((item) => item.kind === 'tool_call');
    expect(tool?.kind === 'tool_call' && tool.output).toBe(
      'shell tool: OK\n\nExit code: 0',
    );
  });
  it('keeps rendered tool output when later updates omit it', () => {
    const state = fold([
      {
        sessionId: session,
        kind: 'tool_call',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'run_command',
          status: 'in_progress',
        },
      } as unknown as AcpSessionEvent,
      {
        sessionId: session,
        kind: 'tool_call_update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          content: [{ type: 'content', content: { type: 'text', text: 'command output' } }],
          status: 'completed',
        },
      } as unknown as AcpSessionEvent,
      {
        sessionId: session,
        kind: 'tool_call_update',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
      } as unknown as AcpSessionEvent,
    ]);
    const tool = state.items.find((item) => item.kind === 'tool_call');
    expect(tool?.kind === 'tool_call' && tool.output).toBe('command output');
  });
});

describe('usage is two different measurements, not one', () => {
  it('puts context pressure in its own fields, leaving token counts at zero', () => {
    // Measured together from claude in one probe: used 8990 of 200000 context,
    // against 3 input and 4 output tokens for the turn. Folding either into
    // the other would misreport both.
    const state = fold(recording('claude').updates);
    const usage = state.items.find((i) => i.kind === 'usage');
    expect(usage?.kind === 'usage' && usage.contextUsed).toBe(8990);
    expect(usage?.kind === 'usage' && usage.contextSize).toBe(200000);
    expect(usage?.kind === 'usage' && usage.costUsd).toBeCloseTo(0.03375525, 8);
    expect(usage?.kind === 'usage' && usage.inputTokens).toBe(0);
  });

  it('accepts codex reporting context with no cost at all', () => {
    const state = fold(recording('codex').updates);
    const usage = state.items.find((i) => i.kind === 'usage');
    expect(usage?.kind === 'usage' && usage.contextUsed).toBe(16777);
    expect(usage?.kind === 'usage' && usage.costUsd).toBeUndefined();
  });
});

describe('what is dropped is a decision, not an accident', () => {
  it('records every unmapped kind rather than ignoring it', () => {
    const state = fold(recording('codex').updates);
    // codex sends session_info_update three times and available_commands_update
    // once; none of them belong in a transcript, and all of them are logged.
    expect(state.dropped).toContain('session_info_update');
    expect(state.dropped).toContain('available_commands_update');
  });

  it('does not throw on a variant the protocol adds later', () => {
    const future = {
      sessionId: 's1',
      kind: 'something_the_spec_added',
      update: { sessionUpdate: 'something_the_spec_added' },
    } as unknown as AcpSessionEvent;
    const state = fold([future]);
    expect(state.dropped).toContain('something_the_spec_added');
    expect(state.items).toHaveLength(0);
  });
});

describe('approval cards keep every option the agent offered', () => {
  it('does not flatten an arbitrary option list into allow/deny', () => {
    // claude-agent-acp offers Always Allow / Allow / Reject, and in plan mode
    // three options that are not about permission at all. The two-button card
    // this replaces would have dropped whatever it had no slot for.
    const item = approvalItemFor(
      {
        toolCall: { title: 'Write to src/main.ts' },
        options: [
          { optionId: 'allow_always', name: 'Always Allow', kind: 'allow_always' },
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
      clock(),
    );
    expect(() => ChatItemSchema.parse(item)).not.toThrow();
    expect(item.kind === 'approval' && item.options?.map((o) => o.optionId)).toEqual([
      'allow_always',
      'allow',
      'reject',
    ]);
    expect(item.kind === 'approval' && item.resolution).toBe('pending');
  });

  it('still parses when ACP sends no command or cwd, which it never does', () => {
    // ACP permission requests name a tool call, not a shell command. Those
    // fields were required until this cutover, so an ACP approval would have
    // failed to parse — and a dropped approval is a tool that runs unasked.
    const item = approvalItemFor({ toolCall: { title: 'Run tests' }, options: [] }, clock());
    expect(() => ChatItemSchema.parse(item)).not.toThrow();
    expect(item.kind === 'approval' && item.command).toBeUndefined();
  });
});
