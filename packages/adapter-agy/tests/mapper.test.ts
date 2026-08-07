/**
 * The mapping is tested against recorded agy output, not hand-written guesses.
 *
 * Every fixture is verbatim stdout of `agy -p <text> --output-format stream-json`
 * on Windows, 2026-08-07. Nothing here is hand-written; a branch that only a
 * fabricated fixture could reach would be a branch nobody has evidence for.
 * `tests/fixtures/README.md` records how each one was produced and `record.mjs`
 * re-produces it; `provenance.test.ts` fails if the two drift apart.
 *
 *  - `turn-plain.ndjson`       no tools.
 *  - `turn-with-tool.ndjson`   `list_dir` on an empty directory — the run that
 *                              hid the `tool_info.output` bug, kept because that
 *                              no-output shape is real and must stay handled.
 *  - `turn-tool-output.ndjson` `list_dir` that returned `"alpha.txt\nbeta.txt"`,
 *                              plus a read of a missing file that agy refused
 *                              before running.
 *  - `turn-tool-error.ndjson`  five deliberately hostile steps; two tools
 *                              executed and failed with `state: "ERROR"`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  initialAgyTurnState,
  mapAgyEvent,
  mapAgyLines,
  type AcpSessionUpdate,
} from '../src/mapper.js';
import { NdjsonLineSplitter, parseAgyLine } from '../src/wire.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFixture(name: string): string[] {
  return readFileSync(path.join(fixtures, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function textOf(updates: readonly AcpSessionUpdate[]): string {
  return updates
    .flatMap((update) =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
        ? [update.content.text]
        : [],
    )
    .join('');
}

/** The text a client would actually render inside a tool card. */
function toolResultTextsOf(update: AcpSessionUpdate): string[] {
  if (!('content' in update) || !Array.isArray(update.content)) return [];
  return update.content.flatMap((block) =>
    block.type === 'content' && block.content.type === 'text' ? [block.content.text] : [],
  );
}

/**
 * Everything below reads the expected values back out of the recording instead
 * of hard-coding them, because re-recording a fixture must not mean rewriting
 * assertions — the moment it does, the cheap thing to do is to stop re-recording
 * and start hand-editing, which is how this package once ended up asserting a
 * `tool_info.error.type` that agy never emits.
 *
 * These read the raw JSON, never `mapAgyLines`, so they stay independent of the
 * code under test.
 */
interface RecordedStep {
  readonly index: number;
  readonly state: string;
  readonly stepType: string;
  readonly toolName: string | undefined;
  readonly output: string | undefined;
  readonly errorMessage: string | undefined;
  readonly parameters: Record<string, unknown> | undefined;
}

function stepsOf(lines: readonly string[]): RecordedStep[] {
  return lines.flatMap((line) => {
    const event = JSON.parse(line) as {
      event?: string;
      step_update?: {
        step_index?: number;
        state?: string;
        step_type?: string;
        tool_name?: string;
        tool_info?: {
          parameters?: Record<string, unknown>;
          output?: string;
          error?: { message?: string };
        };
      };
    };
    const step = event.step_update;
    if (event.event !== 'step_update' || step === undefined) return [];
    return [
      {
        index: step.step_index ?? -1,
        state: step.state ?? '',
        stepType: step.step_type ?? '',
        toolName: step.tool_name,
        output: step.tool_info?.output,
        errorMessage: step.tool_info?.error?.message,
        parameters: step.tool_info?.parameters,
      },
    ];
  });
}

/** The recorded tool steps in the given state, in wire order. */
function toolStepsOf(lines: readonly string[], state: string): RecordedStep[] {
  return stepsOf(lines).filter((step) => step.stepType === 'tool' && step.state === state);
}

/** agy's own `conversation_id`, taken from the init event. */
function conversationOf(lines: readonly string[]): string {
  const init = JSON.parse(lines[0] as string) as { event?: string; conversation_id?: string };
  expect(init.event).toBe('init');
  expect(typeof init.conversation_id).toBe('string');
  return init.conversation_id as string;
}

/**
 * The `toolCallId` the mapper must produce for a recorded step index.
 *
 * Composed here rather than restated at each site, and it carries the turn id
 * on purpose: agy's `step_index` restarts at zero every turn, so the id has to
 * name the turn as well or two turns' tool calls collide under one ACP id.
 * `'1'` is `initialAgyTurnState`'s default, which is what `mapAgyLines` folds
 * a single recording under.
 */
