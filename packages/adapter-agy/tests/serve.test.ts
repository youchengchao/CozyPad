/**
 * The stdio entry point — the module that *is* the agent when it runs as a
 * process, and previously had no test at all: `grep -rn serveAgyOverStdio tests/`
 * returned nothing, so routing the protocol to stderr instead of stdout (which
 * disables the agent completely, for every client, silently) left the suite green.
 *
 * The contract under test is the one stated at the top of src/serve.ts: **stdout
 * is the protocol, and every human-readable byte goes to stderr.** Both halves are
 * asserted, because each catches a different half of an inversion.
 *
 * The streams are three `PassThrough`s standing in for the real ones. Nothing else
 * is faked: a real `ClientSideConnection` talks real newline-delimited JSON-RPC
 * across them to the real `AgentSideConnection` that `serveAgyOverStdio` builds.
 */
import { PassThrough, Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serveAgyOverStdio, type ServeAgyIo } from '../src/serve.js';
import type { AgyTransport, AgyTurnEvent } from '../src/transport.js';

/** A transport that replays a script; no agy, and no child process. */
function scriptedTransport(script: AgyTurnEvent[]): AgyTransport {
  return {
    kind: 'cli',
    async listModels() {
      return { models: [], persistedDefault: null, diagnostics: [] };
    },
    runTurn() {
      return (async function* replay() {
        for (const event of script) yield event;
      })();
    },
    async dispose() {},
  };
}

interface Stdio {
  readonly io: ServeAgyIo;
  /** The same three objects as `io`, but writable from the test's side. */
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  /** Everything the agent wrote to its stdout. */
  stdoutText(): string;
  /** Everything the agent wrote to its stderr. */
  stderrText(): string;
  /** Write one JSON-RPC frame into the agent's stdin. */
  request(id: number, method: string, params: unknown): void;
  /** Wait for the reply to `id` and return its `result`. */
  reply(id: number): Promise<Record<string, unknown>>;
  end(): void;
}

/**
 * Three fake streams. `stdout` is tapped rather than consumed so a test can both
 * read the raw bytes and, where it wants to, hand them to a real client.
 */
function stdio(): Stdio {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
  stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

  const stdoutText = () => Buffer.concat(outChunks).toString('utf8');
  const lineFor = (id: number): string | undefined =>
    stdoutText()
      .split('\n')
      .find((line) => line.includes(`"id":${id}`));

  return {
    io: { stdin, stdout, stderr },
    stdin,
    stdout,
    stdoutText,
    stderrText: () => Buffer.concat(errChunks).toString('utf8'),
    request: (id, method, params) => {
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    },
    reply: async (id) => {
      await until(() => lineFor(id) !== undefined, `a reply to request ${id} on stdout`);
      const parsed = JSON.parse(lineFor(id) as string) as {
        result?: Record<string, unknown>;
        error?: unknown;
      };
      if (parsed.result === undefined) {
        throw new Error(`request ${id} failed: ${JSON.stringify(parsed.error)}`);
      }
      return parsed.result;
    },
    end: () => {
      stdin.end();
      stdout.end();
      stderr.end();
    },
  };
}

