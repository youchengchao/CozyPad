import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
// The agent side is deliberately the OTHER library: the deprecated
// `@zed-industries/agent-client-protocol@0.4.5`. It is kept as a devDependency
// of this package for no other purpose than to be that foreign implementation.
// See the block comment below.
import {
  AgentSideConnection,
  PROTOCOL_VERSION as LEGACY_PROTOCOL_VERSION,
  ndJsonStream,
  newSessionRequestSchema as legacyNewSessionRequestSchema,
  sessionNotificationSchema as legacySessionNotificationSchema,
  type Agent,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
} from '@zed-industries/agent-client-protocol';
import {
  AcpAgentDisconnectedError,
  AcpRequestTimeoutError,
  DEFAULT_AUTHENTICATE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STALL_AFTER_MS,
  PROTOCOL_VERSION,
  connectAcpAgent,
  createAcpClient,
  deriveClientCapabilities,
  readableFromNodeStream,
  writableToNodeStream,
  type AcpAgentHandle,
  type AcpClientHandlers,
  type AcpRequestTimeouts,
  type AcpSessionEvent,
  type AcpSessionUpdateKind,
  type AcpStallEvent,
  type RequestPermissionRequest,
} from '../src/index';

/**
 * These tests run the real `ClientSideConnection` against the real
 * `AgentSideConnection`, joined by two byte pipes through the real
 * `ndJsonStream`. Every assertion below therefore travels as newline-delimited
 * JSON-RPC and passes the library's zod validation on the way — a malformed
 * update or a wrongly-shaped permission answer fails the test rather than
 * being waved through by a mock.
 *
 * ## The two sides are two different libraries, on purpose
 *
 * The client is `@agentclientprotocol/sdk@1.3.0`, which is what
 * `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`
 * ship. The agent is `@zed-industries/agent-client-protocol@0.4.5` — npm's own
 * deprecation notice on that package reads "renamed to
 * @agentclientprotocol/sdk".
 *
 * `packages/adapter-agy` used to be built on 0.4.5 too, which put this exact
 * version split *inside* CozyPad: our client on 1.3.0, our own agent on the
 * library measured dropping terminal tool updates. It has since been migrated
 * to `@agentclientprotocol/sdk@1.3.0`, so 0.4.5 now survives here only as the
 * deliberately foreign implementation these tests need — nothing we ship runs
 * on it, and nothing should start.
 *
 * That mismatch is the point. Both negotiate `PROTOCOL_VERSION` 1, so a
 * divergence between them never fails a handshake; it shows up as silently
 * dropped data, which no same-library test can see. Running the suite across
 * the seam is what proves the two still interoperate rather than assuming it.
 *
 * Each known divergence is pinned next to the behaviour it breaks, by asking
 * the old library's schema directly rather than by describing it:
 * `tool_call_update.rawOutput …` → *is exactly what the old library rejected*
 * (the one that started this migration), and `session/update variants the old
 * library did not have` → *is exactly five, asked of the old schema rather
 * than remembered*. The block at the end of the file pins only the agreement
 * that makes all of them silent.
 */

type PromptDriver = (
  conn: AgentSideConnection,
  params: PromptRequest,
) => Promise<PromptResponse>;

const SESSION_ID = 'session-1';

class FakeAgent implements Agent {
  readonly initializeRequests: InitializeRequest[] = [];
  readonly newSessionRequests: NewSessionRequest[] = [];
  readonly cancellations: CancelNotification[] = [];

  readonly #conn: AgentSideConnection;
  readonly #onPrompt: PromptDriver;

  constructor(conn: AgentSideConnection, onPrompt: PromptDriver) {
    this.#conn = conn;
    this.#onPrompt = onPrompt;
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.initializeRequests.push(params);
    return {
      // The legacy library's own constant, so the assertion that the two
      // agree on the version is comparing the two libraries, not one twice.
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    };
  }

  async authenticate(): Promise<void> {}

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.newSessionRequests.push(params);
    return { sessionId: SESSION_ID };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    return await this.#onPrompt(this.#conn, params);
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.cancellations.push(params);
  }
}

interface Harness {
  handle: AcpAgentHandle;
  agent: FakeAgent;
  events: AcpSessionEvent[];
  /** Raw bytes the client sent to the agent, decoded. */
  toAgent: string[];
  /** Raw bytes the agent sent to the client, decoded. */
  toClient: string[];
}

/** Copies everything crossing a byte stream into `sink`, unchanged. */
function tap(
  source: ReadableStream<Uint8Array>,
  sink: string[],
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        sink.push(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
    }),
  );
}

/** Splits captured bytes back into the JSON-RPC messages they framed. */
function messages(captured: string[]): Array<Record<string, unknown>> {
  return captured
    .join('')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const endTurn: PromptDriver = async () => ({ stopReason: 'end_turn' });

function connectFake(options: {
  handlers?: Partial<AcpClientHandlers>;
  onPrompt?: PromptDriver;
} = {}): Harness {
  const events: AcpSessionEvent[] = [];

  const base: AcpClientHandlers = {
    onSessionUpdate: (event) => {
      events.push(event);
    },
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  };
  const handlers: AcpClientHandlers = { ...base, ...options.handlers };

  // Two independent byte pipes make a full duplex channel.
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const toAgent: string[] = [];
  const toClient: string[] = [];

  let agent: FakeAgent | undefined;
  new AgentSideConnection(
    (conn) => {
      agent = new FakeAgent(conn, options.onPrompt ?? endTurn);
      return agent;
    },
    ndJsonStream(agentToClient.writable, tap(clientToAgent.readable, toAgent)),
  );

  const handle = connectAcpAgent({
    handlers,
    input: tap(agentToClient.readable, toClient),
    output: clientToAgent.writable,
  });

  if (agent === undefined) {
    throw new Error('AgentSideConnection did not build the agent');
  }
  return { handle, agent, events, toAgent, toClient };
}

/** A connection whose agent-side pipes the test drives byte by byte. */
interface OpenPipes {
  handle: AcpAgentHandle;
  /** Raw bytes the client sent, decoded. */
  toAgent: string[];
  /** EOF on the agent→client stream: an agent that closed its stdout. */
  closeInput(): Promise<void>;
  /** A stream error on the same: a socket that broke mid-conversation. */
  errorInput(error: Error): Promise<void>;
}

/**
 * Connects to nothing at all — both byte streams stay open and unanswered.
 *
 * `connectFake` cannot express this: its `AgentSideConnection` answers, and
 * closing its pipes closes them for both directions at once. The tests below
 * need the agent's stream to die on its own while the client sits waiting,
 * which is exactly what a real agent does when it closes stdout or its socket
 * drops.
 */
function connectToOpenPipes(): OpenPipes {
  const fromAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toAgentPipe = new TransformStream<Uint8Array, Uint8Array>();
  const toAgent: string[] = [];

  // Drained, not ignored: an unread `WritableStream` stops accepting after one
  // chunk, and then the request never reaches the wire and the test would be
  // measuring backpressure instead of liveness.
  void (async () => {
    const reader = toAgentPipe.readable.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        toAgent.push(decoder.decode(value, { stream: true }));
      }
    }
  })();

  const agentWriter = fromAgent.writable.getWriter();
  const handle = connectAcpAgent({
    handlers: {
      onSessionUpdate: () => {},
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    },
    input: fromAgent.readable,
    output: toAgentPipe.writable,
    label: 'agy',
  });

  return {
    handle,
    toAgent,
    closeInput: () => agentWriter.close(),
    errorInput: (error) => agentWriter.abort(error),
  };
}

/** Waits until the named method has actually left the client, not just been called. */
async function awaitOnTheWire(pipes: OpenPipes, method: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(pipes.toAgent.join('')).toContain(method);
    },
    { timeout: 5_000, interval: 5 },
  );
}

/**
 * What a UI has to show while `session/prompt` runs with no budget at all.
 *
 * `prompt` ships with `timeouts.prompt === null` on purpose: a turn takes as
 * long as the model and its tools take, and a cap would eventually abort real
 * work. The cost of that choice is that nothing will ever reject on the user's
 * behalf, and ACP has no heartbeat — a thinking agent and a wedged one emit
 * exactly the same thing, which is nothing. So the obligation the `null` budget
 * creates is discharged here: the connection reports what it *does* know, and
 * the last test is the one that stops it from crying wolf on a healthy turn.
 */
