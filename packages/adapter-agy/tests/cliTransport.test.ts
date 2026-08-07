/**
 * The `cli` transport, exercised with a fake child process. No agy is spawned.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgyCliTransport,
  buildAgyArgv,
  parseAgyModelList,
  resolveAgyPersistedDefault,
  type AgyChildProcess,
  type AgyCliTransportOptions,
  type AgySpawn,
  type AgySpawnOptions,
} from '../src/cliTransport.js';
import type { AgyTurnEvent } from '../src/transport.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

class FakeStream {
  #listener: ((chunk: string) => void) | null = null;
  setEncoding(): unknown {
    return this;
  }
  on(_event: 'data', listener: (chunk: string) => void): unknown {
    this.#listener = listener;
    return this;
  }
  emit(chunk: string): void {
    this.#listener?.(chunk);
  }
}

class FakeChild implements AgyChildProcess {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  killCount = 0;
  #onClose: ((code: number | null) => void) | null = null;
  #onError: ((error: Error) => void) | null = null;

  kill(): unknown {
    this.killCount += 1;
    return true;
  }
  once(event: 'error' | 'close', listener: (arg: never) => void): unknown {
    if (event === 'close') this.#onClose = listener as (code: number | null) => void;
    else this.#onError = listener as (error: Error) => void;
    return this;
  }
  closeWith(code: number | null): void {
    this.#onClose?.(code);
  }
  errorWith(error: Error): void {
    this.#onError?.(error);
  }
}

interface Harness {
  readonly transport: AgyCliTransport;
  readonly calls: { command: string; args: readonly string[]; options: AgySpawnOptions }[];
  readonly children: FakeChild[];
}

function harness(options: Omit<AgyCliTransportOptions, 'executable' | 'spawn'> = {}): Harness {
  const calls: Harness['calls'] = [];
  const children: FakeChild[] = [];
  const spawn: AgySpawn = (command, args, spawnOptions) => {
    calls.push({ command, args, options: spawnOptions });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return {
    transport: new AgyCliTransport({ executable: 'agy.exe', spawn, ...options }),
    calls,
    children,
  };
}

/** A settings.json standing in for `~/.gemini/antigravity-cli/settings.json`. */
function settingsFile(contents: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'agy-settings-')), 'settings.json');
  writeFileSync(file, contents, 'utf8');
  return file;
}

/** Verbatim `agy models` output, agy 1.1.11 — a banner line then id/tab/name. */
const MODELS_STDOUT =
  'Fetching available models...\n' +
  'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)\n' +
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n';

