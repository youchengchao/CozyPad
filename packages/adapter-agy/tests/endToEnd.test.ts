/**
 * End to end over the real protocol.
 *
 * A real `ClientSideConnection` talks JSON-RPC to a real `AgentSideConnection`
 * across real streams, and the transport spawns a real child process over real
 * pipes. The only substitution is the model itself: `fakeAgy.mjs` replays a
 * transcript that was recorded from the actual `agy` CLI on 2026-08-07.
 *
 * This is what proves the pieces fit together — the mapper tests only prove the
 * mapping.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type SessionConfigOption,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { AgentSideConnection } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AGY_CONVERSATION_META_KEY,
  AGY_LIMITATIONS_META_KEY,
  AGY_MODEL_CONFIG_ID,
  AGY_MODEL_META_KEY,
  AGY_MODEL_UNPINNED_VALUE,
  AGY_PERMISSION_MODE_ID,
  AGY_RESUME_META_KEY,
  AgyAgent,
} from '../src/agent.js';
import { AgyCliTransport, type AgyChildProcess } from '../src/cliTransport.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeAgy = path.join(here, 'fixtures', 'fakeAgy.mjs');
/** The id inside tests/fixtures/turn-with-tool.ndjson, recorded from real agy. */
const RECORDED_CONVERSATION_ID = 'e1d0d96e-c2b1-4a49-bc5b-e3b216059ad3';

interface Wiring {
  readonly client: ClientSideConnection;
  readonly received: SessionNotification[];
  readonly argvLog: string;
  close(): void;
}

/**
 * The turns in an argv log.
 *
 * `agy models` is spawned once per adapter process to fill the model picker, and
 * `fakeAgy.mjs` records that invocation like any other. Filtering it here rather
 * than hiding it in the fake keeps the log a complete record of what was really
 * launched — {@link modelListCallsIn} asserts on the part filtered out.
 */
function turnsIn(argvLog: string): { argv: string[]; cwd: string }[] {
  const calls = JSON.parse(readFileSync(argvLog, 'utf8')) as { argv: string[]; cwd: string }[];
  return calls.filter((call) => call.argv[0] !== 'models');
}

function modelListCallsIn(argvLog: string): { argv: string[] }[] {
  const calls = JSON.parse(readFileSync(argvLog, 'utf8')) as { argv: string[] }[];
  return calls.filter((call) => call.argv[0] === 'models');
}

/** Cache lifetimes, so a test can watch the two layers compose. */
interface WireCaching {
  /** The transport's own stale-while-revalidate interval. */
  readonly modelListTtlMs?: number;
  /** How long `AgyAgent` reuses a catalog before re-asking the transport. */
  readonly modelCatalogTtlMs?: number;
}

