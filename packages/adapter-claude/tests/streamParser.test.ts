import { describe, expect, it } from 'vitest';
import { NormalizedAgentEventSchema } from '@cozypad/contracts';
import {
  buildClaudeArgv,
  buildClaudeStreamingArgv,
  parseClaudeStreamLine,
} from '../src/index';
import type { ClaudeParseContext } from '../src/streamParser';

function context(): ClaudeParseContext {
  let sequence = 0;
  let eventId = 0;
  return {
    localSessionId: 'local-1',
    nextSequence: () => sequence++,
    nextEventId: () => `evt-${eventId++}`,
    now: () => '2026-07-29T12:00:00Z',
  };
}

const INIT_LINE = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'conv-abc123',
  model: 'claude-sonnet-5',
  cwd: '/home/y/projects/seg-train',
  tools: ['Bash', 'Read'],
  slash_commands: ['compact', 'clear', 'project-review'],
});

const TEXT_LINE = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: '我先看 GPU 狀態。' }] },
  session_id: 'conv-abc123',
});

const TOOL_USE_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'nvidia-smi' } },
    ],
  },
  session_id: 'conv-abc123',
});

const TOOL_RESULT_LINE = JSON.stringify({
  type: 'user',
  message: {
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_01', content: 'GPU 0: 36%', is_error: false },
    ],
  },
  session_id: 'conv-abc123',
});

const RESULT_LINE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  session_id: 'conv-abc123',
  total_cost_usd: 0.042,
  usage: { input_tokens: 1200, output_tokens: 340 },
});

describe('buildClaudeArgv', () => {
  it('builds the structured-mode argv', () => {
    expect(buildClaudeArgv({})).toEqual([
      'claude', '-p', '--output-format', 'stream-json', '--verbose',
    ]);
  });

  it('appends resume when continuing a conversation', () => {
    expect(buildClaudeArgv({ resumeConversationId: 'conv-abc123' })).toContain('--resume');
  });

  it('builds the persistent bidirectional argv in print mode', () => {
    expect(
      buildClaudeStreamingArgv({ permissionPromptTool: 'stdio' }),
    ).toEqual([
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
      '--permission-prompt-tool',
      'stdio',
    ]);
  });

  it('uses a discovered executable and explicit dangerous permission mode', () => {
    const argv = buildClaudeStreamingArgv({
      executable: '/home/researcher/tools/claude',
      dangerouslySkipPermissions: true,
    });

    expect(argv[0]).toBe('/home/researcher/tools/claude');
    expect(argv).toContain('--dangerously-skip-permissions');
    expect(argv).not.toContain('--permission-prompt-tool');
  });
});

describe('parseClaudeStreamLine', () => {
  it('maps init to session_initialized and captures the conversation id', () => {
    const ctx = context();
    const events = parseClaudeStreamLine(INIT_LINE, ctx);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'session_initialized',
      agentConversationId: 'conv-abc123',
      model: 'claude-sonnet-5',
      cwd: '/home/y/projects/seg-train',
      slashCommands: ['compact', 'clear', 'project-review'],
    });
    expect(ctx.agentConversationId).toBe('conv-abc123');
  });

  it('maps assistant text and tool_use', () => {
    const ctx = context();
    parseClaudeStreamLine(INIT_LINE, ctx);
    const textEvents = parseClaudeStreamLine(TEXT_LINE, ctx);
    expect(textEvents[0]).toMatchObject({
      kind: 'assistant_message_completed',
      text: '我先看 GPU 狀態。',
      agentConversationId: 'conv-abc123',
    });
    const toolEvents = parseClaudeStreamLine(TOOL_USE_LINE, ctx);
    expect(toolEvents[0]).toMatchObject({
      kind: 'tool_call_started',
      toolCallId: 'toolu_01',
      name: 'Bash',
    });
    expect((toolEvents[0] as { inputSummary: string }).inputSummary).toContain(
      'nvidia-smi',
    );
  });

  it('maps tool_result to tool_call_completed', () => {
    const events = parseClaudeStreamLine(TOOL_RESULT_LINE, context());
    expect(events[0]).toMatchObject({
      kind: 'tool_call_completed',
      toolCallId: 'toolu_01',
      output: 'GPU 0: 36%',
      isError: false,
    });
  });

  it('maps result to usage + turn_completed', () => {
    const events = parseClaudeStreamLine(RESULT_LINE, context());
    expect(events.map((event) => event.kind)).toEqual(['usage', 'turn_completed']);
    expect(events[0]).toMatchObject({
      inputTokens: 1200,
      outputTokens: 340,
      costUsd: 0.042,
    });
    expect(events[1]).toMatchObject({ stopReason: 'success' });
  });

  it('maps stdio permission requests to approval cards', () => {
    const events = parseClaudeStreamLine(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req_approval',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'python train.py' },
        },
      }),
      context(),
    );
    expect(events[0]).toMatchObject({
      kind: 'approval_requested',
      approvalId: 'req_approval',
      command: expect.stringContaining('python train.py'),
    });
  });

  it('maps AskUserQuestion control requests to selectable questions', () => {
    const events = parseClaudeStreamLine(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req_question',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: {
            questions: [
              {
                header: 'Split',
                question: 'Which validation strategy?',
                options: [{ label: 'Fixed seed' }, { label: 'K-fold' }],
              },
            ],
          },
        },
      }),
      context(),
    );
    expect(events[0]).toMatchObject({
      kind: 'question_requested',
      questionId: 'req_question:0',
      prompt: 'Split: Which validation strategy?',
      options: [{ label: 'Fixed seed' }, { label: 'K-fold' }],
    });
  });

  it('adds agent_error for error results', () => {
    const errorLine = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      result: 'max turns reached',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const kinds = parseClaudeStreamLine(errorLine, context()).map((event) => event.kind);
    expect(kinds).toEqual(['usage', 'agent_error', 'turn_completed']);
  });

  it('tolerates unknown event types silently', () => {
    expect(
      parseClaudeStreamLine('{"type":"stream_event","event":{}}', context()),
    ).toEqual([]);
    expect(parseClaudeStreamLine('', context())).toEqual([]);
  });

  it('produces agent_error for unparseable lines', () => {
    const events = parseClaudeStreamLine('not json at all', context());
    expect(events[0]?.kind).toBe('agent_error');
  });

  it('every produced event validates against the shared contract', () => {
    const ctx = context();
    const all = [INIT_LINE, TEXT_LINE, TOOL_USE_LINE, TOOL_RESULT_LINE, RESULT_LINE]
      .flatMap((line) => parseClaudeStreamLine(line, ctx));
    expect(all.length).toBeGreaterThan(4);
    for (const event of all) {
      expect(() => NormalizedAgentEventSchema.parse(event)).not.toThrow();
    }
    const sequences = all.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });
});