async function collect(events: AsyncIterable<AgyTurnEvent>): Promise<AgyTurnEvent[]> {
  const collected: AgyTurnEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe('buildAgyArgv', () => {
  it('omits --conversation on the first turn', () => {
    expect(
      buildAgyArgv({ prompt: 'hello', cwd: '/w', additionalDirectories: [], conversationId: null, model: null }),
    ).toEqual(['-p', 'hello', '--output-format', 'stream-json', '--add-dir', '/w']);
  });

  it('adds --conversation on later turns — this is what carries context', () => {
    expect(
      buildAgyArgv({
        prompt: 'hello',
        cwd: '/w',
        additionalDirectories: [],
        conversationId: 'conv-9',
        model: null,
      }),
    ).toEqual([
      '-p',
      'hello',
      '--output-format',
      'stream-json',
      '--add-dir',
      '/w',
      '--conversation',
      'conv-9',
    ]);
  });

  it('keeps a prompt containing spaces and quotes as one argv element', () => {
    // The `shell: true` bug: argv gets concatenated into an unescaped string, a
    // prompt with spaces is shredded, and --output-format is lost with it.
    const prompt = 'write a "hello world" script & exit';
    const argv = buildAgyArgv({
      prompt,
      cwd: '/w',
      additionalDirectories: [],
      conversationId: null,
      model: null,
    });
    expect(argv[1]).toBe(prompt);
    expect(argv).toContain('--output-format');
    expect(argv.filter((arg) => arg.includes('hello world'))).toHaveLength(1);
  });

  it('always sends the session cwd as --add-dir, because agy ignores the process cwd', () => {
    // The D5 defect. `spawn(..., { cwd })` is set and always was; agy 1.1.11
    // does not honour it, so a session opened on a directory with three files
    // had list_dir run in ~/.gemini/antigravity-cli/scratch and answer
    // "I found 0 files". The only public lever that moves agy's workspace is
    // this flag, and dropping it produces a confident wrong answer rather than
    // an error — which is why the assertion is on argv and not on options.cwd.
    const argv = buildAgyArgv({
      prompt: 'what files are here',
      cwd: 'C:\\project',
      additionalDirectories: [],
      conversationId: null,
      model: null,
    });
    expect(argv).toContain('--add-dir');
    expect(argv[argv.indexOf('--add-dir') + 1]).toBe('C:\\project');
  });

  it("maps ACP additionalDirectories onto agy's repeatable --add-dir, cwd first", () => {
    expect(
      buildAgyArgv({
        prompt: 'go',
        cwd: '/root',
        additionalDirectories: ['/extra-a', '/extra-b'],
        conversationId: null,
        model: null,
      }),
    ).toEqual([
      '-p',
      'go',
      '--output-format',
      'stream-json',
      '--add-dir',
      '/root',
      '--add-dir',
      '/extra-a',
      '--add-dir',
      '/extra-b',
    ]);
  });

  it('emits --model when the session pinned one', () => {
    // F1. This flag was never emitted at all, so every turn ran on whatever
    // `~/.gemini/antigravity-cli/settings.json` held — `Gemini 3.6 Flash (Low)`
    // on the machine this was measured on, while every fixture in this package
    // was recorded on Sonnet, and nothing in agy's output names the model.
    expect(
      buildAgyArgv({
        prompt: 'go',
        cwd: '/w',
        additionalDirectories: [],
        conversationId: null,
        model: 'claude-sonnet-4-6',
      }),
    ).toEqual([
      '-p',
      'go',
      '--output-format',
      'stream-json',
      '--model',
      'claude-sonnet-4-6',
      '--add-dir',
      '/w',
    ]);
  });

  it('emits no --model when nothing was pinned, rather than guessing one', () => {
    // `null` must reach argv as an absent flag, not as a resolved default: the
    // adapter reports "unpinned, agy chose" and argv has to match that claim.
    const argv = buildAgyArgv({
      prompt: 'go',
      cwd: '/w',
      additionalDirectories: [],
      conversationId: null,
      model: null,
    });
    expect(argv).not.toContain('--model');
  });

  it('does not repeat a root the client listed twice, or send an empty one', () => {
    const argv = buildAgyArgv({
      prompt: 'go',
      cwd: '/root',
      // A client that names cwd again in additionalDirectories is not an error;
      // it just must not produce a doubled flag.
      additionalDirectories: ['/root', '', '  ', '/extra'],
      conversationId: null,
      model: null,
    });
    expect(argv.filter((arg) => arg === '--add-dir')).toHaveLength(2);
    expect(argv.slice(argv.indexOf('--add-dir'))).toEqual([
      '--add-dir',
      '/root',
      '--add-dir',
      '/extra',
    ]);
  });
});

describe('parseAgyModelList', () => {
  it('reads the id/tab/name lines and skips the progress banner', () => {
    expect(parseAgyModelList(MODELS_STDOUT)).toEqual([
      { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
    ]);
  });

  it('invents nothing from a line with no tab', () => {
    // An id guessed from a banner goes straight into `--model` and fails the
    // turn five seconds later, with the reason in agy's stderr where no client
    // is looking. Skipping is the only safe reading of an unexpected line.
    expect(parseAgyModelList('Fetching available models...\nsomething went wrong\n')).toEqual([]);
    expect(parseAgyModelList('')).toEqual([]);
  });
});

describe('resolveAgyPersistedDefault', () => {
  const models = parseAgyModelList(MODELS_STDOUT);

  it('maps the display name agy saves back onto a --model id', () => {
    // settings.json stores `"model": "Gemini 3.6 Flash (Low)"` — the display
    // name, not the flag value — so the catalog is what recovers the id.
    expect(
      resolveAgyPersistedDefault(JSON.stringify({ model: 'Gemini 3.6 Flash (Low)' }), models),
    ).toEqual({ id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' });
  });

  it('reports a name it cannot map rather than guessing an id', () => {
    expect(resolveAgyPersistedDefault(JSON.stringify({ model: 'Some Retired Model' }), models))
      .toEqual({ id: null, name: 'Some Retired Model' });
  });

  it('is null for settings that name no model, or are not JSON', () => {
    expect(resolveAgyPersistedDefault('{}', models)).toBeNull();
    expect(resolveAgyPersistedDefault('{"model":""}', models)).toBeNull();
    expect(resolveAgyPersistedDefault('not json', models)).toBeNull();
  });
});

describe('AgyCliTransport.listModels', () => {
  it('runs `agy models` and reports what agy would default to', async () => {
    const { transport, calls, children } = harness({
      settingsPath: settingsFile(JSON.stringify({ model: 'Gemini 3.6 Flash (Low)' })),
    });
    const pending = transport.listModels();
    expect(calls[0]?.command).toBe('agy.exe');
    expect(calls[0]?.args).toEqual(['models']);

    children[0]!.stdout.emit(MODELS_STDOUT);
    children[0]!.closeWith(0);

    const catalog = await pending;
    expect(catalog.models.map((model) => model.id)).toEqual([
      'gemini-3.6-flash-low',
      'claude-sonnet-4-6',
    ]);
    expect(catalog.persistedDefault).toEqual({
      id: 'gemini-3.6-flash-low',
      name: 'Gemini 3.6 Flash (Low)',
    });
    expect(catalog.diagnostics).toEqual([]);
  });

  it('spawns `agy models` once however many times it is asked', async () => {
    const { transport, calls, children } = harness({ settingsPath: settingsFile('{}') });
    const first = transport.listModels();
    const second = transport.listModels();
    children[0]!.stdout.emit(MODELS_STDOUT);
    children[0]!.closeWith(0);
    await Promise.all([first, second]);
    expect(calls.filter((call) => call.args[0] === 'models')).toHaveLength(1);
  });

  it('reports a failed `agy models` instead of rejecting', async () => {
    // A session whose picker could not be filled is still a usable session; a
    // `session/new` that threw because a list call failed would not be.
    const { transport, children } = harness({ settingsPath: settingsFile('{}') });
    const pending = transport.listModels();
    children[0]!.closeWith(1);
    const catalog = await pending;
    expect(catalog.models).toEqual([]);
    expect(catalog.diagnostics.join('\n')).toMatch(/exited with code 1/);
  });

  it('reports a missing settings file rather than inventing a default', async () => {
    const { transport, children } = harness({
      settingsPath: path.join(tmpdir(), 'cozypad-no-such-agy-settings', 'settings.json'),
    });
    const pending = transport.listModels();
    children[0]!.stdout.emit(MODELS_STDOUT);
    children[0]!.closeWith(0);
    const catalog = await pending;
    expect(catalog.models).toHaveLength(2);
    expect(catalog.persistedDefault).toBeNull();
    expect(catalog.diagnostics.join('\n')).toMatch(/could not read agy's settings/);
  });

  it('retries after a failure instead of caching it for the whole process', async () => {
    // J2. `listModels` was `this.#catalog ??= this.#loadCatalog()` and the load
    // never rejects, so a single `agy models` failure — agy mid-update, a
    // network blip — stored an empty catalog permanently. Every later
    // set_config_option then answered "no model can be pinned in this process",
    // in sessions opened long after agy had recovered, and every turn silently
    // ran on agy's persisted default.
    const { transport, calls, children } = harness({
      settingsPath: settingsFile(JSON.stringify({ model: 'Gemini 3.6 Flash (Low)' })),
      modelListRetryCooldownMs: 0,
    });
    const models = () => calls.filter((call) => call.args[0] === 'models');

    const first = transport.listModels();
    children[0]!.closeWith(1);
    expect((await first).models).toEqual([]);

    // agy is back.
    const second = transport.listModels();
    expect(models()).toHaveLength(2);
    children[1]!.stdout.emit(MODELS_STDOUT);
    children[1]!.closeWith(0);
    expect((await second).models).toHaveLength(2);

    // …and the catalog that worked is kept, so this is a retry, not a re-fetch.
    expect((await transport.listModels()).models).toHaveLength(2);
    expect(models()).toHaveLength(2);
  });

  it('does not re-spawn `agy models` on every call while it is failing', async () => {
    // The other half of the retry: an agy that is genuinely gone must not cost a
    // subprocess — and up to modelListTimeoutMs of waiting — on every
    // session/new and every prompt.
    const { transport, calls, children } = harness({
      settingsPath: settingsFile('{}'),
      modelListRetryCooldownMs: 60_000,
    });
    const first = transport.listModels();
    children[0]!.closeWith(1);
    await first;

    const second = await transport.listModels();
    expect(calls.filter((call) => call.args[0] === 'models')).toHaveLength(1);
    expect(second.models).toEqual([]);
    // The reason is still attached, so the -32602 a client gets still says why.
    expect(second.diagnostics.join('\n')).toMatch(/exited with code 1/);
  });

  it('refreshes a stale catalog behind the answer, not in front of it', async () => {
    // The catalog is a snapshot: models are added and retired upstream, and a
    // process that never re-asks offers ids that no longer resolve until it is
    // restarted. The refresh must not put a network call in a turn's path, so
    // the cached answer is returned first.
    //
    // This test passed for a round while proving nothing a user could reach:
    // `AgyAgent` — the only production caller of `listModels` — cached a working
    // catalog for the life of the process, so no shipping configuration ever got
    // here. That is fixed at the caller (`AgyAgent.#models` now expires its
    // entry), and `endToEnd.test.ts` counts the `agy models` spawns to prove the
    // two layers actually compose. Keep that one alive alongside this one: a
    // unit test cannot tell "correct" from "unreachable".
    const { transport, calls, children } = harness({
      settingsPath: settingsFile('{}'),
      modelListTtlMs: 1,
      modelListRetryCooldownMs: 60_000,
    });
    const first = transport.listModels();
    children[0]!.stdout.emit(MODELS_STDOUT);
    children[0]!.closeWith(0);
    expect((await first).models).toHaveLength(2);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const stale = await transport.listModels();
    // Answered from cache — nothing was awaited on the new child.
    expect(stale.models).toHaveLength(2);
    expect(calls.filter((call) => call.args[0] === 'models')).toHaveLength(2);

    children[1]!.stdout.emit(`${MODELS_STDOUT}gemini-4-pro\tGemini 4 Pro\n`);
    children[1]!.closeWith(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await transport.listModels()).models.map((model) => model.id)).toContain(
      'gemini-4-pro',
    );
  });

  it('keeps the catalog that worked when a refresh fails', async () => {
    // A failed refresh must not be an outage: the ids we already know are still
    // the best answer available, and throwing them away would re-create the
    // permanent-empty-catalog bug one level up.
    const { transport, children } = harness({
      settingsPath: settingsFile('{}'),
      modelListTtlMs: 1,
      modelListRetryCooldownMs: 60_000,
    });
    const first = transport.listModels();
    children[0]!.stdout.emit(MODELS_STDOUT);
    children[0]!.closeWith(0);
    await first;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await transport.listModels();
    children[1]!.closeWith(1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await transport.listModels()).models).toHaveLength(2);
  });

  it('survives a logger that throws, and can still be asked again afterwards', async () => {
    // The logger belongs to whoever constructed the transport, so it is the one
    // thing in this path that really can throw. A rejected promise parked in the
    // in-flight slot would then be handed to every future caller forever — the
    // permanent-failure bug again, by a different route.
    const calls: { args: readonly string[] }[] = [];
    const children: FakeChild[] = [];
    const transport = new AgyCliTransport({
      executable: 'agy.exe',
      // A settings file that resolves cleanly, so the successful attempt below
      // produces no diagnostic and therefore never calls the exploding logger.
      settingsPath: settingsFile(JSON.stringify({ model: 'Gemini 3.6 Flash (Low)' })),
      modelListRetryCooldownMs: 0,
      logger: () => {
        throw new Error('logger exploded');
      },
      spawn: (_command, args) => {
        calls.push({ args });
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    });

    const first = transport.listModels();
    children[0]!.closeWith(1); // a diagnostic is produced, so the logger runs
    const failed = await first;
    expect(failed.models).toEqual([]);
    expect(failed.diagnostics.join('\n')).toMatch(/logger exploded/);

    const second = transport.listModels();
    expect(calls).toHaveLength(2);
    children[1]!.stdout.emit(MODELS_STDOUT);
    children[1]!.closeWith(0);
    expect((await second).models).toHaveLength(2);
  });

  it('gives up on an `agy models` that never answers', async () => {
    // `session/new` waits on this, and it is a network call.
    const { transport, children } = harness({
      settingsPath: settingsFile('{}'),
      modelListTimeoutMs: 5,
    });
    const catalog = await transport.listModels();
    expect(children[0]!.killCount).toBe(1);
    expect(catalog.models).toEqual([]);
    expect(catalog.diagnostics.join('\n')).toMatch(/did not answer within 5ms/);
  });
});

describe('AgyCliTransport.runTurn', () => {
  it('hands the injected spawn the executable, argv, cwd and stdio', () => {
    // Note what this canNOT cover: `shell`. The transport does not set it on the
    // options it passes here — `shell: false` lives in the default spawn lambda,
    // which an injected spawn replaces outright. The guard for that constraint is
    // tests/defaultSpawn.test.ts; an assertion here would be decorative.
    const { transport, calls } = harness();
    void transport.runTurn({ prompt: 'a b c', cwd: '/w', additionalDirectories: [], conversationId: null, model: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('agy.exe');
    expect(calls[0]?.args).toEqual([
      '-p',
      'a b c',
      '--output-format',
      'stream-json',
      '--add-dir',
      '/w',
    ]);
    // Both are set — but which one agy honours was measured separately, because
    // setting both means a passing workspace test proves nothing about either.
    // See tests/fixtures/proveWorkspace.mjs and docs/ACP-MIGRATION.md.
    expect(calls[0]?.options.cwd).toBe('/w');
    expect(calls[0]?.options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('turns a recorded transcript into conversation, updates and an end event', async () => {
    const { transport, children } = harness();
    const iterable = transport.runTurn({ prompt: 'hi', cwd: '/w', additionalDirectories: [], conversationId: null, model: null });
    const child = children[0];
    expect(child).toBeDefined();

    child!.stdout.emit(readFileSync(path.join(fixtures, 'turn-with-tool.ndjson'), 'utf8'));
    child!.closeWith(0);

    const events = await collect(iterable);
    expect(events[0]).toEqual({
      type: 'conversation',
      conversationId: 'e1d0d96e-c2b1-4a49-bc5b-e3b216059ad3',
    });
    expect(events.at(-1)).toEqual({ type: 'end', stopReason: 'end_turn' });
    expect(
      events.flatMap((event) => (event.type === 'update' ? [event.update.sessionUpdate] : [])),
    ).toEqual([
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
    ]);
  });

  it('parses events that arrive split across chunk boundaries', async () => {
    const { transport, children } = harness();
    const iterable = transport.runTurn({ prompt: 'hi', cwd: '/w', additionalDirectories: [], conversationId: null, model: null });
    const raw = readFileSync(path.join(fixtures, 'turn-plain.ndjson'), 'utf8');
    const middle = Math.floor(raw.length / 2);
    children[0]!.stdout.emit(raw.slice(0, middle));
    children[0]!.stdout.emit(raw.slice(middle));
    children[0]!.closeWith(0);

    const events = await collect(iterable);
    const text = events.flatMap((event) =>
      event.type === 'update' &&
      event.update.sessionUpdate === 'agent_message_chunk' &&
      event.update.content.type === 'text'
        ? [event.update.content.text]
        : [],
    );
    expect(text.join('')).toBe('DONE\n');
  });

  it('reads a final line that never got its newline', async () => {
    // The line has to be one whose *parsed* meaning differs from what the close
    // handler would fall back to, or the test cannot see `flush()` at all: with
    // `status: "SUCCESS"` + exit 0, dropping the unterminated line still yields
    // `end_turn` from the clean exit code and the test passes regardless.
    // `status: "CANCELLED"` + exit 0 discriminates — parsed it is `cancelled`,
    // unparsed it is `end_turn`. (It used to use `"ERROR"`, which stopped
    // discriminating once ERROR became `end_turn`; see mapper.ts.)
    const { transport, children } = harness();
    const iterable = transport.runTurn({ prompt: 'hi', cwd: '/w', additionalDirectories: [], conversationId: null, model: null });
    children[0]!.stdout.emit('{"event":"result","result":{"status":"CANCELLED"}}');
    children[0]!.closeWith(0);
    expect(await collect(iterable)).toEqual([{ type: 'end', stopReason: 'cancelled' }]);
  });

  it('reads a final unterminated line that carries text, not just a verdict', async () => {
    // Same guard from the other side: the content of the last line survives too.
    const { transport, children } = harness();
    const iterable = transport.runTurn({ prompt: 'hi', cwd: '/w', additionalDirectories: [], conversationId: null, model: null });
    children[0]!.stdout.emit('{"event":"init","conversation_id":"conv-tail"}\n');
    children[0]!.stdout.emit(
      '{"event":"step_update","step_update":{"step_type":"agent_response","state":"DONE","text_delta":"tail"}}',
    );
    children[0]!.closeWith(0);

    const events = await collect(iterable);
    expect(
      events.flatMap((event) =>
        event.type === 'update' &&
        event.update.sessionUpdate === 'agent_message_chunk' &&
        event.update.content.type === 'text'
          ? [event.update.content.text]
          : [],
      ),
    ).toEqual(['tail']);
  });

  it('ends the turn as cancelled when the signal aborts', async () => {
    const { transport, children } = harness();
    const abort = new AbortController();
    const iterable = transport.runTurn({
      prompt: 'hi',
      cwd: '/w', additionalDirectories: [],
      conversationId: null,
      model: null,
      signal: abort.signal,
    });

    abort.abort();
    expect(children[0]!.killCount).toBe(1);
    children[0]!.closeWith(null);

    expect(await collect(iterable)).toEqual([{ type: 'end', stopReason: 'cancelled' }]);
  });

  it('ends normally when agy exits cleanly without a result event', async () => {
    const { transport, children } = harness();
    const iterable = transport.runTurn({ prompt: 'hi', cwd: '/w', additionalDirectories: [], conversationId: null, model: null });
    children[0]!.closeWith(0);
    expect(await collect(iterable)).toEqual([{ type: 'end', stopReason: 'end_turn' }]);
  });

  it('fails loudly when agy exits non-zero without a result event', async () => {
    const { transport, children } = harness();
    const iterable = transport.runTurn({ prompt: 'hi', cwd: '/w', additionalDirectories: [], conversationId: null, model: null });
    children[0]!.closeWith(3);
    await expect(collect(iterable)).rejects.toThrow(/exited with code 3/);
  });

  it('keeps the verdict agy reported rather than overriding it with the exit code', async () => {
    const { transport, children } = harness();
    const iterable = transport.runTurn({ prompt: 'hi', cwd: '/w', additionalDirectories: [], conversationId: null, model: null });
    children[0]!.stdout.emit('{"event":"result","result":{"status":"CANCELLED"}}\n');
    children[0]!.closeWith(1);
    expect(await collect(iterable)).toEqual([{ type: 'end', stopReason: 'cancelled' }]);
  });

  it('does not turn a tool-failure ERROR into a thrown turn, whatever the exit code', async () => {
    // agy sets `result.status: "ERROR"` when any tool failed, and the recorded
    // run that did so exited 0 (tests/fixtures/turn-tool-error.ndjson). Should a
    // build ever pair that status with a non-zero exit, the answer is still the
    // turn agy actually completed — not an exception that discards it.
    const { transport, children } = harness();
    const iterable = transport.runTurn({ prompt: 'hi', cwd: '/w', additionalDirectories: [], conversationId: null, model: null });
    children[0]!.stdout.emit('{"event":"result","result":{"status":"ERROR"}}\n');
    children[0]!.closeWith(1);
    expect(await collect(iterable)).toEqual([{ type: 'end', stopReason: 'end_turn' }]);
  });

  it('surfaces a spawn error to the caller', async () => {
    const { transport, children } = harness();
    const iterable = transport.runTurn({ prompt: 'hi', cwd: '/w', additionalDirectories: [], conversationId: null, model: null });
    children[0]!.errorWith(new Error('ENOENT agy.exe'));
    await expect(collect(iterable)).rejects.toThrow(/ENOENT/);
  });

  it('routes agy stderr to the logger, never to the client', async () => {
    const logged: string[] = [];
    const children: FakeChild[] = [];
    const spawn: AgySpawn = () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    };
    const transport = new AgyCliTransport({ spawn, logger: (m) => logged.push(m) });
    const iterable = transport.runTurn({ prompt: 'hi', cwd: '/w', additionalDirectories: [], conversationId: null, model: null });
    children[0]!.stderr.emit('warning: something\n');
    children[0]!.closeWith(0);

    const events = await collect(iterable);
    expect(events.some((event) => event.type === 'diagnostic')).toBe(false);
    expect(logged).toEqual(['agy stderr: warning: something']);
  });

  it('gives two turns of one conversation distinct tool call ids', async () => {
    // ACP requires `toolCallId` to be unique within the *session*, and agy's
    // `step_index` is unique only within a turn: each turn is a new `agy -p`
    // process counting from zero. Both turns below replay the same recording,
    // which is the honest worst case — same conversation id, same step index,
    // different tool call. Reusing one id there does not merely mislabel the
    // second call: a client keys its tool cards by this id, so the second turn
    // would reach in and rewrite the finished card sitting in the first turn's
    // transcript.
    const { transport, children } = harness();
    const recording = readFileSync(path.join(fixtures, 'turn-with-tool.ndjson'), 'utf8');

    const idsOfTurn = async (conversationId: string | null): Promise<string[]> => {
      const at = children.length;
      const iterable = transport.runTurn({ prompt: 'hi', cwd: '/w', additionalDirectories: [], conversationId, model: null });
      children[at]!.stdout.emit(recording);
      children[at]!.closeWith(0);
      return (await collect(iterable)).flatMap((event) =>
        event.type === 'update' && 'toolCallId' in event.update ? [event.update.toolCallId] : [],
      );
    };

    const first = await idsOfTurn(null);
    const second = await idsOfTurn('e1d0d96e-c2b1-4a49-bc5b-e3b216059ad3');

    // Within a turn the id is still shared, or the client cannot join the
    // `tool_call` to its `tool_call_update`.
    expect(new Set(first).size).toBe(1);
    expect(new Set(second).size).toBe(1);
    // Across turns it must not be.
    expect(second[0]).not.toBe(first[0]);
  });

  it('does not re-announce a conversation id it was given up front', async () => {
    const { transport, children } = harness();
    const iterable = transport.runTurn({ prompt: 'hi', cwd: '/w', additionalDirectories: [], conversationId: 'conv-1', model: null });
    children[0]!.stdout.emit('{"event":"init","conversation_id":"conv-1"}\n');
    children[0]!.closeWith(0);
    const events = await collect(iterable);
    expect(events.some((event) => event.type === 'conversation')).toBe(false);
  });
});

describe('AgyCliTransportOptions.modelListTtlMs default', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes a working catalog after ten minutes, and not one millisecond before', async () => {
    // Every other test in this file passes `modelListTtlMs` explicitly, so the
    // `?? 600_000` fallback was reachable only in production. Both directions
    // of getting it wrong are silent:
    //
    //   `?? 0`  — the `> 0` guard turns the refresh off, and a catalog fetched
    //             at startup is served for the life of the process. That is
    //             "success is permanent": ids retired upstream keep being
    //             offered, and pinning one fails at the far end with no clue
    //             why. The comment above `listModels` describes this defect as
    //             fixed; nothing checked that it stayed fixed.
    //   `?? 1`  — every call re-spawns `agy models` behind the answer. Correct
    //             output, a subprocess per request.
    //
    // Only `Date` is faked. `listModels` reads the clock through `Date.now()`,
    // while the refresh it triggers completes on real microtasks — faking the
    // timers too would deadlock the awaits below.
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);

    const { transport, calls, children } = harness({
      settingsPath: settingsFile('{}'),
      modelListRetryCooldownMs: 60_000,
      // modelListTtlMs deliberately omitted — the default is the subject.
    });
    const modelSpawns = () => calls.filter((call) => call.args[0] === 'models').length;

    const first = transport.listModels();
    children[0]!.stdout.emit(MODELS_STDOUT);
    children[0]!.closeWith(0);
    expect((await first).models).toHaveLength(2);
    expect(modelSpawns()).toBe(1);

    vi.setSystemTime(t0 + 599_999);
    expect((await transport.listModels()).models).toHaveLength(2);
    expect(modelSpawns()).toBe(1);

    vi.setSystemTime(t0 + 600_000);
    // Still answered from cache — the refresh runs behind it, never in front.
    expect((await transport.listModels()).models).toHaveLength(2);
    expect(modelSpawns()).toBe(2);

    // Settle the refresh so it does not outlive the test.
    children[1]!.stdout.emit(MODELS_STDOUT);
    children[1]!.closeWith(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe('AgyCliTransportOptions.modelListTimeoutMs default', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives `agy models` twenty seconds, and not one millisecond more', async () => {
    // The sibling two lines above `modelListTtlMs`, and unasserted for the same
    // reason: every test in this file injects its own value (`modelListTimeoutMs: 5`),
    // so `?? 20_000` was reachable only in production. Changing it to `?? 30_000`
    // left all 220 tests green.
    //
    // 30_000 is the specific wrong value that matters. `session/new` waits on
    // this call, and the client's own ceiling is
    // `DEFAULT_REQUEST_TIMEOUT_MS = 30_000` (packages/acp-client/src/connect.ts).
    // At 20s the transport gives up first and `session/new` answers with an
    // empty catalog plus a diagnostic — a session with no model picker, which is
    // survivable. At 30s the two race, and the client's budget expires on a call
    // that was about to succeed: `session/new` fails outright.
    //
    // No test and no line of documentation asserted that ordering, and no test
    // imports both packages. This one at least pins this end of it; the comment
    // above `#modelListTimeoutMs` in the source names the other end.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { transport, children } = harness({ settingsPath: settingsFile('{}') });

    const pending = transport.listModels();
    vi.advanceTimersByTime(19_999);
    expect(children[0]!.killCount).toBe(0);

    vi.advanceTimersByTime(1);
    expect(children[0]!.killCount).toBe(1);

    const catalog = await pending;
    expect(catalog.models).toEqual([]);
    expect(catalog.diagnostics.join('\n')).toMatch(/did not answer within 20000ms/);
  });
});