describe('liveness a UI can render', () => {
  /** Drives one side of a pipe pair by hand so the clock is the test's. */
  function connectWithStall(options: {
    stallAfterMs?: number;
    onStall?: (event: AcpStallEvent) => void;
  }): OpenPipes & { speak(text: string): Promise<void> } {
    const fromAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toAgentPipe = new TransformStream<Uint8Array, Uint8Array>();
    const toAgent: string[] = [];
    void (async () => {
      const reader = toAgentPipe.readable.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value !== undefined) {
          toAgent.push(decoder.decode(value, { stream: true }));
        }
      }
    })();
    const agentWriter = fromAgent.writable.getWriter();
    const handle = connectAcpAgent({
      handlers: {
        onSessionUpdate: () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      },
      input: fromAgent.readable,
      output: toAgentPipe.writable,
      label: 'agy',
      timeouts: { default: null, prompt: null },
      ...(options.stallAfterMs === undefined
        ? {}
        : { stallAfterMs: options.stallAfterMs }),
      ...(options.onStall === undefined ? {} : { onStall: options.onStall }),
    });
    return {
      handle,
      toAgent,
      closeInput: () => agentWriter.close(),
      errorInput: (error) => agentWriter.abort(error),
      // Bytes that are not a reply to anything. That is deliberate: liveness is
      // "the agent is still emitting", not "the agent answered", because a
      // streaming turn is minutes of updates and one answer at the end.
      speak: async (text: string) => {
        await agentWriter.write(new TextEncoder().encode(text));
      },
    };
  }

  it('reports nothing outstanding on a connection at rest', () => {
    const pipes = connectWithStall({});

    const status = pipes.handle.status();

    expect(status.alive).toBe(true);
    expect(status.failure).toBeNull();
    expect(status.outstanding).toEqual([]);
    // Never heard from, which is not the same as "has gone quiet".
    expect(status.silentMs).toBeNull();
  });

  it('names the outstanding request and how long it has been waiting', async () => {
    const pipes = connectWithStall({});
    const pending = pipes.handle.prompt({ sessionId: 's', prompt: [] });
    pending.catch(() => undefined);
    await awaitOnTheWire(pipes, 'session/prompt');

    const status = pipes.handle.status();

    expect(status.outstanding).toHaveLength(1);
    const [request] = status.outstanding;
    expect(request?.method).toBe('session/prompt');
    expect(request?.elapsedMs).toBeGreaterThanOrEqual(0);
    // The bytes went out, so nothing is stuck in the transport. This is the
    // field that separates "the agent has not replied" from "the agent is not
    // even reading" — see the deaf-child test in connectProcess.test.ts.
    expect(request?.writePendingMs).toBeNull();
    expect(request?.reason).toBe('awaiting-reply');

    pipes.handle.fail(new Error('test over'));
  });

  it('carries the failure once the connection is dead', async () => {
    const pipes = connectWithStall({});
    const pending = pipes.handle.prompt({ sessionId: 's', prompt: [] });
    pending.catch(() => undefined);
    await awaitOnTheWire(pipes, 'session/prompt');

    pipes.handle.fail(new Error('agy exited with code 17'));
    await vi.waitFor(() => {
      expect(pipes.handle.status().alive).toBe(false);
    });

    const status = pipes.handle.status();
    expect(status.failure?.message).toBe('agy exited with code 17');
    // Nothing is still waiting: `fail` rejected it.
    expect(status.outstanding).toEqual([]);
  });

  it('reports a silent agent, repeatedly, with a growing silence', async () => {
    const stalls: AcpStallEvent[] = [];
    const pipes = connectWithStall({ stallAfterMs: 60, onStall: (e) => stalls.push(e) });
    const pending = pipes.handle.prompt({ sessionId: 's', prompt: [] });
    pending.catch(() => undefined);

    await vi.waitFor(
      () => {
        expect(stalls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 5_000, interval: 10 },
    );

    expect(stalls[0]?.method).toBe('session/prompt');
    expect(stalls[0]?.label).toBe('agy');
    expect(stalls[0]?.stalled).toBe(true);
    expect(stalls[0]?.reason).toBe('awaiting-reply');
    // Growing, not repeating the same number: "quiet for 30s" has to become
    // "quiet for 3 minutes" without the caller keeping its own clock.
    expect(stalls[1]!.silentMs).toBeGreaterThan(stalls[0]!.silentMs);
    // A report, not a verdict. Nothing was rejected and nothing was cancelled.
    expect(pipes.handle.status().alive).toBe(true);

    pipes.handle.fail(new Error('test over'));
  });

  it('CONTROL: an agent that keeps streaming is never reported as stalled', async () => {
    // The test that stops the fix from being "fire a timer and call it
    // liveness". docs/ACP-MIGRATION.md measured agy silent for 83% of an
    // 8-second turn, so a stall report on a healthy streaming turn would train
    // the user to ignore it — which is worse than not reporting at all.
    const stalls: AcpStallEvent[] = [];
    const pipes = connectWithStall({ stallAfterMs: 120, onStall: (e) => stalls.push(e) });
    const pending = pipes.handle.prompt({ sessionId: 's', prompt: [] });
    pending.catch(() => undefined);

    // Chatter well inside the window, for longer than the window itself. Not
    // valid JSON-RPC on purpose: what resets the clock is bytes arriving, which
    // is the only liveness ACP offers.
    const chatter = setInterval(() => {
      void pipes.speak(' ');
    }, 30);
    await new Promise((resolve) => setTimeout(resolve, 600));
    clearInterval(chatter);

    expect(stalls).toEqual([]);
    const status = pipes.handle.status();
    expect(status.outstanding[0]?.stalled).toBe(false);
    expect(status.silentMs).not.toBeNull();

    pipes.handle.fail(new Error('test over'));
  });

  it(
    'is the disclosure the table was missing: one silence, two thresholds',
    async () => {
      // `AcpConnectionStatus`'s table prints `stalled: true` at t=3 s. That row
      // is only reproducible with a short, non-default `stallAfterMs`, and the
      // comment used to print it without saying so — inviting a UI author to
      // "warn the user at 3 seconds" and ship one that says nothing for thirty.
      //
      // Both connections below sit through the *same* wall-clock silence. The
      // only difference is the option, which is the whole point.
      const defaultStalls: AcpStallEvent[] = [];
      const shortStalls: AcpStallEvent[] = [];
      // No `stallAfterMs` at all — precisely what a caller gets out of the box.
      const atDefault = connectWithStall({
        onStall: (event) => defaultStalls.push(event),
      });
      const atShort = connectWithStall({
        stallAfterMs: 3_000,
        onStall: (event) => shortStalls.push(event),
      });

      const first = atDefault.handle.prompt({ sessionId: 's', prompt: [] });
      const second = atShort.handle.prompt({ sessionId: 's', prompt: [] });
      first.catch(() => undefined);
      second.catch(() => undefined);
      await awaitOnTheWire(atDefault, 'session/prompt');
      await awaitOnTheWire(atShort, 'session/prompt');

      // Past the table's 3 s row, once, for both.
      await new Promise((resolve) => setTimeout(resolve, 3_400));

      // The row as the table prints it — a short window makes it real.
      expect(atShort.handle.status().outstanding[0]?.stalled).toBe(true);
      expect(shortStalls.length).toBeGreaterThanOrEqual(1);

      // The row as somebody who configured nothing actually experiences it.
      // `DEFAULT_STALL_AFTER_MS` is 30 s, so at 3.4 s nothing has happened and
      // nothing will for another twenty-six seconds.
      expect(DEFAULT_STALL_AFTER_MS).toBe(30_000);
      expect(atDefault.handle.status().outstanding[0]?.stalled).toBe(false);
      expect(defaultStalls).toEqual([]);

      atDefault.handle.fail(new Error('test over'));
      atShort.handle.fail(new Error('test over'));
    },
    15_000,
  );

  it('starts the silence clock at the request, not at the last byte', async () => {
    // A connection that has been idle for an hour must not report a request
    // issued one millisecond ago as already stalled.
    const pipes = connectWithStall({ stallAfterMs: 10_000 });
    await pipes.speak(' ');
    await new Promise((resolve) => setTimeout(resolve, 120));

    const pending = pipes.handle.prompt({ sessionId: 's', prompt: [] });
    pending.catch(() => undefined);
    await awaitOnTheWire(pipes, 'session/prompt');

    const status = pipes.handle.status();
    expect(status.silentMs).toBeGreaterThanOrEqual(100);
    // Measured from the request, so far smaller than the connection's silence.
    expect(status.outstanding[0]!.silentMs).toBeLessThan(100);

    pipes.handle.fail(new Error('test over'));
  });
});

/**
 * The measured tables in `connect.ts` are asserted on, because they are read.
 *
 * Nothing else in this suite looks at prose, and prose is where this file's
 * longest-lived defects have lived: the write-buffer claim survived four rounds
 * for exactly that reason, and the stall table shipped two more. A comment that
 * a UI author acts on is an interface, and an interface with no test rots at
 * the speed of whatever is nearby.
 *
 * These assertions are deliberately about *disclosures and retractions*, not
 * about wording. Rephrasing the paragraph is fine. Deleting the fact that the
 * table used a non-default `stallAfterMs`, or reinstating either sentence that
 * was measured false, is not.
 *
 * Read from disk inside each test rather than at module load: one line decides
 * these verdicts, and a stale read would decide them wrongly.
 */
describe('the measured tables in connect.ts cannot rot silently', () => {
  const CONNECT_TS = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'connect.ts',
  );

  /** Comment text with its leading `*` gutter and line wrapping removed. */
  function prose(): string {
    return readFileSync(CONNECT_TS, 'utf8')
      .replace(/^[ \t]*\*[ \t]?/gm, ' ')
      .replace(/\s+/g, ' ');
  }

  /** Just the `What this CANNOT tell you` block the stall table lives in. */
  function stallTableBlock(): string {
    const all = prose();
    const start = all.indexOf('What this CANNOT tell you');
    const end = all.indexOf('export interface AcpConnectionStatus');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return all.slice(start, end);
  }

  it('discloses that the stall table used a non-default stallAfterMs', () => {
    const block = stallTableBlock();

    // The table prints `stalled` true at 3 s and 5 s. Those cells are only
    // reachable with a short window, and the block has to say so — without
    // this, "warn at 3 seconds" is the natural reading and it is wrong by 27.
    expect(block).toContain('stallAfterMs');
    expect(block).toContain('DEFAULT_STALL_AFTER_MS');
    // The number the prose quotes, tied to the constant it quotes it from, so
    // the two cannot drift apart.
    expect(DEFAULT_STALL_AFTER_MS).toBe(30_000);
    expect(block).toContain('30 s');
  });

  it('does not reinstate either sentence that was measured false', () => {
    const all = prose();

    // Both were true only of the *non-streaming* agent the table was measured
    // against. A streaming agent holds `silentMs` near the inter-chunk gap
    // while a wedged one climbs without bound, and every shipping agent
    // streams — so as written these sent a UI author to build on a fact that
    // does not hold for any agent we run.
    expect(all).not.toContain(
      'the only thing that ever distinguishes them is the reply arriving',
    );
    expect(all).not.toContain(
      'A wedged agent and a working one report the same number',
    );
  });

  it('says which column is non-streaming, and what streaming changes', () => {
    const block = stallTableBlock();

    // The correction has to be present, not merely the false claim absent:
    // deleting the sentence and saying nothing would leave the table looking
    // like it generalises, which is how it was read the first time.
    expect(block).toContain('non-streaming');
    expect(block).toContain('streaming');
  });
});

describe('initialize', () => {
  it('advertises capabilities derived from the injected handlers', async () => {
    const { handle, agent } = connectFake({
      handlers: { fs: { readTextFile: async () => ({ content: '' }) } },
    });

    const response = await handle.initialize();

    expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(agent.initializeRequests).toHaveLength(1);
    expect(agent.initializeRequests[0]?.protocolVersion).toBe(
      PROTOCOL_VERSION,
    );
    expect(agent.initializeRequests[0]?.clientCapabilities).toEqual({
      fs: { readTextFile: true, writeTextFile: false },
      terminal: false,
    });
  });

  it('lets the caller advertise less than is wired up', async () => {
    const { handle, agent } = connectFake({
      handlers: { fs: { readTextFile: async () => ({ content: '' }) } },
    });

    await handle.initialize({
      clientCapabilities: { fs: { readTextFile: false }, terminal: false },
    });

    expect(agent.initializeRequests[0]?.clientCapabilities).toEqual({
      fs: { readTextFile: false },
      terminal: false,
    });
  });
});

describe('session/update forwarding', () => {
  /**
   * Eight of ACP's thirteen variants, and deliberately not all of them: the
   * agent here is the 0.4.5 library, which can only construct what 0.4.5 had.
   * The five it never had are exercised against a raw agent further down, and
   * `every session/update variant ACP defines` is where the count is enforced
   * so that neither list can quietly fall behind the protocol.
   *
   * What this test adds that the raw one cannot is the seam: these updates are
   * built and validated by a *different implementation* before they are parsed
   * by ours.
   */
  it('delivers each variant the 0.4.5 agent can construct', async () => {
    const { handle, events } = connectFake({
      onPrompt: async (conn, params) => {
        const sessionId = params.sessionId;
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'hi' },
          },
        });
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'thinking' },
          },
        });
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hello ' },
          },
        });
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'world' },
          },
        });
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'Read package.json',
            kind: 'read',
            status: 'in_progress',
          },
        });
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: 'completed',
          },
        });
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'plan',
            entries: [
              { content: 'step one', priority: 'high', status: 'pending' },
            ],
          },
        });
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'usage', description: 'show quota' }],
          },
        });
        await conn.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: 'current_mode_update',
            currentModeId: 'architect',
          },
        });
        return { stopReason: 'end_turn' };
      },
    });

    await handle.initialize();
    const { sessionId } = await handle.newSession({
      cwd: '/workspace',
      mcpServers: [],
    });
    const turn = await handle.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    });

    expect(turn.stopReason).toBe('end_turn');
    expect(events.map((event) => event.kind)).toEqual([
      'user_message_chunk',
      'agent_thought_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'plan',
      'available_commands_update',
      'current_mode_update',
    ]);
    expect(events.every((event) => event.sessionId === SESSION_ID)).toBe(true);

    // The payload is ACP's, untouched — `kind` is a copy of the discriminator,
    // not a translation of it.
    const assembled = events
      .filter((event) => event.kind === 'agent_message_chunk')
      .map((event) =>
        event.update.content.type === 'text' ? event.update.content.text : '',
      )
      .join('');
    expect(assembled).toBe('hello world');

    const toolCall = events.find((event) => event.kind === 'tool_call');
    expect(toolCall?.update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Read package.json',
      kind: 'read',
      status: 'in_progress',
    });
  });

  it('passes _meta through untouched', async () => {
    const { handle, events } = connectFake({
      onPrompt: async (conn, params) => {
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          _meta: { 'cozypad/origin': 'agy' },
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'x' },
          },
        });
        return { stopReason: 'end_turn' };
      },
    });

    await handle.initialize();
    const { sessionId } = await handle.newSession({
      cwd: '/workspace',
      mcpServers: [],
    });
    await handle.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] });

    expect(events[0]?._meta).toEqual({ 'cozypad/origin': 'agy' });
  });
});