function expectedToolCallId(lines: readonly string[], index: number | undefined): string {
  return `${conversationOf(lines)}:1:${String(index)}`;
}

/** agy's own account of the turn, from the trailing result event. */
function resultOf(lines: readonly string[]): { status?: string; response?: string } {
  const last = JSON.parse(lines[lines.length - 1] as string) as {
    event?: string;
    result?: { status?: string; response?: string };
  };
  expect(last.event).toBe('result');
  return last.result ?? {};
}

describe('recorded plain turn', () => {
  const lines = loadFixture('turn-plain.ndjson');

  it('learns the conversation id from the init event', () => {
    const { state } = mapAgyLines(lines);
    expect(state.conversationId).toBe(conversationOf(lines));
  });

  it('emits only the agent text, and reassembles it exactly', () => {
    const { updates } = mapAgyLines(lines);
    expect(updates.map((update) => update.sessionUpdate)).toEqual(['agent_message_chunk']);
    expect(textOf(updates)).toBe('DONE\n');
  });

  it('skips user_input, unknown and checkpoint steps', () => {
    // The fixture contains one of each; none may reach the client.
    const stepTypes = lines
      .map((line) => JSON.parse(line) as { step_update?: { step_type?: string } })
      .flatMap((event) => (event.step_update?.step_type ? [event.step_update.step_type] : []));
    expect(stepTypes).toContain('user_input');
    expect(stepTypes).toContain('unknown');
    expect(stepTypes).toContain('checkpoint');

    const { updates } = mapAgyLines(lines);
    expect(updates).toHaveLength(1);
  });

  it('takes the stop reason from the result event', () => {
    expect(mapAgyLines(lines).stopReason).toBe('end_turn');
  });

  it('reports the undocumented error_message step as a diagnostic rather than dropping it', () => {
    const { diagnostics } = mapAgyLines(lines);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.reason).toBe('unmapped_step_type');
    expect(diagnostics[0]?.detail).toContain('error_message');
  });
});

describe('recorded turn with a tool call', () => {
  const lines = loadFixture('turn-with-tool.ndjson');

  it('opens one tool_call and closes it with a matching tool_call_update', () => {
    const { updates } = mapAgyLines(lines);
    const toolUpdates = updates.filter(
      (update) =>
        update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update',
    );
    expect(toolUpdates.map((update) => update.sessionUpdate)).toEqual([
      'tool_call',
      'tool_call_update',
    ]);

    const [opened, closed] = toolUpdates;
    // The ACTIVE and DONE steps share one step_index, so both updates must carry
    // the same id or the client cannot join them.
    const active = toolStepsOf(lines, 'ACTIVE');
    const done = toolStepsOf(lines, 'DONE');
    expect(active).toHaveLength(1);
    expect(done.map((step) => step.index)).toEqual(active.map((step) => step.index));
    const expectedId = expectedToolCallId(lines, active[0]?.index);
    expect(opened && 'toolCallId' in opened ? opened.toolCallId : null).toBe(expectedId);
    expect(closed && 'toolCallId' in closed ? closed.toolCallId : null).toBe(expectedId);
  });

  it('describes the tool call from tool_name and tool_info.parameters', () => {
    const { updates } = mapAgyLines(lines);
    const opened = updates.find((update) => update.sessionUpdate === 'tool_call');
    const recorded = toolStepsOf(lines, 'ACTIVE')[0];
    // agy resolved "this directory" to its own scratch dir, not to cwd — which
    // is why the recorded path is not the sandbox. Read it back rather than
    // restating it: the assertion is that the parameters survive the mapping.
    const directory = recorded?.parameters?.['DirectoryPath'];
    expect(typeof directory).toBe('string');
    expect(opened).toMatchObject({
      sessionUpdate: 'tool_call',
      title: 'list_dir',
      kind: 'read',
      status: 'in_progress',
      rawInput: { DirectoryPath: directory },
      locations: [{ path: directory }],
    });
  });

  it('marks the DONE tool step completed', () => {
    const { updates } = mapAgyLines(lines);
    const closed = updates.find((update) => update.sessionUpdate === 'tool_call_update');
    expect(closed).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'completed' });
  });

  it('streams agent text split across ACTIVE and DONE steps of one response', () => {
    // Recorded: step 5 arrived ACTIVE with "0\n" then DONE with "\n". text_delta
    // is a real delta, so filtering on state would silently truncate the reply.
    const { updates } = mapAgyLines(lines);
    expect(textOf(updates)).toBe('0\n\nDONE\n');
    // Which is exactly what agy reported as the turn's whole response.
    expect(textOf(updates)).toBe(resultOf(lines).response);
  });

  it('orders the tool call before the text that follows it', () => {
    const kinds = mapAgyLines(lines).updates.map((update) => update.sessionUpdate);
    expect(kinds).toEqual([
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
    ]);
  });
});

