import { describe, expect, it } from 'vitest';
import {
  parseCodexAppServerLine,
  type CodexParseContext,
} from '../src/main/adapters/codexAppServer';

function context(): CodexParseContext {
  let sequence = 0;
  return {
    localSessionId: 'local-1',
    nextSequence: () => ++sequence,
    nextEventId: () => `event-${sequence + 1}`,
    now: () => '2026-08-02T00:00:00.000Z',
  };
}

describe('Codex app-server adapter', () => {
  it('binds the returned Codex thread and advertises supported local commands', () => {
    const events = parseCodexAppServerLine(
      JSON.stringify({
        id: 'thread_start',
        result: { thread: { id: 'thr_123', sessionId: 'thr_123' } },
      }),
      context(),
    );

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'session_initialized',
        agentKind: 'codex',
        agentConversationId: 'thr_123',
        slashCommands: ['compact', 'diff', 'review', 'status'],
      }),
    ]);
  });

  it('normalizes streamed messages, commands, diffs, and completion', () => {
    const state = context();
    const lines = [
      { method: 'item/started', params: { item: { type: 'agentMessage', id: 'msg-1', text: '' } } },
      { method: 'item/agentMessage/delta', params: { itemId: 'msg-1', delta: 'Hello' } },
      { method: 'item/completed', params: { item: { type: 'agentMessage', id: 'msg-1', text: 'Hello' } } },
      { method: 'item/started', params: { item: { type: 'commandExecution', id: 'cmd-1', command: 'git status', cwd: '/srv/project' } } },
      { method: 'item/commandExecution/outputDelta', params: { itemId: 'cmd-1', delta: 'clean\n' } },
      { method: 'item/completed', params: { item: { type: 'commandExecution', id: 'cmd-1', status: 'completed', aggregatedOutput: 'clean\n' } } },
      { method: 'item/completed', params: { item: { type: 'fileChange', id: 'patch-1', status: 'completed', changes: [{ path: 'train.py', diff: '@@\n-old\n+new' }] } } },
      { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } },
    ];
    const events = lines.flatMap((line) =>
      parseCodexAppServerLine(JSON.stringify(line), state),
    );

    expect(events.map((event) => event.kind)).toEqual([
      'assistant_message_started',
      'assistant_text_delta',
      'assistant_message_completed',
      'tool_call_started',
      'tool_call_updated',
      'tool_call_completed',
      'tool_call_completed',
      'file_diff',
      'turn_completed',
    ]);
    expect(events.find((event) => event.kind === 'file_diff')).toMatchObject({
      path: 'train.py',
      additions: 1,
      deletions: 1,
    });
  });

  it('normalizes JSON-RPC approvals and user questions', () => {
    const state = context();
    const approval = parseCodexAppServerLine(
      JSON.stringify({
        id: 41,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'python train.py', reason: 'Runs training' },
      }),
      state,
    );
    // Method names match `codex app-server generate-ts` for the pinned CLI:
    // the question request is namespaced under `item/` just like the
    // approvals. Listening for the unprefixed name silently swallowed every
    // question Codex asked, leaving the turn waiting forever.
    const questions = parseCodexAppServerLine(
      JSON.stringify({
        id: 'question-9',
        method: 'item/tool/requestUserInput',
        params: {
          questions: [
            {
              id: 'q-seed',
              header: 'Split',
              question: 'Which seed?',
              options: [
                { label: '42', description: 'Baseline' },
                { label: '123', description: 'Ablation' },
              ],
            },
          ],
        },
      }),
      state,
    );
    const unprefixed = parseCodexAppServerLine(
      JSON.stringify({
        id: 'question-10',
        method: 'tool/requestUserInput',
        params: { questions: [{ header: 'x', question: 'y', options: [] }] },
      }),
      state,
    );

    expect(approval[0]).toMatchObject({
      kind: 'approval_requested',
      approvalId: '41',
      command: 'python train.py',
    });
    expect(questions[0]).toMatchObject({
      kind: 'question_requested',
      questionId: 'question-9:0',
      prompt: 'Split: Which seed?',
    });
    expect(unprefixed).toEqual([]);
  });
});