describe('session/request_permission', () => {
  it('answers the agent with the option the injected handler picked', async () => {
    const seen: RequestPermissionRequest[] = [];
    let answer: unknown;

    const { handle } = connectFake({
      handlers: {
        requestPermission: async (params) => {
          seen.push(params);
          const allow = params.options.find(
            (option) => option.kind === 'allow_once',
          );
          if (allow === undefined) {
            return { outcome: { outcome: 'cancelled' } };
          }
          return {
            outcome: { outcome: 'selected', optionId: allow.optionId },
          };
        },
      },
      onPrompt: async (conn, params) => {
        answer = await conn.requestPermission({
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: 'tool-9',
            title: 'Write src/main.ts',
            kind: 'edit',
          },
          options: [
            { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        });
        return { stopReason: 'end_turn' };
      },
    });

    await handle.initialize();
    const { sessionId } = await handle.newSession({
      cwd: '/workspace',
      mcpServers: [],
    });
    await handle.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });

    expect(answer).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sessionId).toBe(SESSION_ID);
    expect(seen[0]?.toolCall).toMatchObject({
      toolCallId: 'tool-9',
      title: 'Write src/main.ts',
    });
    expect(seen[0]?.options.map((option) => option.optionId)).toEqual([
      'yes',
      'no',
    ]);
  });

  it('relays a cancelled outcome', async () => {
    let answer: unknown;
    const { handle } = connectFake({
      onPrompt: async (conn, params) => {
        answer = await conn.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'tool-1', title: 'rm -rf /' },
          options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
        });
        return { stopReason: 'cancelled' };
      },
    });

    await handle.initialize();
    const { sessionId } = await handle.newSession({
      cwd: '/workspace',
      mcpServers: [],
    });
    const turn = await handle.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    });

    expect(answer).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(turn.stopReason).toBe('cancelled');
  });
});

describe('fs/*', () => {
  it('routes reads and writes to the injected handlers', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    let readBack: unknown;
    let wrote: unknown;

    const { handle } = connectFake({
      handlers: {
        fs: {
          readTextFile: async ({ path }) => ({ content: `contents of ${path}` }),
          writeTextFile: async ({ path, content }) => {
            writes.push({ path, content });
            return {};
          },
        },
      },
      onPrompt: async (conn, params) => {
        readBack = await conn.readTextFile({
          sessionId: params.sessionId,
          path: '/workspace/a.txt',
        });
        wrote = await conn.writeTextFile({
          sessionId: params.sessionId,
          path: '/workspace/b.txt',
          content: 'written',
        });
        return { stopReason: 'end_turn' };
      },
    });

    await handle.initialize();
    const { sessionId } = await handle.newSession({
      cwd: '/workspace',
      mcpServers: [],
    });
    await handle.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });

    expect(readBack).toEqual({ content: 'contents of /workspace/a.txt' });
    expect(wrote).toEqual({});
    expect(writes).toEqual([{ path: '/workspace/b.txt', content: 'written' }]);
  });
});

describe('terminal/*', () => {
  it('routes the whole terminal group to the injected handlers', async () => {
    const calls: string[] = [];
    let created: unknown;
    let exit: unknown;

    const { handle } = connectFake({
      handlers: {
        terminal: {
          create: async () => {
            calls.push('create');
            return { terminalId: 'term-1' };
          },
          output: async () => {
            calls.push('output');
            return { output: 'ok\n', truncated: false };
          },
          release: async () => {
            calls.push('release');
            return {};
          },
          waitForExit: async () => {
            calls.push('waitForExit');
            return { exitCode: 0 };
          },
          kill: async () => {
            calls.push('kill');
            return {};
          },
        },
      },
      onPrompt: async (conn, params) => {
        const terminal = await conn.createTerminal({
          sessionId: params.sessionId,
          command: 'pnpm',
          args: ['test'],
        });
        created = terminal.id;
        exit = await terminal.waitForExit();
        await terminal.currentOutput();
        await terminal.kill();
        await terminal.release();
        return { stopReason: 'end_turn' };
      },
    });

    await handle.initialize();
    const { sessionId } = await handle.newSession({
      cwd: '/workspace',
      mcpServers: [],
    });
    await handle.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });

    expect(created).toBe('term-1');
    expect(exit).toEqual({ exitCode: 0 });
    expect(calls).toEqual([
      'create',
      'waitForExit',
      'output',
      'kill',
      'release',
    ]);
  });
});

describe('unimplemented optional methods', () => {
  it('are absent from the client object rather than throwing stubs', () => {
    const client = createAcpClient({
      onSessionUpdate: () => {},
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      fs: { readTextFile: async () => ({ content: '' }) },
    });

    expect('readTextFile' in client).toBe(true);
    expect('writeTextFile' in client).toBe(false);
    expect('createTerminal' in client).toBe(false);
    expect('terminalOutput' in client).toBe(false);
    expect('releaseTerminal' in client).toBe(false);
    expect('waitForTerminalExit' in client).toBe(false);
    expect('killTerminal' in client).toBe(false);
    expect('extMethod' in client).toBe(false);
    expect('extNotification' in client).toBe(false);
    expect('unstable_createElicitation' in client).toBe(false);
    expect('unstable_completeElicitation' in client).toBe(false);
  });

  it('are reported as unsupported capabilities', () => {
    expect(
      deriveClientCapabilities({
        onSessionUpdate: () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      }),
    ).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
  });

  it('advertises only the elicitation modes the handler declares', () => {
    expect(
      deriveClientCapabilities({
        onSessionUpdate: () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        elicitation: {
          modes: { form: true },
          create: async () => ({ action: 'cancel' }),
        },
      }),
    ).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      // `{}` is ACP's "yes"; an unsupported mode is absent, never `false`.
      elicitation: { form: {} },
    });
  });
});

describe('session/cancel', () => {
  it('reaches the agent as a notification', async () => {
    const { handle, agent } = connectFake();

    await handle.initialize();
    const { sessionId } = await handle.newSession({
      cwd: '/workspace',
      mcpServers: [],
    });
    await handle.cancel({ sessionId });

    await vi.waitFor(() => {
      expect(agent.cancellations).toEqual([{ sessionId: SESSION_ID }]);
    });
  });
});

describe('liveness', () => {
  /**
   * `ClientSideConnection` settles a request only on a matching JSON-RPC
   * response. Measured against 0.4.5, neither closing nor erroring the input
   * stream disturbs a pending request — the library's read loop just stops.
   * `connectAcpAgent` watches the stream itself (see `transport death` below);
   * `handle.fail` stays for deaths the stream cannot describe, such as an exit
   * code, and for transports whose far end dies without closing anything.
   */
  it('rejects a request that is already on the wire', async () => {
    const { handle, toAgent } = connectFake({
      onPrompt: () => new Promise<PromptResponse>(() => {}),
    });

    await handle.initialize();
    const { sessionId } = await handle.newSession({
      cwd: '/workspace',
      mcpServers: [],
    });

    const turn = handle.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    });
    // Not merely called: the bytes have left, and no answer is coming.
    await vi.waitFor(() => {
      expect(toAgent.join('')).toContain('session/prompt');
    });

    handle.fail(new Error('agy exited with code 1'));

    await expect(turn).rejects.toThrow('agy exited with code 1');
  });

  it('rejects later requests too, rather than hanging afresh', async () => {
    const { handle } = connectFake();

    handle.fail(new Error('agy exited with code 1'));

    await expect(handle.initialize()).rejects.toThrow('agy exited with code 1');
    await expect(handle.prompt({ sessionId: SESSION_ID, prompt: [] })).rejects.toThrow(
      'agy exited with code 1',
    );
    // Notifications included: a cancel written into a pipe nobody reads has
    // not cancelled anything, and must not claim it has.
    await expect(handle.cancel({ sessionId: SESSION_ID })).rejects.toThrow(
      'agy exited with code 1',
    );
  });

  it('keeps the first failure, which is the one that explains the rest', async () => {
    const { handle } = connectFake();

    handle.fail(new Error('agy exited with code 1'));
    handle.fail(new Error('EPIPE: write after end'));

    await expect(handle.initialize()).rejects.toThrow('agy exited with code 1');
  });
});

/**
 * The stream layer, on its own, with no child process anywhere.
 *
 * This is the half of liveness that a `ChildProcess` cannot stand in for. An
 * agent that closes stdout but keeps running emits neither `exit` nor `error`,
 * and a future SSH transport has no child at all — for both, the input stream
 * reaching its terminal state is the *only* notice that arrives. Every test
 * here is budgeted, so a regression fails in seconds instead of hanging until
 * the runner's watchdog fires.
 */