describe('recorded turn whose tool returned output', () => {
  const lines = loadFixture('turn-tool-output.ndjson');

  it("carries the tool's own result into the update, not just its status", () => {
    // The regression this fixture exists for: `tool_info.output` was undeclared
    // and unmapped, so the client got `status: completed` with nothing in it and
    // rendered a tool card whose body was blank.
    const done = toolStepsOf(lines, 'DONE');
    expect(done).toHaveLength(1);
    const recorded = done[0];
    // Guard the fixture itself: if the recording lost its output, the assertion
    // below would pass against nothing.
    expect(recorded?.output).toBeTypeOf('string');
    expect(recorded?.output).not.toBe('');

    const { updates } = mapAgyLines(lines);
    const closed = updates.find((update) => update.sessionUpdate === 'tool_call_update');
    expect(closed).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: expectedToolCallId(lines, recorded?.index),
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: recorded?.output } }],
    });
  });

  it('leaves no tool card for a call agy refused before running it', () => {
    // The turn asked for two things: a directory listing (ran) and a read of a
    // missing file (refused). agy emits a bare `error_message` step for the
    // refusal and *no* tool step — no ACTIVE, no DONE, no ERROR — so there is
    // nothing to render as a failed tool call. This asserts the gap rather than
    // pretending it is covered; see docs/ACP-MIGRATION.md.
    // The recording has an `error_message` step and exactly one tool.
    expect(stepsOf(lines).filter((step) => step.stepType === 'error_message')).toHaveLength(1);

    const { updates, diagnostics } = mapAgyLines(lines);
    const toolIds = updates.flatMap((update) =>
      'toolCallId' in update ? [update.toolCallId] : [],
    );
    expect(new Set(toolIds).size).toBe(1);
    expect(diagnostics.map((d) => d.reason)).toEqual(['unmapped_step_type']);
    expect(diagnostics[0]?.detail).toContain('error_message');

    // The user is not left with nothing: the refusal reaches the client, but as
    // prose in the assistant's reply, which no tool-card UI will surface.
    expect(textOf(updates)).toContain('invalid tool call error');
  });

  it('still reports SUCCESS for a turn in which a tool call was refused', () => {
    expect(resultOf(lines).status).toBe('SUCCESS');
    expect(mapAgyLines(lines).stopReason).toBe('end_turn');
  });
});