/**
 * Resolve once `predicate` holds, or reject after a bounded wait. In-process
 * PassThroughs settle in a couple of ticks; the budget is loose so a busy CI box
 * cannot turn a passing assertion into a flake, and tight enough that a genuinely
 * broken stream fails the run instead of hanging it.
 */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('serveAgyOverStdio', () => {
  it('answers on stdout, and puts nothing protocol-shaped on stderr', async () => {
    const streams = stdio();
    cleanups.push(streams.end);
    serveAgyOverStdio({ io: streams.io, transport: scriptedTransport([]) });

    // A raw request written straight into the fake stdin, so the assertion is
    // about bytes on a specific stream rather than about a client object.
    streams.request(1, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const result = await streams.reply(1);
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(streams.stdoutText()).toContain('"jsonrpc":"2.0"');

    // The inversion this file exists for: had the protocol gone to stderr, the
    // reply would be here and stdout would be empty.
    expect(streams.stderrText()).toBe('');
    expect(streams.stderrText()).not.toContain('jsonrpc');
  });

  it('runs a whole session over the fake stdio, keeping stdout pure JSON-RPC', async () => {
    const streams = stdio();
    cleanups.push(streams.end);

    serveAgyOverStdio({
      io: streams.io,
      transport: scriptedTransport([
        { type: 'conversation', conversationId: 'conv-serve' },
        {
          type: 'update',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'hello from stdout' },
          },
        },
        { type: 'end', stopReason: 'end_turn' },
      ]),
    });

    // The client reads the same stdout the assertions above tapped, and writes
    // into the same stdin — the agent's own view of the pipes, unmodified.
    const received: SessionNotification[] = [];
    const handler: Client = {
      async sessionUpdate(params) {
        received.push(params);
      },
      async requestPermission() {
        throw new Error('agy print mode never asks');
      },
      async readTextFile() {
        throw new Error('not used');
      },
      async writeTextFile() {
        throw new Error('not used');
      },
    };
    const client = new ClientSideConnection(
      () => handler,
      ndJsonStream(Writable.toWeb(streams.stdin), Readable.toWeb(streams.stdout)),
    );

    const initialize = await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    expect(initialize.protocolVersion).toBe(PROTOCOL_VERSION);

    const { sessionId } = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    const turn = await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'hi' }] });

    expect(turn.stopReason).toBe('end_turn');
    expect(
      received.flatMap((n) =>
        n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text'
          ? [n.update.content.text]
          : [],
      ),
    ).toEqual(['hello from stdout']);

    // Every line the agent emitted is a JSON-RPC frame. One stray `console.log`
    // in this path corrupts the stream for a real client; this is what says so.
    const lines = streams.stdoutText().split('\n').filter((line) => line.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe('2.0');
    }
    // stderr is the adapter's log, and it is not empty: a turn with no model
    // pinned says so there, which is the whole point of that line. The invariant
    // is the one this file exists for — no protocol frame ever goes to stderr.
    expect(streams.stderrText()).not.toContain('jsonrpc');
    expect(streams.stderrText()).toContain('[agy-acp] [model]');
  });

  it('sends its own diagnostics to stderr and never to stdout', async () => {
    const streams = stdio();
    cleanups.push(streams.end);

    // No `logger` override: this exercises the default one, which is the thing
    // that would corrupt stdout if it were wired to the wrong stream.
    serveAgyOverStdio({
      io: streams.io,
      transport: scriptedTransport([
        {
          type: 'diagnostic',
          diagnostic: { reason: 'unparseable_line', detail: 'not-json-at-all' },
        },
        { type: 'end', stopReason: 'end_turn' },
      ]),
    });

    streams.request(1, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    await streams.reply(1);
    streams.request(2, 'session/new', { cwd: process.cwd(), mcpServers: [] });
    const sessionId = (await streams.reply(2)).sessionId;
    expect(typeof sessionId).toBe('string');

    streams.request(3, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    });
    await streams.reply(3);

    expect(streams.stderrText()).toContain('unparseable_line');
    expect(streams.stderrText()).toContain('not-json-at-all');
    expect(streams.stdoutText()).not.toContain('not-json-at-all');
    // Diagnostics are logs, not protocol: nothing on stdout stopped being JSON.
    for (const line of streams.stdoutText().split('\n').filter((l) => l.trim() !== '')) {
      expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe('2.0');
    }
  });

  it('routes agy stderr into the injected logger rather than either stream', async () => {
    const streams = stdio();
    cleanups.push(streams.end);
    const logged: string[] = [];
    serveAgyOverStdio({
      io: streams.io,
      logger: (message) => logged.push(message),
      transport: scriptedTransport([
        { type: 'diagnostic', diagnostic: { reason: 'unmapped_step_type', detail: '{"a":1}' } },
        { type: 'end', stopReason: 'end_turn' },
      ]),
    });

    streams.request(1, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    await streams.reply(1);
    streams.request(2, 'session/new', { cwd: process.cwd(), mcpServers: [] });
    const sessionId = (await streams.reply(2)).sessionId;
    streams.request(3, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    });
    await streams.reply(3);

    // Both the transport's diagnostic and the adapter's own model note went to
    // the injected logger; neither reached either stream.
    expect(logged.filter((message) => message.startsWith('[unmapped_step_type]'))).toEqual([
      '[unmapped_step_type] {"a":1}',
    ]);
    expect(logged.some((message) => message.startsWith('[model] '))).toBe(true);
    expect(streams.stderrText()).toBe('');
  });

  it('defaults to process.stdout for the protocol, never process.stderr', () => {
    // Every test above injects `io`, so on its own none of them would notice the
    // *default* being rewired. This one watches which stream objects the real
    // default hands to the web-stream conversion, and substitutes the results so
    // the runner's own stdio is never touched.
    const spare = stdio();
    cleanups.push(spare.end);
    const realWritableToWeb = Writable.toWeb.bind(Writable);
    const realReadableToWeb = Readable.toWeb.bind(Readable);
    const seen: { writable?: unknown; readable?: unknown } = {};

    const writableSpy = vi
      .spyOn(Writable, 'toWeb')
      .mockImplementation(((stream: Writable) => {
        seen.writable = stream;
        return realWritableToWeb(spare.stdout);
      }) as typeof Writable.toWeb);
    const readableSpy = vi
      .spyOn(Readable, 'toWeb')
      .mockImplementation(((stream: Readable) => {
        seen.readable = stream;
        return realReadableToWeb(spare.stdin);
      }) as typeof Readable.toWeb);
    cleanups.push(() => {
      writableSpy.mockRestore();
      readableSpy.mockRestore();
    });

    serveAgyOverStdio({ transport: scriptedTransport([]) });

    expect(seen.writable).toBe(process.stdout);
    expect(seen.writable).not.toBe(process.stderr);
    expect(seen.readable).toBe(process.stdin);
  });
});