describe('transport death', () => {
  const BUDGET = 3_000;

  it('rejects a request on the wire when the input stream closes', async () => {
    const pipes = connectToOpenPipes();

    const turn = pipes.handle.initialize();
    await awaitOnTheWire(pipes, 'initialize');
    await pipes.closeInput();

    const failure: unknown = await turn.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AcpAgentDisconnectedError);
    expect((failure as Error).message).toContain('agy closed the connection');
  }, BUDGET);

  it('rejects a request on the wire when the input stream errors', async () => {
    const pipes = connectToOpenPipes();

    const turn = pipes.handle.initialize();
    await awaitOnTheWire(pipes, 'initialize');
    await pipes.errorInput(new Error('socket hang up'));

    const failure: unknown = await turn.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AcpAgentDisconnectedError);
    expect((failure as Error).message).toContain('socket hang up');
  }, BUDGET);

  it('rejects later requests too, once the stream is gone', async () => {
    const pipes = connectToOpenPipes();

    await pipes.closeInput();
    // The close has to be *observed*, which only happens once the read loop
    // reaches it; the first request is what proves it was.
    await expect(pipes.handle.initialize()).rejects.toThrow(
      'agy closed the connection',
    );
    await expect(
      pipes.handle.prompt({ sessionId: SESSION_ID, prompt: [] }),
    ).rejects.toThrow('agy closed the connection');
  }, BUDGET);

  it('keeps an explicit failure, which knows more than the stream does', async () => {
    const pipes = connectToOpenPipes();

    // A child-process transport learns the exit code a beat *after* stdout
    // ends. Whoever calls `fail` first wins, and this asserts the winner is
    // kept rather than overwritten by the vaguer stream-level reason.
    pipes.handle.fail(new Error('agy exited with code 17'));
    await pipes.closeInput();

    await expect(pipes.handle.initialize()).rejects.toThrow(
      'agy exited with code 17',
    );
  }, BUDGET);

  it('still delivers the bytes that arrived before the stream ended', async () => {
    // Watching the stream must not consume it: the interposed reader has to
    // hand every chunk on, or the fix would trade a hang for silent data loss.
    const { handle, events } = connectFake({
      onPrompt: async (conn, params) => {
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'survived' },
          },
        });
        return { stopReason: 'end_turn' };
      },
    });

    await handle.initialize();
    const { sessionId } = await handle.newSession({
      cwd: '/workspace',
      mcpServers: [],
    });
    await handle.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });

    const [chunk] = events;
    expect(
      chunk?.kind === 'agent_message_chunk' &&
        chunk.update.content.type === 'text'
        ? chunk.update.content.text
        : null,
    ).toBe('survived');
  }, BUDGET);
});

/**
 * The **split** shape: a transport whose output sink dies while its input stays
 * open and innocent, because the two halves are separate objects.
 *
 * That separation is what makes the write half's death matter. On a duplex
 * transport the same event ends the read half too and `watchTransportEnd` fails
 * the request from there; measured over a real socket, in 74–108 ms with this
 * net removed entirely. It is only when the read half survives — an SSH channel
 * demultiplexed into two streams, a pipe pair, the fixture below — that
 * `writer.closed` in `watchTransportWrites` is the sole remaining signal. That
 * promise settles only if the sink's own controller is errored, so recording
 * the failure privately left the net dead and the request pending: two
 * independent harnesses ran out at 12000 ms and 15000 ms watchdogs.
 *
 * `timeouts: { default: null }` below removes the only other thing that could
 * end these tests, so what they measure is the transport's ability to die.
 *
 * ⚠️ The sink here is a `PassThrough`, and a `PassThrough` can only die one
 * way: `destroy()`, called locally, which leaves `writableEnded` false. That is
 * one of five real death shapes and the *only* one this fixture can reach —
 * see `a transport that dies on a real socket` below for the rest, and
 * `nodeStreams.test.ts` for why the difference is not cosmetic.
 */
describe('an output sink that dies with no write in flight', () => {
  const BUDGET = 3_000;

  /** Connects over a real Node writable, with nothing answering on input. */
  function connectOverNodeStdin(stdin: PassThrough): {
    handle: AcpAgentHandle;
    toAgent: string[];
  } {
    const toAgent: string[] = [];
    const decoder = new TextDecoder();
    stdin.on('data', (chunk: Buffer) => {
      toAgent.push(decoder.decode(chunk, { stream: true }));
    });
    const fromAgent = new TransformStream<Uint8Array, Uint8Array>();

    const handle = connectAcpAgent({
      handlers: {
        onSessionUpdate: () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      },
      input: fromAgent.readable,
      output: writableToNodeStream(stdin),
      label: 'agy',
      timeouts: { default: null },
    });
    return { handle, toAgent };
  }

  it(
    'rejects the request that was already on the wire',
    async () => {
      const stdin = new PassThrough();
      const { handle, toAgent } = connectOverNodeStdin(stdin);

      const pending = handle.initialize();
      // The bytes really left before the sink was broken; what follows is a
      // death with nothing in flight, not a write that failed.
      await vi.waitFor(
        () => {
          expect(toAgent.join('')).toContain('initialize');
        },
        { timeout: 2_000, interval: 5 },
      );
      stdin.destroy();

      const failure: unknown = await pending.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AcpAgentDisconnectedError);
      expect((failure as Error).message).toContain('cannot write to agy');
    },
    BUDGET,
  );

  it(
    'rejects a request made after the sink was already dead',
    async () => {
      const stdin = new PassThrough();
      stdin.destroy();
      await once(stdin, 'close');

      const { handle } = connectOverNodeStdin(stdin);

      await expect(handle.initialize()).rejects.toThrow('cannot write to agy');
    },
    BUDGET,
  );
});

/**
 * The same question, asked of a transport that can actually die five ways.
 *
 * Everything above this point tests stream death with a `PassThrough` and
 * `.destroy()`. That is the *local* teardown shape, and it is the one shape
 * where `writableEnded` stays `false` — so a suite built only on it is
 * structurally incapable of noticing that peer-initiated deaths were being
 * discarded. Measured over real loopback sockets against the code as it stood:
 * a split transport whose peer sent a FIN never settled its request at all
 * (20004 ms and 6010 ms in two runs before they were abandoned), while the
 * whole suite stayed green.
 *
 * Both shapes are exercised because they fail for different reasons:
 *
 * - **duplex** — one socket carrying both directions, so a death ends the read
 *   half too and `watchTransportEnd` answers.
 * - **split** — the socket is the output only, and the input is a stream that
 *   stays open forever. Nothing but the write half can notice.
 *
 * `timeouts: { default: null }` throughout: a timeout would end these tests
 * whether the transport works or not, which is exactly what must not be
 * allowed to look like a pass.
 */
describe('a transport that dies on a real socket', () => {
  const BUDGET = 15_000;

  const servers: net.Server[] = [];
  const sockets: net.Socket[] = [];

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) server.close();
  });

  async function socketPair(): Promise<{ ours: net.Socket; peer: net.Socket }> {
    let announce!: (socket: net.Socket) => void;
    const peerReady = new Promise<net.Socket>((resolve) => {
      announce = resolve;
    });
    const server = net.createServer((socket) => {
      socket.resume();
      announce(socket);
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as net.AddressInfo).port);
      });
    });
    const ours = await new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
    const peer = await peerReady;
    sockets.push(ours, peer);
    ours.on('error', () => undefined);
    peer.on('error', () => undefined);
    return { ours, peer };
  }

  /**
   * Connects over a socket, as either transport shape.
   *
   * `split` swaps the input for a stream that never produces and never ends,
   * which is what an SSH channel's surviving read half looks like from here.
   */
  function connectOverSocket(
    socket: net.Socket,
    shape: 'duplex' | 'split',
  ): AcpAgentHandle {
    return connectAcpAgent({
      handlers: {
        onSessionUpdate: () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      },
      input:
        shape === 'duplex'
          ? readableFromNodeStream(socket)
          : new ReadableStream<Uint8Array>({ start() {} }),
      output: writableToNodeStream(socket),
      label: 'agy',
      timeouts: { default: null, prompt: null },
    });
  }

  /** The diagnostic a request failed with, or `'HUNG'` — never a wait. */
  async function failureOf(
    pending: Promise<unknown>,
    ms = 5_000,
  ): Promise<string> {
    return await Promise.race([
      pending.then(
        () => 'RESOLVED, but the transport was supposed to be dead',
        (error: unknown) => (error as Error).message,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('HUNG'), ms)),
    ]);
  }

  const deaths: ReadonlyArray<{
    readonly name: string;
    readonly kill: (peer: net.Socket, ours: net.Socket) => Promise<void> | void;
    /** Whether the read half has to be flowing for the death to be delivered. */
    readonly needsDrain?: boolean;
  }> = [
    {
      name: 'we destroy our own socket',
      kill: (_peer, ours) => {
        ours.destroy();
      },
    },
    {
      name: 'the peer destroys its socket',
      kill: (peer) => {
        peer.destroy();
      },
    },
    {
      name: 'the peer sends a FIN',
      kill: (peer) => {
        peer.end();
      },
    },
    {
      name: 'the peer destroys after its data drained',
      needsDrain: true,
      kill: async (peer, ours) => {
        const delivered = once(ours, 'data');
        peer.write('bytes from the agent\n');
        await delivered;
        peer.destroy();
      },
    },
  ];

  for (const shape of ['duplex', 'split'] as const) {
    for (const { name, kill, needsDrain } of deaths) {
      it(
        `fails an in-flight request on a ${shape} socket when ${name}`,
        async () => {
          const { ours, peer } = await socketPair();
          // No `ours.resume()` here, deliberately. An earlier version of this
          // test resumed the socket by hand for the `split` shape, with the
          // note that "a real split transport reads its own half; the fixture
          // has to stand in for that" — which is exactly backwards. A real
          // split transport reads the *other* half; this one is the write half
          // and nobody reads it. That hand-resume was the test performing the
          // fix that the code was missing, which is why the shape below went
          // three rounds undetected. `writableToNodeStream` now drains it, and
          // `needsDrain` records which deaths depend on that.
          void needsDrain;

          const handle = connectOverSocket(ours, shape);
          const pending = handle.initialize();
          await vi.waitFor(
            () => {
              expect(ours.bytesWritten).toBeGreaterThan(0);
            },
            { timeout: 2_000, interval: 5 },
          );

          await kill(peer, ours);

          const failure = await failureOf(pending);
          expect(failure).not.toBe('HUNG');
          expect(failure).toContain(
            'The ACP connection is dead and this request cannot be answered.',
          );
        },
        BUDGET,
      );
    }
  }

  /**
   * THE SSH-CHANNEL SHAPE, end to end and at the shipping budgets.
   *
   * Everything above starts from a write half with an empty receive buffer.
   * That is not what an SSH channel looks like: bytes arrive on it, and on a
   * split transport nothing in this package reads them. With even one byte
   * unread, Node suppresses `end`, `close`, `error` and every flag change on
   * the whole socket — measured: 21 bytes buffered, 1.2 s after the peer went
   * away, `events: []`, `destroyed: false`, `writableEnded: false`, for a FIN
   * and for a destroy alike.
   *
   * `connectOverSocket` pins `{default: null, prompt: null}`, so there is no
   * timeout underneath to rescue the assertion — if the transport does not
   * report its own death, these hang until the cap and fail.
   */
  for (const how of ['sends a FIN', 'destroys its socket'] as const) {
    it(
      `fails an in-flight request on a split socket whose write half has unread bytes when the peer ${how}`,
      async () => {
        const { ours, peer } = await socketPair();
        const handle = connectOverSocket(ours, 'split');
        const pending = handle.initialize();
        await vi.waitFor(
          () => {
            expect(ours.bytesWritten).toBeGreaterThan(0);
          },
          { timeout: 2_000, interval: 5 },
        );

        // Bytes the far end sent on the write channel. On a split transport
        // they are not ACP input — that is the other object — so nothing here
        // has any use for them. They still have to be moved, or the socket
        // cannot die.
        peer.write('noise on the write channel\n');
        // Waited for rather than assumed: if the FIN below overtakes the bytes
        // the socket dies the ordinary way and this test proves nothing.
        await vi.waitFor(
          () => {
            expect(ours.bytesRead).toBeGreaterThan(0);
          },
          { timeout: 2_000, interval: 5 },
        );

        if (how === 'sends a FIN') peer.end();
        else peer.destroy();

        const failure = await failureOf(pending);
        expect(failure).not.toBe('HUNG');
        expect(failure).toContain(
          'The ACP connection is dead and this request cannot be answered.',
        );
      },
      BUDGET,
    );
  }

  it(
    'names the far end when the far end is what closed',
    async () => {
      // The wording is the diagnostic. "closed before it was ended" about a
      // stream Node *did* end sends the reader looking for a local bug.
      const { ours, peer } = await socketPair();
      const handle = connectOverSocket(ours, 'split');
      const pending = handle.initialize();
      await vi.waitFor(
        () => {
          expect(ours.bytesWritten).toBeGreaterThan(0);
        },
        { timeout: 2_000, interval: 5 },
      );

      peer.end();

      expect(await failureOf(pending)).toContain(
        'cannot write to agy: the far end closed the connection',
      );
    },
    BUDGET,
  );

  it(
    'CONTROL: a socket that is simply alive keeps the request pending',
    async () => {
      // Without this, a connection that failed everything unconditionally would
      // satisfy every assertion above.
      const { ours } = await socketPair();
      const handle = connectOverSocket(ours, 'split');

      expect(await failureOf(handle.initialize(), 300)).toBe('HUNG');
      handle.fail(new Error('test over'));
    },
    BUDGET,
  );
});