describe('recorded turn whose tools executed and failed', () => {
  const lines = loadFixture('turn-tool-error.ndjson');

  function closedAt(index: number) {
    return mapAgyLines(lines).updates.find(
      (update) =>
        update.sessionUpdate === 'tool_call_update' &&
        update.toolCallId === expectedToolCallId(lines, index),
    );
  }

  /** The recorded tool steps that agy itself marked ERROR, in wire order. */
  const errored = toolStepsOf(lines, 'ERROR');
  /** DONE tool steps, split by whether the tool reported anything at all. */
  const doneWithOutput = toolStepsOf(lines, 'DONE').filter((step) => step.output !== undefined);
  const doneWithoutOutput = toolStepsOf(lines, 'DONE').filter((step) => step.output === undefined);

  it('recorded the three shapes the assertions below depend on', () => {
    // Stated up front so a re-recording that failed to provoke them fails here,
    // loudly, instead of quietly making the rest of this block vacuous.
    expect(errored.length).toBeGreaterThanOrEqual(2);
    expect(doneWithOutput.length).toBeGreaterThanOrEqual(1);
    expect(doneWithoutOutput.length).toBeGreaterThanOrEqual(1);
    // The value a hand-written fixture once guessed wrong.
    const types = lines
      .map((line) => JSON.parse(line) as { step_update?: { tool_info?: { error?: { type?: string } } } })
      .flatMap((event) => {
        const type = event.step_update?.tool_info?.error?.type;
        return type === undefined ? [] : [type];
      });
    expect(new Set(types)).toEqual(new Set(['TOOL_ERROR']));
  });

  it('closes an ERROR tool step as failed and carries tool_info.error.message', () => {
    // `read_url_content` against a closed port: the tool ran, the fetch failed.
    const first = errored[0];
    expect(first?.errorMessage).toBeTypeOf('string');
    expect(closedAt(first?.index ?? -1)).toMatchObject({
      sessionUpdate: 'tool_call_update',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: first?.errorMessage } }],
    });
  });

  it('fails every errored tool independently, not just the first', () => {
    const failed = mapAgyLines(lines).updates.filter(
      (update) => update.sessionUpdate === 'tool_call_update' && update.status === 'failed',
    );
    expect(failed.map((update) => ('toolCallId' in update ? update.toolCallId : null))).toEqual(
      errored.map((step) => expectedToolCallId(lines, step.index)),
    );
  });

  it('does not mistake a non-zero shell exit for a tool failure', () => {
    // `cmd /c dir Z:\no-such-drive-here` exits 1, and agy still calls the step
    // DONE: the tool did its job. The command's own complaint is the output, so
    // marking this failed would misreport what happened.
    const step = doneWithOutput[0];
    expect(step?.output).toBeTypeOf('string');
    expect(closedAt(step?.index ?? -1)).toMatchObject({
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: step?.output } }],
    });
  });

  it('omits content entirely when the tool produced nothing', () => {
    // `cmd /c exit 7` sent no `output` key at all. An empty content array would
    // still make a client draw an empty result block.
    const closed = closedAt(doneWithoutOutput[0]?.index ?? -1);
    expect(closed).toMatchObject({ status: 'completed' });
    expect(closed && 'content' in closed).toBe(false);
  });

  it('ends the turn normally even though a tool failure set result.status ERROR', () => {
    // This is the whole point of the fixture. agy ran all five requested steps
    // and reported on each, so the turn plainly ended — but one failed tool is
    // enough to make `result.status` "ERROR". Reporting `refusal` for that told
    // the client the agent had declined, and ACP attaches a consequence to that
    // word: the prompt "won't be included in the next prompt". agy keeps it, so
    // the client's history would have drifted away from agy's.
    expect(resultOf(lines).status).toBe('ERROR');
    expect(textOf(mapAgyLines(lines).updates)).toBe(resultOf(lines).response);
    expect(mapAgyLines(lines).stopReason).toBe('end_turn');
  });

  it('reports the failures on the tool cards, which is where they belong', () => {
    // `end_turn` is only honest because nothing is lost by it: every failure is
    // still on the wire to the client, attached to the call that produced it.
    const failed = mapAgyLines(lines).updates.filter(
      (update) => update.sessionUpdate === 'tool_call_update' && update.status === 'failed',
    );
    expect(failed).toHaveLength(errored.length);
    expect(failed.flatMap(toolResultTextsOf)).toEqual(errored.map((step) => step.errorMessage));
  });
});