function wire(existingArgvLog?: string, fixture?: string, caching: WireCaching = {}): Wiring {
  const scratch = mkdtempSync(path.join(tmpdir(), 'agy-e2e-'));
  const argvLog = existingArgvLog ?? path.join(scratch, 'argv.json');
  // Stands in for ~/.gemini/antigravity-cli/settings.json. Pointed at a temp
  // file so the assertions do not depend on which model the developer running
  // the suite last picked in agy — which is the very nondeterminism under test.
  const settingsPath = path.join(scratch, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ model: 'Gemini 3.6 Flash (Low)' }), 'utf8');

  // The real `agy.exe` is swapped for a node replayer; everything else about the
  // spawn — argv array, pipes, chunking, exit code — is genuine.
  const transport = new AgyCliTransport({
    executable: process.execPath,
    settingsPath,
    ...(caching.modelListTtlMs === undefined ? {} : { modelListTtlMs: caching.modelListTtlMs }),
    spawn: (_command, args, options) =>
      nodeSpawn(process.execPath, [fakeAgy, ...args], {
        cwd: options.cwd,
        env: {
          ...options.env,
          FAKE_AGY_ARGV_LOG: argvLog,
          ...(fixture === undefined ? {} : { FAKE_AGY_FIXTURE: fixture }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      }) as unknown as AgyChildProcess,
  });

  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();

  new AgentSideConnection(
    (connection) =>
      new AgyAgent(connection, {
        transport,
        ...(caching.modelCatalogTtlMs === undefined
          ? {}
          : { modelCatalogTtlMs: caching.modelCatalogTtlMs }),
      }),
    ndJsonStream(agentToClient.writable, clientToAgent.readable),
  );

  const received: SessionNotification[] = [];
  const clientHandler: Client = {
    async sessionUpdate(params) {
      received.push(params);
    },
    async requestPermission() {
      throw new Error('agy print mode never asks for permission');
    },
    async readTextFile() {
      throw new Error('not used');
    },
    async writeTextFile() {
      throw new Error('not used');
    },
  };

  const client = new ClientSideConnection(
    () => clientHandler,
    ndJsonStream(clientToAgent.writable, agentToClient.readable),
  );

  return {
    client,
    received,
    argvLog,
    close: () => {
      void clientToAgent.writable.close().catch(() => {});
      void agentToClient.writable.close().catch(() => {});
    },
  };
}

let active: Wiring | null = null;
afterEach(() => {
  active?.close();
  active = null;
});

/**
 * The `tool_info.output` of the one DONE tool step in a recording.
 *
 * Read back rather than restated: docs/ACP-MIGRATION.md forbids hard-coding
 * tool output in tests, because re-recording a fixture then costs a sweep of
 * edited assertions — and that cost is exactly what tempts someone to hand-edit
 * the recording instead.
 */
function recordedToolOutput(fixture: string): string {
  const output = readFileSync(path.join(here, 'fixtures', fixture), 'utf8')
    .split('\n')
    .flatMap((line) => (line.trim() === '' ? [] : [JSON.parse(line) as unknown]))
    .flatMap((event) => {
      const step = (event as { step_update?: { state?: string; tool_info?: { output?: unknown } } })
        .step_update;
      const value = step?.state === 'DONE' ? step.tool_info?.output : undefined;
      return typeof value === 'string' && value !== '' ? [value] : [];
    });
  expect(output).toHaveLength(1);
  return output[0] as string;
}

function textOf(notifications: readonly SessionNotification[]): string {
  return notifications
    .map((notification) => notification.update)
    .flatMap((update) =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
        ? [update.content.text]
        : [],
    )
    .join('');
}

describe('agy ACP agent, end to end', () => {
  it('completes a handshake, streams a turn, and continues the conversation', async () => {
    const wiring = wire();
    active = wiring;

    const initialize = await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    expect(initialize.protocolVersion).toBe(PROTOCOL_VERSION);
    // Resume, not load: this agent cannot replay a transcript, and says so.
    expect(initialize.agentCapabilities?.loadSession).toBe(false);
    expect(initialize.agentCapabilities?.sessionCapabilities?.resume).toEqual({});

    // D7 over the wire. `_meta` and `modes` are the two channels that tell the
    // client its permission policy will not be consulted, and an in-process
    // assertion proves neither survives JSON-RPC and the client's own schema.
    const limits = initialize.agentCapabilities?._meta?.[AGY_LIMITATIONS_META_KEY] as {
      requestsPermission?: boolean;
      permissionMode?: string;
    };
    expect(limits.requestsPermission).toBe(false);

    const session = await wiring.client.newSession({ cwd: here, mcpServers: [] });
    const { sessionId } = session;
    expect(sessionId).toMatch(/^agy-/);
    expect(session.modes?.currentModeId).toBe(AGY_PERMISSION_MODE_ID);
    expect(session.modes?.availableModes.map((mode) => mode.id)).toEqual([
      AGY_PERMISSION_MODE_ID,
    ]);

    // --- turn 1: the recorded transcript containing a tool call ---
    const promptText = 'list this directory and say "done please"';
    const turn1 = await wiring.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: promptText }],
    });
    expect(turn1.stopReason).toBe('end_turn');

    const kinds = wiring.received.map((notification) => notification.update.sessionUpdate);
    expect(kinds).toEqual([
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
    ]);
    expect(textOf(wiring.received)).toBe('0\n\nDONE\n');
    expect(wiring.received.every((n) => n.sessionId === sessionId)).toBe(true);

    // --- turn 2: must reuse the conversation id agy handed back ---
    wiring.received.length = 0;
    const turn2 = await wiring.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'and again' }],
    });
    expect(turn2.stopReason).toBe('end_turn');
    expect(textOf(wiring.received)).toBe('DONE\n');

    const calls = turnsIn(wiring.argvLog);
    expect(calls).toHaveLength(2);

    // The prompt survived spawning as a single argv element, spaces and quotes
    // intact — the failure mode that `shell: true` causes on Windows.
    expect(calls[0]?.argv).toEqual([
      '-p',
      promptText,
      '--output-format',
      'stream-json',
      '--add-dir',
      here,
    ]);

    // Turn 2 carried --conversation, which is what makes context continue.
    expect(calls[1]?.argv).toEqual([
      '-p',
      'and again',
      '--output-format',
      'stream-json',
      '--add-dir',
      here,
      '--conversation',
      'e1d0d96e-c2b1-4a49-bc5b-e3b216059ad3',
    ]);

    // And it ran in the session's cwd — which agy ignores, hence --add-dir above.
    expect(path.resolve(calls[0]?.cwd ?? '')).toBe(path.resolve(here));
  });

  it('turns ACP additionalDirectories into --add-dir all the way down to argv', async () => {
    // D5 across the whole stack: the client's field, the JSON-RPC hop, the
    // session record, the transport, and the argv a real child process was
    // spawned with. Every layer between them used to drop it.
    const wiring = wire();
    active = wiring;
    await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const extra = path.join(here, 'fixtures');
    const { sessionId } = await wiring.client.newSession({
      cwd: here,
      additionalDirectories: [extra],
      mcpServers: [],
    });
    await wiring.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });

    const calls = turnsIn(wiring.argvLog);
    expect(calls[0]?.argv).toEqual([
      '-p',
      'go',
      '--output-format',
      'stream-json',
      '--add-dir',
      here,
      '--add-dir',
      extra,
    ]);
  });

  it('sends a resource_link prompt block to agy as text plus a workspace root', async () => {
    // D3 across the wire. Four blocks in, two of them file references: the old
    // `flattenPrompt` kept only the text and agy answered about files it had
    // never seen, with no error and no diagnostic.
    const wiring = wire();
    active = wiring;
    await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const { sessionId } = await wiring.client.newSession({ cwd: here, mcpServers: [] });
    const referenced = path.join(here, 'fixtures', 'turn-plain.ndjson');
    await wiring.client.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'summarise' },
        {
          type: 'resource_link',
          name: 'turn-plain.ndjson',
          uri: pathToFileURL(referenced).href,
        },
      ],
    });

    const calls = turnsIn(wiring.argvLog);
    const argv = calls[0]?.argv ?? [];
    expect(argv[1]).toContain('summarise');
    expect(argv[1]).toContain(referenced);
    expect(argv.slice(argv.indexOf('--add-dir'))).toEqual([
      '--add-dir',
      here,
      '--add-dir',
      path.join(here, 'fixtures'),
    ]);
  });

  it('rejects prompt content it advertised as unsupported, rather than dropping it', async () => {
    const wiring = wire();
    active = wiring;
    await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const { sessionId } = await wiring.client.newSession({ cwd: here, mcpServers: [] });
    const failure = await wiring.client
      .prompt({
        sessionId,
        prompt: [
          { type: 'text', text: 'look at this' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
      })
      .then(
        () => null,
        (error: unknown) => error as { code?: number; message?: string },
      );
    expect(failure?.code).toBe(-32602);
    expect(failure?.message).toMatch(/image/);
  });

  it('answers a session id it never issued with -32002, not -32603', async () => {
    // D4 over the wire. -32603 is "the agent broke"; the client cannot tell it
    // from "reopen your session", and only one of the two is worth retrying.
    const wiring = wire();
    active = wiring;
    await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const failure = await wiring.client
      .prompt({ sessionId: 'agy-never-existed', prompt: [{ type: 'text', text: 'x' }] })
      .then(
        () => null,
        (error: unknown) => error as { code?: number; message?: string },
      );
    expect(failure?.code).toBe(-32002);
    expect(failure?.message).toMatch(/unknown session agy-never-existed/);
  });

  it('answers a protocol version it does not speak with the one it does', async () => {
    const wiring = wire();
    active = wiring;
    const initialize = await wiring.client.initialize({
      protocolVersion: 0,
      clientCapabilities: {},
    });
    // Not `0`. Echoing the client's number back claims a wire format this build
    // has never emitted, and leaves the client no reason to disconnect.
    expect(initialize.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('refuses session/load outright now that it does not advertise it', async () => {
    // The pairing that makes D1/D2 honest: `loadSession: false` at initialize,
    // and the method genuinely absent. A -32601 is a client-fixable mistake; the
    // old shape — advertise load, implement resume — was not.
    const wiring = wire();
    active = wiring;
    await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const failure = await wiring.client
      .loadSession({ sessionId: 'agy-anything', cwd: here, mcpServers: [] })
      .then(
        () => null,
        (error: unknown) => error as { code?: number },
      );
    expect(failure?.code).toBe(-32601);
  });

  it('hands the agy conversation id to the client over the wire', async () => {
    // The id must survive JSON-RPC serialisation *and* the zod schema the client
    // side validates notifications against — an in-process assertion proves neither.
    const wiring = wire();
    active = wiring;
    await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const { sessionId } = await wiring.client.newSession({ cwd: here, mcpServers: [] });
    const turn = await wiring.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    });

    expect(turn._meta?.[AGY_CONVERSATION_META_KEY]).toBe(RECORDED_CONVERSATION_ID);
    expect(
      wiring.received.map((n) => n._meta?.[AGY_CONVERSATION_META_KEY]),
    ).toEqual(wiring.received.map(() => RECORDED_CONVERSATION_ID));
  });

  it('resumes across an adapter restart using only what the client was given', async () => {
    // The M3 scenario end to end: the agent process the session was created on is
    // gone, and the client has nothing but the session id and the `_meta` it kept.
    const first = wire();
    active = first;
    await first.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const { sessionId } = await first.client.newSession({ cwd: here, mcpServers: [] });
    const turn1 = await first.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    });
    const kept = turn1._meta?.[AGY_CONVERSATION_META_KEY];
    expect(typeof kept).toBe('string');
    first.close();

    // A second AgentSideConnection over fresh streams: a restarted adapter, with
    // an empty session map. Same argv log, so both processes' calls land in it.
    const restarted = wire(first.argvLog);
    active = restarted;
    await restarted.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    await restarted.client.resumeSession({
      sessionId,
      cwd: here,
      mcpServers: [],
      _meta: { [AGY_CONVERSATION_META_KEY]: kept },
    });
    await restarted.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'continue' }],
    });

    const calls = turnsIn(restarted.argvLog);
    expect(calls).toHaveLength(2);
    // The whole point: the turn after the restart continues the same agy
    // conversation instead of silently opening a new one.
    expect(calls[1]?.argv).toEqual([
      '-p',
      'continue',
      '--output-format',
      'stream-json',
      '--add-dir',
      here,
      '--conversation',
      RECORDED_CONVERSATION_ID,
    ]);
  });

  it('reports a resume it cannot honour as a failure, not as a fresh conversation', async () => {
    const wiring = wire();
    active = wiring;
    await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const failure = await wiring.client
      .resumeSession({ sessionId: 'agy-vanished', cwd: here, mcpServers: [] })
      .then(
        () => null,
        (error: unknown) => error as { code?: number; message?: string },
      );
    // A real protocol error the client can branch on, not a generic -32603 with
    // the reason buried in `data`, and above all not a success.
    expect(failure?.code).toBe(-32002);
    expect(failure?.message).toMatch(/cannot resume session agy-vanished/);
  });

  it('refuses a foreign session id it cannot possibly resume', async () => {
    // F4 over the wire. Measured before the check existed:
    // `session/resume { sessionId: 'nope-does-not-exist' }` returned OK and
    // echoed the string back as `_meta.conversationId`, so the client believed
    // it had reattached and only found out at the next prompt.
    const wiring = wire();
    active = wiring;
    await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const failure = await wiring.client
      .resumeSession({ sessionId: 'nope-does-not-exist', cwd: here, mcpServers: [] })
      .then(
        () => null,
        (error: unknown) => error as { code?: number; message?: string },
      );
    expect(failure?.code).toBe(-32602);
    expect(failure?.message).toMatch(/not the shape of an agy conversation id/);
  });

  it('names a resume it could only shape-check as exactly that, across the wire', async () => {
    const wiring = wire();
    active = wiring;
    await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const resumed = await wiring.client.resumeSession({
      sessionId: 'agy-from-a-previous-process',
      cwd: here,
      mcpServers: [],
      _meta: { [AGY_CONVERSATION_META_KEY]: RECORDED_CONVERSATION_ID },
    });
    // The id is well-formed and this adapter accepts it — but it has not been
    // checked against agy, and the response says exactly that rather than
    // letting silence read as confirmation.
    expect(resumed._meta?.[AGY_CONVERSATION_META_KEY]).toBe(RECORDED_CONVERSATION_ID);
    const report = resumed._meta?.[AGY_RESUME_META_KEY] as Record<string, unknown>;
    expect(report).toMatchObject({ source: 'client-meta' });
    expect(String(report.detail)).toMatch(/NOT proof/);
    // No `verified` boolean survives the JSON-RPC hop either, because there is
    // none: it was false for every compliant client and true only for one that
    // sent nothing. See `resumeReport` in agent.ts.
    expect('verified' in report).toBe(false);
  });

  it('offers a model picker on session/new and puts the choice into argv', async () => {
    // F1 across the whole stack: `agy models` (a real child process), the
    // JSON-RPC hop, the client's zod schema, `session/set_config_option`, the
    // session record, and the argv a real child process was spawned with.
    // `buildAgyArgv` never emitted `--model` at all, so every layer here is new.
    const wiring = wire();
    active = wiring;
    await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const session = await wiring.client.newSession({ cwd: here, mcpServers: [] });
    const option = session.configOptions?.find((entry) => entry.id === AGY_MODEL_CONFIG_ID);
    expect(option?.type).toBe('select');
    expect(option?.category).toBe('model');
    const select = option as Extract<SessionConfigOption, { type: 'select' }>;
    expect(select.currentValue).toBe(AGY_MODEL_UNPINNED_VALUE);
    expect(select.options.map((entry) => ('value' in entry ? entry.value : entry.group))).toEqual([
      AGY_MODEL_UNPINNED_VALUE,
      'gemini-3.6-flash-low',
      'claude-sonnet-4-6',
    ]);

    const set = await wiring.client.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: AGY_MODEL_CONFIG_ID,
      value: 'claude-sonnet-4-6',
    });
    expect(
      (set.configOptions.find((entry) => entry.id === AGY_MODEL_CONFIG_ID) as
        Extract<SessionConfigOption, { type: 'select' }>).currentValue,
    ).toBe('claude-sonnet-4-6');

    const turn = await wiring.client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    });
    expect(turn._meta?.[AGY_MODEL_META_KEY]).toMatchObject({
      pinned: true,
      modelId: 'claude-sonnet-4-6',
    });
    expect(turnsIn(wiring.argvLog)[0]?.argv).toEqual([
      '-p',
      'go',
      '--output-format',
      'stream-json',
      '--model',
      'claude-sonnet-4-6',
      '--add-dir',
      here,
    ]);
    // One `agy models`, not one per session.
    expect(modelListCallsIn(wiring.argvLog)).toHaveLength(1);
  });

  it('really re-runs `agy models` once both caches say the list is old', async () => {
    // P2, measured the way it was measured broken: by counting spawns in the
    // argv log. `AgyAgent` cached a working catalog forever and is the only
    // production caller of `transport.listModels()`, so `AgyCliTransport`'s
    // stale-while-revalidate path was unreachable from any configuration —
    // `modelListTtlMs: 1` plus four session/new spawned `agy models` exactly
    // once, and the transport's own refresh test passed on code nothing could
    // run. A model agy retired then stayed in the picker until a restart.
    //
    // Both lifetimes are set here because both have to expire: the agent has to
    // ask again at all, and the transport has to decide a refresh is due. That
    // is the composition, and a spawn is the only proof of it.
    const wiring = wire(undefined, undefined, { modelListTtlMs: 1, modelCatalogTtlMs: 1 });
    active = wiring;
    await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    await wiring.client.newSession({ cwd: here, mcpServers: [] });
    expect(modelListCallsIn(wiring.argvLog)).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    // The refresh is behind the answer, so this call is served from cache and
    // the second `agy models` lands after it returns. Polled to a deadline
    // rather than slept at, because a fixed wait for a real process spawn is a
    // flake, and a flaky test here would be read as this feature being dead
    // again.
    await wiring.client.newSession({ cwd: here, mcpServers: [] });
    const deadline = Date.now() + 5_000;
    while (modelListCallsIn(wiring.argvLog).length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(modelListCallsIn(wiring.argvLog).length).toBeGreaterThan(1);
  });

  it('lets a reconnect unpin a model, across the wire and into argv', async () => {
    // P1 end to end, on the exact path apps/desktop takes: pin a model, run a
    // turn, then reconnect carrying the `_meta` block this adapter emits for an
    // unpinned session. That block — `{ pinned: false, modelId: null }` — was
    // folded into the same `null` as an absent key, so the `??` chain fell
    // through to the pin still held in this process. The client got back
    // `pinned: true`, a picker whose currentValue agreed, and a `--model` in the
    // next turn's argv: a wrong experiment record, produced confidently.
    //
    // Asserted here rather than only against the agent object because `_meta` is
    // `additionalProperties: true` in ACP — no schema check anywhere on this path
    // can say a word about what is inside it, so nothing but a behavioural
    // assertion after a real JSON-RPC round trip covers this.
    const wiring = wire();
    active = wiring;
    await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const { sessionId } = await wiring.client.newSession({ cwd: here, mcpServers: [] });
    await wiring.client.setSessionConfigOption({
      sessionId,
      configId: AGY_MODEL_CONFIG_ID,
      value: 'claude-sonnet-4-6',
    });
    await wiring.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'first' }] });
    expect(turnsIn(wiring.argvLog)[0]?.argv).toContain('--model');

    const resumed = await wiring.client.resumeSession({
      sessionId,
      cwd: here,
      mcpServers: [],
      _meta: { [AGY_MODEL_META_KEY]: { pinned: false, modelId: null } },
    });
    expect(resumed._meta?.[AGY_MODEL_META_KEY]).toMatchObject({ pinned: false, modelId: null });
    expect(
      (resumed.configOptions?.find((entry) => entry.id === AGY_MODEL_CONFIG_ID) as Extract<
        SessionConfigOption,
        { type: 'select' }
      >).currentValue,
    ).toBe(AGY_MODEL_UNPINNED_VALUE);
    expect(resumed._meta?.[AGY_RESUME_META_KEY]).toMatchObject({
      model: { pinned: false, modelId: null, source: 'client-unpinned' },
    });

    const turn = await wiring.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'second' }],
    });
    expect(turn._meta?.[AGY_MODEL_META_KEY]).toMatchObject({ pinned: false, modelId: null });
    // The one that decides what actually ran.
    expect(turnsIn(wiring.argvLog)[1]?.argv).not.toContain('--model');
  });

  it('names the model an unpinned turn actually ran on', async () => {
    // The other half of F1, and the one that matters most: silence here is what
    // let every turn run on agy's persisted default with nothing recording it.
    const wiring = wire();
    active = wiring;
    await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const { sessionId } = await wiring.client.newSession({ cwd: here, mcpServers: [] });
    const turn = await wiring.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });

    expect(turn._meta?.[AGY_MODEL_META_KEY]).toMatchObject({
      pinned: false,
      modelId: null,
      agySavedDefault: { id: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' },
    });
    // No --model in argv, matching what the response just said.
    expect(turnsIn(wiring.argvLog)[0]?.argv).not.toContain('--model');
  });

  it('delivers a tool call the client can render', async () => {
    const wiring = wire();
    active = wiring;
    await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const { sessionId } = await wiring.client.newSession({ cwd: here, mcpServers: [] });
    await wiring.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });

    const opened = wiring.received.find((n) => n.update.sessionUpdate === 'tool_call');
    const closed = wiring.received.find((n) => n.update.sessionUpdate === 'tool_call_update');
    expect(opened?.update).toMatchObject({
      title: 'list_dir',
      kind: 'read',
      status: 'in_progress',
    });
    expect(closed?.update).toMatchObject({ status: 'completed' });
    // Both halves must share the id or the client cannot join them into one card.
    const openedId = opened?.update as { toolCallId?: string };
    const closedId = closed?.update as { toolCallId?: string };
    expect(openedId.toolCallId).toBe(closedId.toolCallId);
  });

  it("delivers the tool's result, not just its status", async () => {
    // `turn-with-tool.ndjson` is a run where list_dir produced nothing, so the
    // test above passes just as happily when the result is dropped. This one
    // replays the recording that *has* `tool_info.output`, and asserts the text
    // after a full round trip: JSON-RPC serialisation plus the zod schema the
    // client validates notifications against, neither of which the mapper tests
    // exercise. A blank tool card is what the user sees when this regresses.
    const wiring = wire(undefined, 'turn-tool-output.ndjson');
    active = wiring;
    await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const { sessionId } = await wiring.client.newSession({ cwd: here, mcpServers: [] });
    await wiring.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });

    const closed = wiring.received.find((n) => n.update.sessionUpdate === 'tool_call_update');
    expect(closed?.update).toMatchObject({
      status: 'completed',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: recordedToolOutput('turn-tool-output.ndjson') },
        },
      ],
    });
  });

  it("carries the tool's raw output through the client's schema as the string it is", async () => {
    // The library-split regression, asserted from the agent side.
    //
    // ACP declares `rawOutput` unstructured. `@zed-industries/agent-client-protocol@0.4.5`
    // validated it as `z.record(z.unknown()).optional()` — verified in that
    // package's own `dist/schema.js` — so a *string* `rawOutput` did not merely
    // lose its type, it failed validation and took the whole terminal
    // `status: "completed"` update down with it. That is the measured defect in
    // packages/acp-client: 7, 6 and 5 dropped `session/update` messages against
    // three third-party agents.
    //
    // agy's tool output is always a bare string, so this adapter sits squarely
    // in that failure mode. The assertion is deliberately made *after* a real
    // `ClientSideConnection` has validated the notification, because the mapper
    // tests cannot see a schema rejection — under the old library this line is
    // what would have been missing, not merely wrong.
    const wiring = wire(undefined, 'turn-tool-output.ndjson');
    active = wiring;
    await wiring.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const { sessionId } = await wiring.client.newSession({ cwd: here, mcpServers: [] });
    await wiring.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });

    const closed = wiring.received.find((n) => n.update.sessionUpdate === 'tool_call_update');
    const recorded = recordedToolOutput('turn-tool-output.ndjson');
    const raw = (closed?.update as { rawOutput?: unknown }).rawOutput;
    // A string, byte for byte — not stringified, not wrapped in an object to
    // fit the shape the old library's schema would have demanded.
    expect(typeof raw).toBe('string');
    expect(raw).toBe(recorded);
  });
});