describe('wire format', () => {
  it('really is newline-delimited JSON-RPC 2.0 in both directions', async () => {
    const { handle, toAgent, toClient } = connectFake({
      onPrompt: async (conn, params) => {
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hi' },
          },
        });
        return { stopReason: 'end_turn' };
      },
    });

    await handle.initialize();
    const { sessionId } = await handle.newSession({
      cwd: '/workspace',
      mcpServers: [],
    });
    await handle.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });

    const outbound = messages(toAgent);
    const inbound = messages(toClient);

    // Every framed line is a well-formed JSON-RPC 2.0 message.
    expect(outbound.length).toBeGreaterThan(0);
    expect(inbound.length).toBeGreaterThan(0);
    for (const message of [...outbound, ...inbound]) {
      expect(message['jsonrpc']).toBe('2.0');
    }

    // The client's requests use ACP's method names, not ours.
    expect(outbound.map((message) => message['method'])).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
    ]);

    // The agent's `session/update` arrives as a notification: no `id`.
    const notification = inbound.find(
      (message) => message['method'] === 'session/update',
    );
    expect(notification).toBeDefined();
    expect(notification && 'id' in notification).toBe(false);
    expect(notification?.['params']).toEqual({
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      },
    });

    // Responses carry an id and no method.
    const responses = inbound.filter((message) => !('method' in message));
    expect(responses).toHaveLength(3);
    for (const response of responses) {
      expect(response).toHaveProperty('id');
      expect(response).toHaveProperty('result');
    }
  });

  it('drops an update that fails the protocol schema', async () => {
    const { handle, events, toClient } = connectFake({
      onPrompt: async (conn, params) => {
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          // `tool_call` requires a `title`. Sent deliberately malformed to
          // prove the library's validation is live on this path.
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
          } as unknown as Parameters<
            typeof conn.sessionUpdate
          >[0]['update'],
        });
        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'still flowing' },
          },
        });
        return { stopReason: 'end_turn' };
      },
    });

    await handle.initialize();
    const { sessionId } = await handle.newSession({
      cwd: '/workspace',
      mcpServers: [],
    });
    await handle.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });

    // It was genuinely put on the wire...
    expect(toClient.join('')).toContain('tool-1');
    // ...and rejected before reaching the handler, without killing the stream.
    expect(events.map((event) => event.kind)).toEqual(['agent_message_chunk']);
  });
});


/**
 * An "agent" that is nothing but bytes.
 *
 * `connectFake` cannot express the tests below. Its agent side is the 0.4.5
 * library, so it can only send what 0.4.5 can construct — which excludes every
 * payload this migration is about: the `rawOutput` shapes 0.4.5 narrowed away,
 * the five `session/update` variants it never had, and `elicitation/create`,
 * which it had no method for. Writing raw JSON-RPC is the only way to send what
 * a real `claude-agent-acp` sends.
 */
interface RawAgent {
  handle: AcpAgentHandle;
  events: AcpSessionEvent[];
  /** Every JSON-RPC message the client has put on the wire so far. */
  sent(): Array<Record<string, unknown>>;
  /** Resolves with the client's request for `method` once it is on the wire. */
  awaitRequest(method: string): Promise<Record<string, unknown>>;
  /** Sends one raw JSON-RPC message to the client. */
  push(message: unknown): Promise<void>;
  /** Answers a client request. */
  reply(id: unknown, result: unknown): Promise<void>;
}

function connectRaw(
  handlers: Partial<AcpClientHandlers> = {},
  options: { timeouts?: AcpRequestTimeouts } = {},
): RawAgent {
  const events: AcpSessionEvent[] = [];
  const base: AcpClientHandlers = {
    onSessionUpdate: (event) => {
      events.push(event);
    },
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  };

  const fromAgent = new TransformStream<Uint8Array, Uint8Array>();
  const toAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentWriter = fromAgent.writable.getWriter();
  const encoder = new TextEncoder();

  const sent: Array<Record<string, unknown>> = [];
  void (async () => {
    const reader = toAgent.readable.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        sent.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  })();

  const handle = connectAcpAgent({
    handlers: { ...base, ...handlers },
    input: fromAgent.readable,
    output: toAgent.writable,
    label: 'raw',
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
  });

  const push = async (message: unknown): Promise<void> => {
    await agentWriter.write(encoder.encode(`${JSON.stringify(message)}\n`));
  };

  return {
    handle,
    events,
    sent: () => sent,
    push,
    reply: (id, result) => push({ jsonrpc: '2.0', id, result }),
    awaitRequest: async (method) => {
      let found: Record<string, unknown> | undefined;
      await vi.waitFor(
        () => {
          found = sent.find((message) => message['method'] === method);
          expect(found).toBeDefined();
        },
        { timeout: 5_000, interval: 5 },
      );
      if (found === undefined) throw new Error(`no ${method} was sent`);
      return found;
    },
  };
}

/** Drives a raw connection through the handshake so updates can be pushed. */
async function rawSession(agent: RawAgent): Promise<void> {
  const initialize = agent.handle.initialize();
  const request = await agent.awaitRequest('initialize');
  await agent.reply(request['id'], {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {},
    authMethods: [],
  });
  await initialize;
}

/**
 * One minimal sample of **every** `session/update` variant ACP defines.
 *
 * Typed as `Record<AcpSessionUpdateKind, …>` on purpose: the key set is derived
 * from the SDK's own union, so a variant added by a future protocol release
 * makes this table **fail to compile** rather than quietly going untested. That
 * is the enforcement the old comment on `session/update forwarding` only
 * claimed — it promised "every update variant" over a list of seven.
 */
const UPDATE_SAMPLES: Record<AcpSessionUpdateKind, Record<string, unknown>> = {
  user_message_chunk: { content: { type: 'text', text: 'from the user' } },
  agent_message_chunk: { content: { type: 'text', text: 'hello' } },
  agent_thought_chunk: { content: { type: 'text', text: 'thinking' } },
  tool_call: {
    toolCallId: 't1',
    title: 'Read package.json',
    kind: 'read',
    status: 'in_progress',
  },
  tool_call_update: { toolCallId: 't1', status: 'completed' },
  plan: {
    entries: [{ content: 'step one', priority: 'high', status: 'pending' }],
  },
  plan_update: {
    plan: { type: 'markdown', planId: 'p1', content: '# plan\n- step one' },
  },
  plan_removed: { planId: 'p1' },
  available_commands_update: {
    availableCommands: [{ name: 'usage', description: 'show quota' }],
  },
  current_mode_update: { currentModeId: 'architect' },
  config_option_update: { configOptions: [] },
  session_info_update: { title: 'Fix the parser' },
  usage_update: { used: 41_000, size: 200_000 },
};

/**
 * The count claimed elsewhere in this file, held to the protocol.
 *
 * `session/update forwarding` covers what 0.4.5 can build; `session/update
 * variants the old library did not have` covers the rest. Neither knows how
 * many there are in total, so this is where "every variant" is actually
 * enforced — end to end, over the wire, through the client's own validation.
 */
describe('every session/update variant ACP defines', () => {
  it('reaches the handler, all thirteen of them', async () => {
    const kinds = Object.keys(UPDATE_SAMPLES) as AcpSessionUpdateKind[];
    // Guards the table against being silently emptied, and pins the number the
    // prose in this file quotes.
    expect(kinds).toHaveLength(13);

    const agent = connectRaw();
    await rawSession(agent);

    for (const kind of kinds) {
      await agent.push({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 's1',
          update: { sessionUpdate: kind, ...UPDATE_SAMPLES[kind] },
        },
      });
    }

    await vi.waitFor(() => {
      expect(agent.events).toHaveLength(kinds.length);
    });
    // Not just "thirteen arrived": each one keeps its own discriminator, which
    // is what a consumer switches on.
    expect(agent.events.map((event) => event.kind)).toEqual(kinds);
  });
});

/** Builds a `tool_call_update` notification carrying an arbitrary rawOutput. */
function toolCallUpdate(rawOutput: unknown): unknown {
  return {
    sessionId: 's1',
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      rawOutput,
    },
  };
}

/**
 * **The reason this package changed libraries.**
 *
 * ACP and `@agentclientprotocol/sdk` declare `rawOutput` unstructured
 * (`z.unknown().optional()`). `@zed-industries/agent-client-protocol@0.4.5`
 * narrowed it to `z.record(z.unknown())` — object only. Both negotiate
 * `PROTOCOL_VERSION` 1, so nothing fails; the notification is simply dropped
 * before it reaches a handler. Against the real Claude adapter that was 3 of 9
 * `tool_call_update` messages, and each one is a tool card that says
 * `completed` on the wire and spins forever in the UI.
 */
describe('tool_call_update.rawOutput is unstructured, as the spec says', () => {
  const shapes: Array<readonly [string, unknown]> = [
    ['a string', 'alpha.txt\nbeta.txt'],
    ['an array', ['alpha.txt', 'beta.txt']],
    ['an object', { files: ['alpha.txt'] }],
    ['a number', 7],
  ];

  for (const [name, rawOutput] of shapes) {
    it(`delivers a completed tool call whose rawOutput is ${name}`, async () => {
      const agent = connectRaw();
      await rawSession(agent);

      await agent.push({
        jsonrpc: '2.0',
        method: 'session/update',
        params: toolCallUpdate(rawOutput),
      });

      await vi.waitFor(() => {
        expect(agent.events).toHaveLength(1);
      });
      const [event] = agent.events;
      expect(event?.kind).toBe('tool_call_update');
      expect(
        event?.kind === 'tool_call_update' ? event.update.status : null,
      ).toBe('completed');
      expect(
        event?.kind === 'tool_call_update' ? event.update.rawOutput : undefined,
      ).toEqual(rawOutput);
    });
  }

  it('is exactly what the old library rejected', () => {
    // Not a hypothetical. The old dependency is still installed — dev-only, for
    // the agent side of these tests — so its schema can be asked directly.
    expect(
      legacySessionNotificationSchema.safeParse(toolCallUpdate('a string'))
        .success,
    ).toBe(false);
    expect(
      legacySessionNotificationSchema.safeParse(toolCallUpdate(['a', 'b']))
        .success,
    ).toBe(false);
    // The one shape it did accept, which is why the bug was invisible in tests.
    expect(
      legacySessionNotificationSchema.safeParse(toolCallUpdate({ files: [] }))
        .success,
    ).toBe(true);
  });
});