describe('mapper robustness', () => {
  it('is a pure fold: the same event and state always give the same result', () => {
    const event = parseAgyLine(
      '{"event":"step_update","step_update":{"step_index":7,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls"}}}}',
    );
    expect(event).toBeDefined();
    const state = initialAgyTurnState('conv-1');
    const first = mapAgyEvent(event!, state);
    const second = mapAgyEvent(event!, state);
    expect(second).toEqual(first);
    // The input state was not mutated on the way through.
    expect(state.announcedToolSteps).toEqual([]);
  });

  it('opens a tool call that only ever reports a terminal state', () => {
    // Defensive: a DONE with no preceding ACTIVE would otherwise ask the client
    // to update a card it was never given.
    const lines = [
      '{"event":"init","conversation_id":"c1"}',
      '{"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/tmp/a.txt"}}}}',
    ];
    const kinds = mapAgyLines(lines).updates.map((update) => update.sessionUpdate);
    expect(kinds).toEqual(['tool_call', 'tool_call_update']);
  });

  it('does not announce the same tool step twice', () => {
    const lines = [
      '{"event":"init","conversation_id":"c1"}',
      '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command"}}',
      '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command"}}',
    ];
    const kinds = mapAgyLines(lines).updates.map((update) => update.sessionUpdate);
    expect(kinds).toEqual(['tool_call', 'tool_call_update']);
  });

  it('reports an unparseable line without losing the rest of the turn', () => {
    const lines = [
      '{"event":"init","conversation_id":"c1"}',
      'not json at all',
      '{"event":"step_update","step_update":{"step_type":"agent_response","state":"DONE","text_delta":"hi"}}',
      '{"event":"result","result":{"status":"SUCCESS"}}',
    ];
    const result = mapAgyLines(lines);
    expect(result.diagnostics.map((d) => d.reason)).toEqual(['unparseable_line']);
    expect(textOf(result.updates)).toBe('hi');
    expect(result.stopReason).toBe('end_turn');
  });

  it('reports an unknown top-level event instead of throwing', () => {
    const result = mapAgyLines(['{"event":"brand_new_thing","payload":1}']);
    expect(result.updates).toEqual([]);
    expect(result.diagnostics[0]?.reason).toBe('unmapped_event');
  });

  it('ends without a stop reason when the stream is cut short', () => {
    const result = mapAgyLines(['{"event":"init","conversation_id":"c1"}']);
    expect(result.stopReason).toBeUndefined();
  });

  it('does not invent a stop reason for a status it has never seen', () => {
    // The old mapping sent every unrecognised status to `refusal`, which is the
    // one ACP reason that tells the client to drop the turn. Guessing that from
    // an unknown string is the most destructive available answer.
    const result = mapAgyLines([
      '{"event":"init","conversation_id":"c1"}',
      '{"event":"result","result":{"status":"SOMETHING_NEW"}}',
    ]);
    expect(result.stopReason).toBe('end_turn');
    expect(result.diagnostics.map((d) => d.reason)).toEqual(['unknown_result_status']);
    expect(result.diagnostics[0]?.detail).toContain('SOMETHING_NEW');
  });

  it('does not read a stop reason off Object.prototype', () => {
    // `status` is untrusted text from another process. A bare index into the
    // lookup table returns a *function* for "toString", which would then be
    // handed to the client as a stop reason.
    const result = mapAgyLines(['{"event":"result","result":{"status":"toString"}}']);
    expect(result.stopReason).toBe('end_turn');
    expect(result.diagnostics.map((d) => d.reason)).toEqual(['unknown_result_status']);
  });

  it('reports a result event that carries no status at all', () => {
    const result = mapAgyLines(['{"event":"result","result":{}}']);
    expect(result.stopReason).toBe('end_turn');
    expect(result.diagnostics.map((d) => d.reason)).toEqual(['unknown_result_status']);
  });

  it('defaults an unlisted tool to kind "other"', () => {
    const lines = [
      '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"tool","tool_name":"invoke_subagent"}}',
    ];
    expect(mapAgyLines(lines).updates[0]).toMatchObject({ kind: 'other', title: 'invoke_subagent' });
  });
});

describe('NdjsonLineSplitter', () => {
  it('reassembles a line split across chunks', () => {
    const splitter = new NdjsonLineSplitter();
    expect(splitter.push('{"event":"in')).toEqual([]);
    expect(splitter.push('it"}\n{"event":"result"}')).toEqual(['{"event":"init"}']);
    expect(splitter.flush()).toEqual(['{"event":"result"}']);
  });

  it('flushes nothing when the buffer holds only whitespace', () => {
    const splitter = new NdjsonLineSplitter();
    splitter.push('a\n  ');
    expect(splitter.flush()).toEqual([]);
  });

  it('feeding a recorded transcript one byte at a time yields the same mapping', () => {
    const raw = readFileSync(path.join(fixtures, 'turn-with-tool.ndjson'), 'utf8');
    const splitter = new NdjsonLineSplitter();
    const lines: string[] = [];
    for (const character of raw) lines.push(...splitter.push(character));
    lines.push(...splitter.flush());
    expect(mapAgyLines(lines)).toEqual(mapAgyLines(loadFixture('turn-with-tool.ndjson')));
  });
});