/**
 * Five `session/update` variants exist in `@agentclientprotocol/sdk` and did
 * not exist in 0.4.5 at all: `usage_update`, `session_info_update`,
 * `config_option_update`, `plan_update` and `plan_removed`. On the old library
 * each one failed validation and vanished — including `usage_update`, which
 * docs/ACP-MIGRATION.md wanted for the live token/cost footer and concluded
 * would have to ride `_meta`.
 *
 * All five are exercised below, and the *membership* of that list is asserted
 * rather than asserted-in-prose: the last test asks the old schema which of
 * ACP's thirteen it rejects, so "five" cannot drift out of date without a
 * failure.
 */
describe('session/update variants the old library did not have', () => {
  it('delivers usage_update, with the context and cost intact', async () => {
    const agent = connectRaw();
    await rawSession(agent);

    await agent.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'usage_update',
          used: 41_000,
          size: 200_000,
          cost: { amount: 0.42, currency: 'USD' },
        },
      },
    });

    await vi.waitFor(() => {
      expect(agent.events).toHaveLength(1);
    });
    const [event] = agent.events;
    expect(event?.kind).toBe('usage_update');
    // Context used / context size / cumulative cost — every number the chat
    // footer in docs/ACP-MIGRATION.md wanted, typed, with no `_meta` needed.
    expect(event?.kind === 'usage_update' ? event.update.used : null).toBe(
      41_000,
    );
    expect(event?.kind === 'usage_update' ? event.update.size : null).toBe(
      200_000,
    );
    expect(
      event?.kind === 'usage_update' ? event.update.cost?.amount : null,
    ).toBe(0.42);
  });

  it('delivers session_info_update and config_option_update', async () => {
    const agent = connectRaw();
    await rawSession(agent);

    await agent.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'session_info_update',
          title: 'Fix the parser',
        },
      },
    });
    await agent.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: { sessionUpdate: 'config_option_update', configOptions: [] },
      },
    });

    await vi.waitFor(() => {
      expect(agent.events).toHaveLength(2);
    });
    expect(agent.events.map((event) => event.kind)).toEqual([
      'session_info_update',
      'config_option_update',
    ]);
  });

  it('delivers plan_update and plan_removed, the incremental plan channel', async () => {
    // A plan that arrives as one immutable blob per turn is the 0.4.5 shape.
    // These two are how a live plan is amended and retired, and both were
    // dropped whole by the old library — a plan card that never updates and
    // never goes away.
    const agent = connectRaw();
    await rawSession(agent);

    await agent.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: {
          sessionUpdate: 'plan_update',
          plan: {
            type: 'markdown',
            planId: 'plan-1',
            content: '# plan\n- [x] step one',
          },
        },
      },
    });
    await agent.push({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: { sessionUpdate: 'plan_removed', planId: 'plan-1' },
      },
    });

    await vi.waitFor(() => {
      expect(agent.events).toHaveLength(2);
    });
    expect(agent.events.map((event) => event.kind)).toEqual([
      'plan_update',
      'plan_removed',
    ]);
    const [updated, removed] = agent.events;
    // The payload survives, not just the discriminator: the plan's identity is
    // the whole point of an incremental channel.
    expect(
      updated?.kind === 'plan_update' ? updated.update.plan.planId : null,
    ).toBe('plan-1');
    expect(
      removed?.kind === 'plan_removed' ? removed.update.planId : null,
    ).toBe('plan-1');
  });

  it('rejects the same usage payload on the old library, which is why it was lost', () => {
    expect(
      legacySessionNotificationSchema.safeParse({
        sessionId: 's1',
        update: { sessionUpdate: 'usage_update', used: 1, size: 2 },
      }).success,
    ).toBe(false);
  });

  it('is exactly five, asked of the old schema rather than remembered', () => {
    // The number in this block's comment, measured. Every ACP variant is put to
    // 0.4.5's own validator; whichever it refuses is what the old dependency
    // silently dropped. If a future SDK adds a variant, `UPDATE_SAMPLES` fails
    // to compile; if the split between the two libraries changes, this fails.
    const refused = (
      Object.keys(UPDATE_SAMPLES) as AcpSessionUpdateKind[]
    ).filter(
      (kind) =>
        !legacySessionNotificationSchema.safeParse({
          sessionId: 's1',
          update: { sessionUpdate: kind, ...UPDATE_SAMPLES[kind] },
        }).success,
    );

    expect(refused).toEqual([
      'plan_update',
      'plan_removed',
      'config_option_update',
      'session_info_update',
      'usage_update',
    ]);
  });
});

/**
 * `elicitation/create` — the question card.
 *
 * This used to be a CozyPad invention (`_elicitation/create` over the extension
 * channel) because 0.4.5 had no elicitation at all. The SDK's own
 * `CLIENT_METHODS.elicitation_create` is `"elicitation/create"`, so the
 * workaround is gone and the method below is the one an agent actually calls.
 */
describe('elicitation/create', () => {
  it('answers with what the injected handler returned', async () => {
    const asked: unknown[] = [];
    const agent = connectRaw({
      elicitation: {
        modes: { form: true },
        create: async (params) => {
          asked.push(params);
          return { action: 'accept', content: { branch: 'main' } };
        },
      },
    });
    await rawSession(agent);

    await agent.push({
      jsonrpc: '2.0',
      id: 99,
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: 'Which branch?',
        sessionId: 's1',
        requestedSchema: {
          type: 'object',
          properties: { branch: { type: 'string' } },
        },
      },
    });

    let answer: Record<string, unknown> | undefined;
    await vi.waitFor(() => {
      answer = agent.sent().find((message) => message['id'] === 99);
      expect(answer).toBeDefined();
    });
    expect(answer?.['result']).toMatchObject({
      action: 'accept',
      content: { branch: 'main' },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ mode: 'form', message: 'Which branch?' });
  });

  it('is refused as method-not-found when no handler is wired', async () => {
    const agent = connectRaw();
    await rawSession(agent);

    await agent.push({
      jsonrpc: '2.0',
      id: 100,
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: 'Which branch?',
        sessionId: 's1',
        requestedSchema: { type: 'object', properties: {} },
      },
    });

    let answer: Record<string, unknown> | undefined;
    await vi.waitFor(() => {
      answer = agent.sent().find((message) => message['id'] === 100);
      expect(answer).toBeDefined();
    });
    expect(answer?.['error']).toMatchObject({ code: -32601 });
  });
});

/**
 * The extension channel changed meaning between the two libraries, and this is
 * the only place in the migration where behaviour a caller can observe is not
 * a strict improvement.
 *
 * 0.4.5 dispatched **only** `_`-prefixed methods to `extMethod`, and handed the
 * name over with the underscore removed (`method.substring(1)`). The SDK makes
 * `extMethod` the **catch-all for every unrecognised method**, and passes the
 * name through verbatim. Both facts are pinned below because both can silently
 * change what a handler sees.
 */
describe('extension channel', () => {
  it('passes the method name through verbatim, underscore and all', async () => {
    const agent = connectRaw({
      ext: {
        method: async (method, params) => ({ echoed: method, seen: params }),
      },
    });
    await rawSession(agent);

    await agent.push({
      jsonrpc: '2.0',
      id: 42,
      method: '_cozypad/ping',
      params: { hello: 'world' },
    });

    let answer: Record<string, unknown> | undefined;
    await vi.waitFor(() => {
      answer = agent.sent().find((message) => message['id'] === 42);
      expect(answer).toBeDefined();
    });
    // 0.4.5 would have said 'cozypad/ping' here.
    expect(answer?.['result']).toMatchObject({ echoed: '_cozypad/ping' });
  });

  it('catches unrecognised methods that carry no underscore at all', async () => {
    const agent = connectRaw({
      ext: { method: async (method) => ({ echoed: method }) },
    });
    await rawSession(agent);

    await agent.push({
      jsonrpc: '2.0',
      id: 43,
      method: 'session/some_future_method',
      params: {},
    });

    let answer: Record<string, unknown> | undefined;
    await vi.waitFor(() => {
      answer = agent.sent().find((message) => message['id'] === 43);
      expect(answer).toBeDefined();
    });
    // Wiring `ext.method` therefore also opts out of method-not-found for
    // anything the SDK does not know yet. Deliberate, and worth knowing.
    expect(answer?.['result']).toMatchObject({
      echoed: 'session/some_future_method',
    });
  });
});

/**
 * The other half of "a spinner that never stops": an agent that is alive, well,
 * connected, and simply never replies. No stream ends, no process exits, and
 * before this there was no request timeout anywhere in the package — such a
 * turn hung until something outside intervened.
 */
describe('request timeouts', () => {
  const TIMEOUT_BUDGET = 5_000;

  it(
    'rejects a request the agent never answers',
    async () => {
      const agent = connectRaw({}, { timeouts: { default: 60 } });

      const failure: unknown = await agent.handle.initialize().then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(AcpRequestTimeoutError);
      expect((failure as AcpRequestTimeoutError).method).toBe('initialize');
      expect((failure as AcpRequestTimeoutError).timeoutMs).toBe(60);
      // It really was sent; the agent really did stay silent.
      expect(agent.sent().map((message) => message['method'])).toContain(
        'initialize',
      );
    },
    TIMEOUT_BUDGET,
  );

  it(
    'leaves the connection usable, because a slow reply is not a dead agent',
    async () => {
      const agent = connectRaw({}, { timeouts: { default: 100 } });

      await expect(agent.handle.initialize()).rejects.toBeInstanceOf(
        AcpRequestTimeoutError,
      );

      const retry = agent.handle.initialize();
      await vi.waitFor(() => {
        expect(
          agent.sent().filter((message) => message['method'] === 'initialize'),
        ).toHaveLength(2);
      });
      const second = agent
        .sent()
        .filter((message) => message['method'] === 'initialize')[1];
      await agent.reply(second?.['id'], {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      });

      await expect(retry).resolves.toMatchObject({
        protocolVersion: PROTOCOL_VERSION,
      });
    },
    TIMEOUT_BUDGET,
  );

  it(
    'does not budget a prompt turn by default, but will when told to',
    async () => {
      // A turn is unbounded by nature; a cap would eventually abort real work,
      // and silently. The default is therefore "no timeout", pinned here.
      const agent = connectRaw({}, { timeouts: { default: 40 } });
      await rawSession(agent);

      const turn = agent.handle.prompt({
        sessionId: 's1',
        prompt: [{ type: 'text', text: 'think hard' }],
      });
      const outcome = await Promise.race([
        turn.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('still running'), 250),
        ),
      ]);
      expect(outcome).toBe('still running');
      agent.handle.fail(new Error('test over'));
      await expect(turn).rejects.toThrow('test over');

      const capped = connectRaw({}, { timeouts: { prompt: 50 } });
      await rawSession(capped);
      await expect(
        capped.handle.prompt({ sessionId: 's1', prompt: [] }),
      ).rejects.toBeInstanceOf(AcpRequestTimeoutError);
    },
    TIMEOUT_BUDGET,
  );

  it(
    'loses to a real disconnect, which explains more',
    async () => {
      const agent = connectRaw({}, { timeouts: { default: 5_000 } });
      const pending = agent.handle.initialize();
      await agent.awaitRequest('initialize');

      agent.handle.fail(
        new AcpAgentDisconnectedError('agy exited with code 17'),
      );

      await expect(pending).rejects.toThrow('agy exited with code 17');
    },
    TIMEOUT_BUDGET,
  );
});

/**
 * **An agent offers no login unless the client asks for one.**
 *
 * Probed against `@agentclientprotocol/claude-agent-acp`: with the capabilities
 * this package derived before, `initialize` came back `authMethods: []`; adding
 * `auth: { terminal: true }` produced `{ id: 'claude-login', type: 'terminal',
 * args: ['--cli'], name: 'Log in with Claude' }`. So the gap was not a missing
 * button — the option never existed on the wire, and a user without
 * credentials got a failed `session/new` and nowhere to go.
 */
describe('auth capabilities', () => {
  const BUDGET = 5_000;

  it('are omitted entirely when the UI declares no login flow', () => {
    const capabilities = deriveClientCapabilities({
      onSessionUpdate: () => {},
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    });

    // Absent, not `auth: {}`: "I support authentication, but no kind of it" is
    // a sentence with no meaning, and ACP reads absent as "no".
    expect('auth' in capabilities).toBe(false);
  });

  it('name each declared method type as a boolean, which is how ACP spells them', () => {
    expect(
      deriveClientCapabilities({
        onSessionUpdate: () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
        auth: { terminal: true },
      }),
    ).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      // Not `{}`, unlike `elicitation`. `AuthCapabilities.terminal` is declared
      // `boolean` in the SDK, and the two groups do not spell "yes" alike.
      auth: { terminal: true },
    });
  });

  it(
    'reach the agent in the handshake, not just the derived object',
    async () => {
      const agent = connectRaw({ auth: { terminal: true } });

      const pending = agent.handle.initialize();
      const request = await agent.awaitRequest('initialize');
      await agent.reply(request['id'], {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      });
      await pending;

      const params = request['params'] as Record<string, unknown>;
      const capabilities = params['clientCapabilities'] as Record<
        string,
        unknown
      >;
      // Read off the bytes that actually left, because the capability being
      // computed correctly and the capability being *sent* are two claims.
      expect(capabilities['auth']).toEqual({ terminal: true });
    },
    BUDGET,
  );
});

/**
 * The methods a UI control is wired to, and why each needs a wrapper.
 *
 * `handle.connection` reaches all of these already — and bypasses both the
 * liveness net and the timeouts on the way, which the file's own comment says.
 * `session/set_config_option` is how **both** shipping agents select a model
 * (plus codex's `reasoning_effort`), so going through `connection` would have
 * made the model picker the one control in the UI that hangs forever when the
 * agent dies. The contrast test at the end of this block measures exactly that.
 */
describe('the agent-side methods behind a UI control', () => {
  const BUDGET = 5_000;

  /**
   * The wrappers whose only coverage is this table.
   *
   * Not every wrapper on the handle — `initialize`, `authenticate`,
   * `newSession`, `prompt` and `cancel` have describes of their own, and
   * duplicating their **params** assertions here would buy nothing.
   *
   * That is not the same as saying they are covered. This table tests two
   * things per row, params *and* `guard()`, and the describes elsewhere only
   * ever tested the first. `session/new` was the proof: a guard-bypass mutation
   * applied to each of the fourteen wrappers in turn killed thirteen of them
   * and left `session/new` green across all 169 tests, because this table skips
   * it and its own describe never let an agent die. Its two guard tests now
   * live next to its params test, in `the params behind the first two things a
   * UI does`.
   *
   * What belongs here is every method
   * that has *no* other test, because the failure mode being guarded against is
   * indistinguishable from working code until an agent dies: unwrap any of
   * these from `guard()` and it still sends the right bytes, still returns the
   * right answer, and hangs forever the one time it matters.
   *
   * `session/set_mode`, `session/list` and `session/load` were in exactly that
   * position — correct, inside `guard()`, and appearing zero times in any test.
   *
   * ## Why each entry carries its `params`
   *
   * The loop below used to call `awaitRequest(method)` and **throw the return
   * value away**. `awaitRequest` matches on `message['method']` and nothing
   * else, so what it actually proved was that the method name went out and that
   * a dying agent rejects — nothing whatsoever about the payload. Corrupting one
   * wrapper's params at a time left ten of these green, including
   * `session/new`'s `cwd` and `session/resume`'s `sessionId`.
   *
   * That is the **same defect as the early "cwd ignored" bug**: a value accepted
   * at the API and silently not delivered. It is invisible from the client side
   * — the call resolves, the agent answers — and it lands on precisely the
   * arguments a UI passes: the directory a session opens in, the session being
   * resumed, the model being selected.
   *
   * So `params` is the single source of truth for each row: `call` is handed it
   * and the assertion compares it against what reached the wire. The mutation
   * being caught is in the wrapper, not the test, so sharing the literal costs
   * nothing and keeps the two from drifting.
   */
  interface WrapperCall {
    readonly method: string;
    /** The exact JSON-RPC `params` this wrapper must put on the wire. */
    readonly params: Record<string, unknown>;
    readonly call: (handle: AcpAgentHandle) => Promise<unknown>;
  }

  function wrapperCall<P extends Record<string, unknown>>(
    method: string,
    params: P,
    call: (handle: AcpAgentHandle, params: P) => Promise<unknown>,
  ): WrapperCall {
    return { method, params, call: (handle) => call(handle, params) };
  }

  const CALLS: readonly WrapperCall[] = [
    wrapperCall(
      'session/set_config_option',
      { sessionId: 's1', configId: 'model', value: 'claude-sonnet-4-6' },
      (handle, params) => handle.setSessionConfigOption(params),
    ),
    wrapperCall('session/close', { sessionId: 's1' }, (handle, params) =>
      handle.closeSession(params),
    ),
    wrapperCall(
      'session/resume',
      { sessionId: 's1', cwd: '/workspace' },
      (handle, params) => handle.resumeSession(params),
    ),
    wrapperCall(
      'session/fork',
      { sessionId: 's1', cwd: '/workspace' },
      (handle, params) => handle.forkSession(params),
    ),
    wrapperCall('session/delete', { sessionId: 's1' }, (handle, params) =>
      handle.deleteSession(params),
    ),
    wrapperCall(
      'session/set_mode',
      { sessionId: 's1', modeId: 'architect' },
      (handle, params) => handle.setSessionMode(params),
    ),
    // Deliberately not `{}`: every field of `session/list` is optional, so an
    // empty request is byte-identical to a wrapper that drops `params`
    // altogether — which is exactly the mutation that survived here.
    wrapperCall(
      'session/list',
      { cwd: '/workspace', cursor: 'page-2' },
      (handle, params) => handle.listSessions(params),
    ),
    wrapperCall(
      'session/load',
      { sessionId: 's1', cwd: '/workspace', mcpServers: [] },
      (handle, params) => handle.loadSession(params),
    ),
    wrapperCall('logout', {}, (handle, params) => handle.logout(params)),
  ];

  for (const { method, params, call } of CALLS) {
    it(
      `sends ${method} with the params it was handed, and fails it when the agent dies`,
      async () => {
        const agent = connectRaw();
        await rawSession(agent);

        const pending = call(agent.handle);
        const request = await agent.awaitRequest(method);

        // Read, not discarded — see the block comment on `CALLS`. Exact
        // equality rather than a field-by-field or subset check: a wrapper that
        // *adds* a field, or drops an optional one, is the same class of defect
        // as one that corrupts a value, and `toMatchObject` would wave the
        // first one through.
        expect(request['params']).toEqual(params);

        agent.handle.fail(new AcpAgentDisconnectedError('agy exited'));
        await expect(pending).rejects.toThrow('agy exited');
      },
      BUDGET,
    );

    it(
      `budgets ${method} rather than waiting on a mute agent`,
      async () => {
        const agent = connectRaw({}, { timeouts: { default: 60 } });

        const failure: unknown = await call(agent.handle).then(
          () => null,
          (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(AcpRequestTimeoutError);
        expect((failure as AcpRequestTimeoutError).method).toBe(method);
      },
      BUDGET,
    );
  }

  it(
    'is the difference the wrapper makes: the same call on `connection` never settles',
    async () => {
      // The measurement behind the wrapper, not a restatement of it. Same dead
      // agent, same request, one route through the handle and one straight at
      // `connection` — which is the route a model picker would have taken.
      const agent = connectRaw({}, { timeouts: { default: 60 } });
      await rawSession(agent);

      const params = {
        sessionId: 's1',
        configId: 'model',
        value: 'claude-sonnet-4-6',
      } as const;

      const unguarded = agent.handle.connection.setSessionConfigOption(params);
      agent.handle.fail(new AcpAgentDisconnectedError('agy exited with code 17'));

      await expect(agent.handle.setSessionConfigOption(params)).rejects.toThrow(
        'agy exited with code 17',
      );
      const outcome = await Promise.race([
        unguarded.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('still pending'), 250),
        ),
      ]);
      expect(outcome).toBe('still pending');
      // Nothing will ever settle it, so it is observed here rather than left
      // to surface as an unhandled rejection at teardown.
      unguarded.catch(() => undefined);
    },
    BUDGET,
  );
});

/**
 * The two wrappers the `CALLS` table deliberately skips, held to the same bar.
 *
 * `newSession` and `authenticate` are excluded from that table because each has
 * a describe of its own — but neither of those describes looked at what was
 * *sent*. Both survived having their params corrupted, which put them in the
 * same position as the ten the table was missing.
 *
 * They matter more than most, not less. `session/new`'s `cwd` **is** the early
 * "cwd ignored" defect this migration opened with: a directory the user picked,
 * accepted by the API, and quietly replaced on the way out — the session then
 * opens somewhere else and every file the agent reads is the wrong one, with
 * nothing anywhere reporting an error. And `authenticate`'s `methodId` chooses
 * *which* login runs, out of the list the agent advertised.
 */
describe('the params behind the first two things a UI does', () => {
  const BUDGET = 5_000;

  it(
    'delivers `session/new` exactly as the caller wrote it',
    async () => {
      const { handle, agent, toAgent } = connectFake();
      const request = {
        cwd: '/workspace/cozypad',
        additionalDirectories: ['/workspace/shared'],
        mcpServers: [],
      };

      await handle.initialize();
      await handle.newSession(request);

      // The wire is where the strict assertion belongs, because the bytes are
      // the whole of what this wrapper is responsible for.
      const sent = messages(toAgent).find(
        (message) => message['method'] === 'session/new',
      );
      expect(sent?.['params']).toEqual(request);

      // And it genuinely arrived, through a foreign implementation's framing
      // and zod validation — `cwd` is the field the early "cwd ignored" defect
      // corrupted, so it is checked as the agent actually received it.
      expect(agent.newSessionRequests).toHaveLength(1);
      expect(agent.newSessionRequests[0]?.cwd).toBe('/workspace/cozypad');
    },
    BUDGET,
  );

  it(
    'fails `session/new` when the agent dies, instead of spinning the button forever',
    async () => {
      // The params test above passes whether or not this wrapper is inside
      // `guard()` — which is exactly what made the gap invisible. Measured, not
      // assumed: a guard-bypass mutation on each of the fourteen wrappers
      // killed thirteen; `session/new` survived all 169 tests.
      //
      // This is the first request behind a "new session" button. An agent that
      // died between spawn and this call leaves an unguarded promise that
      // nothing will ever settle, and a UI with nothing to report.
      const agent = connectRaw();
      await rawSession(agent);

      const pending = agent.handle.newSession({
        cwd: '/workspace',
        mcpServers: [],
      });
      await agent.awaitRequest('session/new');

      agent.handle.fail(new AcpAgentDisconnectedError('agy exited'));
      await expect(pending).rejects.toThrow('agy exited');
    },
    BUDGET,
  );

  it(
    'budgets `session/new` rather than waiting on a mute agent',
    async () => {
      // The other half of `guard()`, and the half a dying-agent test cannot
      // reach: an agent that is still alive and simply never answers. Windows
      // gives no signal for that (see the two blind spots in
      // docs/ACP-MIGRATION.md), so the budget is the only thing that ends it.
      const agent = connectRaw({}, { timeouts: { default: 60 } });

      const failure: unknown = await agent.handle
        .newSession({ cwd: '/workspace', mcpServers: [] })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(AcpRequestTimeoutError);
      expect((failure as AcpRequestTimeoutError).method).toBe('session/new');
    },
    BUDGET,
  );

  it(
    'is why the far end is not the place to assert: 0.4.5 eats `additionalDirectories`',
    async () => {
      // Not a defect in anything we ship — it is the reason the assertion above
      // is split in two. `newSessionRequestSchema` in 0.4.5 declares only
      // `_meta`, `cwd` and `mcpServers`, and zod strips what it does not
      // declare, so a field added in 1.3.0 vanishes with no error on either
      // side. Asked of the old schema rather than remembered, in this file's
      // usual style: a future author who "simplifies" the test above into a
      // single far-end `toEqual` gets this test explaining why it went red.
      const { handle, agent } = connectFake();

      await handle.initialize();
      await handle.newSession({
        cwd: '/workspace/cozypad',
        additionalDirectories: ['/workspace/shared'],
        mcpServers: [],
      });

      const received = agent.newSessionRequests[0] as
        | Record<string, unknown>
        | undefined;
      expect(received).toBeDefined();
      expect(received).not.toHaveProperty('additionalDirectories');
      expect(
        legacyNewSessionRequestSchema.shape,
      ).not.toHaveProperty('additionalDirectories');
    },
    BUDGET,
  );

  it(
    'sends the `methodId` the user picked, not some other login',
    async () => {
      const agent = connectRaw({}, { timeouts: { authenticate: 200 } });

      const pending = agent.handle.authenticate({ methodId: 'claude-login' });
      const request = await agent.awaitRequest('authenticate');

      expect(request['params']).toEqual({ methodId: 'claude-login' });

      agent.handle.fail(new AcpAgentDisconnectedError('agy exited'));
      await expect(pending).rejects.toThrow('agy exited');
    },
    BUDGET,
  );
});

/**
 * C4. `authenticate` is not an agent operation, it is a **human** one.
 *
 * `codex-acp` advertises an interactive ChatGPT login, and an ACP auth method
 * of type `terminal` runs the agent's own binary for the user to log into. The
 * reply lands when a person has finished typing a password and clicking
 * through a consent screen, which the 30 s default cuts off long before.
 */
describe('the authenticate budget', () => {
  const BUDGET = 5_000;

  it('is far longer than the one every other request gets', () => {
    expect(DEFAULT_AUTHENTICATE_TIMEOUT_MS).toBe(600_000);
    expect(DEFAULT_AUTHENTICATE_TIMEOUT_MS).toBeGreaterThan(
      DEFAULT_REQUEST_TIMEOUT_MS * 10,
    );
  });

  it(
    'does not take the default, which would cut a real login off',
    async () => {
      // `default` is tiny and `authenticate` is left alone: if the wrapper took
      // `timeouts.default` this resolves as 'cut off' within 40 ms.
      const agent = connectRaw({}, { timeouts: { default: 40 } });
      const pending = agent.handle.authenticate({ methodId: 'claude-login' });
      await agent.awaitRequest('authenticate');

      const outcome = await Promise.race([
        pending.then(
          () => 'answered',
          () => 'cut off',
        ),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('still waiting for the user'), 250),
        ),
      ]);

      expect(outcome).toBe('still waiting for the user');
      agent.handle.fail(new Error('test over'));
      await expect(pending).rejects.toThrow('test over');
    },
    BUDGET,
  );

  it(
    'is still a budget, because there is no `cancel` for a login',
    async () => {
      // Unlike `session/prompt`, which is unbounded and cancellable, an
      // abandoned login has no way out but this.
      const agent = connectRaw({}, { timeouts: { authenticate: 50 } });

      const failure: unknown = await agent.handle
        .authenticate({ methodId: 'claude-login' })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(AcpRequestTimeoutError);
      expect((failure as AcpRequestTimeoutError).method).toBe('authenticate');
      expect((failure as AcpRequestTimeoutError).timeoutMs).toBe(50);
    },
    BUDGET,
  );
});

/**
 * The **premise** the divergences hide behind — not the divergences themselves.
 *
 * This block used to be called `cross-library divergences` and to claim it
 * pinned "the one that started this migration". It does not and never did: it
 * holds a single assertion that the two libraries **agree**. That agreement is
 * worth pinning, because it is the reason a divergence is silent rather than
 * loud — but it is the setup, not the finding.
 *
 * The divergences are pinned where the behaviour they break is tested:
 *
 * - `rawOutput`, the one that started the migration —
 *   `tool_call_update.rawOutput is unstructured, as the spec says` →
 *   *is exactly what the old library rejected*.
 * - the five missing `session/update` variants —
 *   `session/update variants the old library did not have` →
 *   *is exactly five, asked of the old schema rather than remembered*.
 */
describe('the handshake the two libraries agree on', () => {
  it('is identical, which is why the divergences were silent', () => {
    // Identical versions on both sides is precisely why 0.4.5 could drop data
    // for months without a single failed handshake. Nothing in the protocol
    // announces that one side understands fewer payloads than the other.
    expect(PROTOCOL_VERSION).toBe(LEGACY_PROTOCOL_VERSION);
  });
});

/**
 * LENS A ROUND 10 — the four wrappers whose params nothing compares.
 *
 * Measured, not guessed: with `packages/acp-client` copied and mutated one
 * wrapper at a time, 11 of the 14 wrappers die on both a corrupted value and an
 * *added* field. These four survive:
 *
 *   initialize  — `protocolVersion: 1`, `_meta` dropped, and an added field: all 3 SURVIVED
 *   prompt      — added field SURVIVED (its value-corruption "kills" are incidental:
 *                 the fake agent routes on sessionId, and emptying `prompt` changes
 *                 the byte count a connectProcess write test happens to observe)
 *   cancel      — added field SURVIVED (only the far end is asserted, and 0.4.5's
 *                 zod strips what it does not declare — the file's own warning)
 *   logout      — dropping params entirely SURVIVED, because the CALLS row is `{}`
 *                 and `LogoutRequest` has only an optional `_meta`. This is the
 *                 same defect as `session/list`'s `{}`, fixed there and not here.
 */
describe('LENSA the four wrappers whose params nothing compares', () => {
  const BUDGET = 5_000;

  it(
    'sends `initialize` exactly as the caller wrote it, version and _meta included',
    async () => {
      const agent = connectRaw();

      const pending = agent.handle.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        _meta: { 'cozypad.dev/client': 'desktop' },
      });
      const request = await agent.awaitRequest('initialize');

      // Exact equality: `protocolVersion` decides which protocol both sides
      // then speak, and `_meta` is the only channel a client has for saying
      // anything the schema does not describe. Both were droppable in silence.
      expect(request['params']).toEqual({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        _meta: { 'cozypad.dev/client': 'desktop' },
      });

      await agent.reply(request['id'], {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      });
      await pending;
    },
    BUDGET,
  );

  it(
    'defaults `initialize` to this library\'s protocol version, not to some other number',
    async () => {
      const agent = connectRaw();

      const pending = agent.handle.initialize();
      const request = await agent.awaitRequest('initialize');

      expect(
        (request['params'] as Record<string, unknown>)['protocolVersion'],
      ).toBe(PROTOCOL_VERSION);

      await agent.reply(request['id'], {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      });
      await pending;
    },
    BUDGET,
  );

  it(
    'sends `session/prompt` with the params it was handed',
    async () => {
      // The highest-traffic method in the protocol, and the one whose content
      // *is* the user's message. Nothing compared it to what the caller passed.
      const agent = connectRaw();
      await rawSession(agent);

      // Not `as const`: that widens to a `readonly` tuple, which `PromptRequest`
      // does not accept. vitest transpiles with esbuild and would never have
      // said so — `tsc -p tsconfig.tests.json` is what caught it.
      const params: PromptRequest = {
        sessionId: 's1',
        prompt: [{ type: 'text', text: 'the user typed this' }],
      };

      const pending = agent.handle.prompt(params);
      const request = await agent.awaitRequest('session/prompt');

      expect(request['params']).toEqual(params);

      agent.handle.fail(new AcpAgentDisconnectedError('agy exited'));
      await expect(pending).rejects.toThrow('agy exited');
    },
    BUDGET,
  );

  it(
    'sends `session/cancel` with the params it was handed, on the wire',
    async () => {
      // Asserted on the bytes rather than on the fake agent, because 0.4.5's
      // zod strips fields it does not declare — the far end cannot see an
      // added one, and this file already says so about `session/new`.
      const { handle, toAgent } = connectFake();

      await handle.initialize();
      const { sessionId } = await handle.newSession({
        cwd: '/workspace',
        mcpServers: [],
      });
      await handle.cancel({ sessionId });

      await vi.waitFor(() => {
        const sent = messages(toAgent).find(
          (message) => message['method'] === 'session/cancel',
        );
        expect(sent?.['params']).toEqual({ sessionId });
      });
    },
    BUDGET,
  );

  it(
    'sends `logout` with the params it was handed, which `{}` could never prove',
    async () => {
      // `LogoutRequest` declares only an optional `_meta`, so the CALLS row's
      // `{}` is byte-identical to a wrapper that drops `params` altogether.
      // Non-empty params are the whole of the test.
      const agent = connectRaw();
      await rawSession(agent);

      const params = { _meta: { 'cozypad.dev/lensA': 'logout-probe' } };

      const pending = agent.handle.logout(params);
      const request = await agent.awaitRequest('logout');

      expect(request['params']).toEqual(params);

      agent.handle.fail(new AcpAgentDisconnectedError('agy exited'));
      await expect(pending).rejects.toThrow('agy exited');
    },
    BUDGET,
  );
});
