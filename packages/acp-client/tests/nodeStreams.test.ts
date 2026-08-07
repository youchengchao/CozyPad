import { once } from 'node:events';
import net from 'node:net';
import { PassThrough, Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readableFromNodeStream,
  readableState,
  whenReadableFinished,
  writableToNodeStream,
  type NodeReadableLike,
  type NodeWritableLike,
} from '../src/nodeStreams';

/**
 * Mostly **real** Node streams, on purpose.
 *
 * Every hang this module has produced was a disagreement with Node about when
 * events fire, and a hand-written fake is exactly the thing that cannot
 * disagree — it emits whatever the test author believed. `PassThrough` and
 * `net.Socket` were measured (`destroy()` emits `close` and never `end`;
 * subscribing after a `destroy()` hears nothing at all), so the fixtures below
 * are the real objects and the assertions are the measurements.
 *
 * ## Why a `PassThrough` is not enough
 *
 * `PassThrough.destroy()` is one death shape out of five, and it is the *only*
 * one where `writableEnded` stays `false`. A suite built on it therefore cannot
 * see the bug that shipped: `net.Socket` defaults to `allowHalfOpen: false`, so
 * a peer's FIN makes Node end our writable half **for** us, and code that read
 * `writableEnded` as "we ended it" silently discarded three of the five shapes.
 * The socket matrix below exists so that a fixture disagrees with reality
 * instead of agreeing with the author. See `writableToNodeStream`'s own comment
 * for the measured flag table.
 *
 * The structural fakes that remain are here for one narrow purpose: proving the
 * declared interfaces are implementable *without* Node, which is what keeps
 * `src/` free of a Node dependency.
 */

const BUDGET = 3_000;

/** A stand-in for a Node `Readable`, with none of Node behind it. */
class FakeNodeReadable {
  readonly #listeners = new Map<string, Array<(arg?: unknown) => void>>();

  on(event: 'data', listener: (chunk: Uint8Array | string) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: string, listener: (...args: never[]) => void): this {
    const existing = this.#listeners.get(event) ?? [];
    existing.push(listener as (arg?: unknown) => void);
    this.#listeners.set(event, existing);
    return this;
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(arg);
  }
}

class FakeNodeWritable {
  readonly chunks: Uint8Array[] = [];
  ended = false;

  write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk);
    callback?.(null);
    return true;
  }

  end(): void {
    this.ended = true;
  }

  on(): this {
    return this;
  }
}

async function drain(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) chunks.push(value);
  }
  return chunks;
}

const decode = (chunks: Uint8Array[]): string =>
  new TextDecoder().decode(
    chunks.reduce<Uint8Array>((all, chunk) => {
      const merged = new Uint8Array(all.length + chunk.length);
      merged.set(all);
      merged.set(chunk, all.length);
      return merged;
    }, new Uint8Array()),
  );

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------ socket fixture ----------------------------- */

const openServers: net.Server[] = [];
const openSockets: net.Socket[] = [];

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  for (const server of openServers.splice(0)) server.close();
});

interface SocketPair {
  /** The end handed to the code under test. */
  readonly ours: net.Socket;
  /** The far end, which the test plays the part of. */
  readonly peer: net.Socket;
}

/**
 * A connected pair of real `net.Socket`s over loopback.
 *
 * Both ends are returned so a test can kill the *far* one, which is the whole
 * point: a peer-initiated death is a different event from a local teardown and
 * Node reports it through the same flags.
 */
async function socketPair(): Promise<SocketPair> {
  let announce!: (socket: net.Socket) => void;
  const peerReady = new Promise<net.Socket>((resolve) => {
    announce = resolve;
  });
  const server = net.createServer((socket) => {
    socket.resume();
    announce(socket);
  });
  openServers.push(server);
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
  openSockets.push(ours, peer);
  // Unhandled 'error' on a socket is a process-level throw, and several shapes
  // below produce one legitimately.
  ours.on('error', () => undefined);
  peer.on('error', () => undefined);
  return { ours, peer };
}

/**
 * Both channels a death can travel down, watched at once.
 *
 * `onError` reaches only whoever passed it; `writer.closed` is what
 * `connectAcpAgent` watches, and it passes no `onError`. A fix that satisfies
 * one and not the other is not a fix, so every assertion below checks both.
 */
function watchBothChannels(
  sink: NodeWritableLike,
  options: { readonly drainReadSide?: boolean } = {},
): {
  readonly onErrorMessage: () => string | null;
  readonly closedOutcome: () => Promise<'resolved' | string>;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
} {
  let reported: string | null = null;
  const stream = writableToNodeStream(sink, {
    onError: (error) => {
      reported ??= error.message;
    },
    ...(options.drainReadSide === undefined
      ? {}
      : { drainReadSide: options.drainReadSide }),
  });
  const writer = stream.getWriter();
  const closed = writer.closed.then(
    () => 'resolved' as const,
    (error: unknown) => (error as Error).message,
  );
  return {
    onErrorMessage: () => reported,
    closedOutcome: () => closed,
    writer,
  };
}

describe('readableFromNodeStream', () => {
  it('forwards byte and string chunks, then closes on end', async () => {
    const source = new FakeNodeReadable();
    const node: NodeReadableLike = source;
    const web = readableFromNodeStream(node);

    source.emit('data', new TextEncoder().encode('{"a":1}\n'));
    source.emit('data', '{"b":2}\n');
    source.emit('end');

    expect(decode(await drain(web))).toBe('{"a":1}\n{"b":2}\n');
  });

  it('surfaces a stream error to the reader', async () => {
    const source = new FakeNodeReadable();
    const web = readableFromNodeStream(source);

    source.emit('error', new Error('pipe broke'));

    await expect(drain(web)).rejects.toThrow('pipe broke');
  });

  it('ignores an error that arrives after end', async () => {
    const source = new FakeNodeReadable();
    const web = readableFromNodeStream(source);

    source.emit('data', 'x');
    source.emit('end');
    source.emit('error', new Error('too late'));

    expect(decode(await drain(web))).toBe('x');
  });

  it('ignores the close that always follows a clean end', async () => {
    const source = new FakeNodeReadable();
    const web = readableFromNodeStream(source);

    source.emit('data', 'x');
    source.emit('end');
    source.emit('close');

    expect(decode(await drain(web))).toBe('x');
  });
});

/**
 * The `cancel` latch, enforced by a named assertion instead of by a crash.
 *
 * A consumer that gives up leaves the controller closed, and Node keeps
 * emitting on the underlying stream long afterwards — which
 * `readableFromNodeStream`'s own comment calls "the ordinary path, not a
 * corner". `cancel()` latches `finished` so those later events are ignored.
 *
 * Take that latch away and this file still reports **0 failed** while exiting
 * 1. The `TypeError` is raised inside a Node event handler, so it arrives as an
 * unhandled error belonging to no test: CI goes red and nothing names the
 * cause. Worse, that is not even a stable tripwire — it disappears the moment
 * the reporter is swapped or `dangerouslyIgnoreUnhandledErrors` is set, and the
 * guard would then be enforced by nothing at all.
 *
 * These two use `FakeNodeReadable` for one specific reason: its `emit` is
 * **synchronous**, so the throw lands inside the `expect` rather than on the
 * process. That is the whole difference between a nameless exit code and a
 * failing test with an assertion behind it. A real stream cannot be used here —
 * Node schedules `end` asynchronously, which is precisely how this guard came
 * to be enforced by a crash in the first place.
 *
 * Why these two paths and not others, measured on Node 24: after a cancel,
 * `controller.close()` and `controller.enqueue()` both throw `TypeError:
 * Invalid state: Controller is already closed`, whereas `controller.error()` is
 * a silent no-op per the streams spec. So `end` and `data` discriminate, and
 * the `error` path cannot — an assertion there would pass with or without the
 * latch, which is the sort of test this round exists to delete rather than add.
 */
describe('readableFromNodeStream: a consumer that cancelled', () => {
  it('ignores an end that arrives after the cancel', async () => {
    const source = new FakeNodeReadable();
    const web = readableFromNodeStream(source);
    const reader = web.getReader();

    await reader.cancel('the consumer gave up');

    // Without the latch this is `controller.close()` on a closed controller.
    expect(() => source.emit('end')).not.toThrow();
  });

  it('ignores data that arrives after the cancel', async () => {
    const source = new FakeNodeReadable();
    const web = readableFromNodeStream(source);
    const reader = web.getReader();

    await reader.cancel('the consumer gave up');

    // A socket mid-flight has bytes in the receive buffer when the consumer
    // walks away; they are delivered regardless. Without the latch this is
    // `controller.enqueue()` on a closed controller.
    expect(() => source.emit('data', '{"late":true}\n')).not.toThrow();
  });
});

/**
 * HANG 2. A destroyed stream emits `close` and **never** `end` (measured:
 * `PassThrough.destroy()` fires `close` only; `net.Socket.destroy()` fires
 * `data` then `close`). Subscribing to `end`/`error` alone therefore never
 * hears anything, and every request in flight waits forever — and a local
 * socket teardown is the *normal* end of the SSH transport this package exists
 * to serve, so this is not an edge case.
 */
describe('readableFromNodeStream: a stream destroyed mid-flight', () => {
  it(
    'ends the web stream when a real PassThrough is destroyed',
    async () => {
      const source = new PassThrough();
      const web = readableFromNodeStream(source);

      source.write('partial');
      source.destroy();

      await expect(drain(web)).rejects.toThrow(
        'destroyed before it finished reading',
      );
    },
    BUDGET,
  );

  it(
    'reports the error a destroy carried, when it carried one',
    async () => {
      const source = new PassThrough();
      const web = readableFromNodeStream(source);

      source.destroy(new Error('ECONNRESET'));

      await expect(drain(web)).rejects.toThrow('ECONNRESET');
    },
    BUDGET,
  );
});

/**
 * HANG 1, at the stream layer. A stream that finished before anyone subscribed
 * emits nothing at all — measured on a child that exited 25 ms before the
 * listeners were attached: `readableEnded` and `destroyed` both `true`, zero
 * events thereafter. The wrapper has to *ask*.
 */
describe('readableFromNodeStream: a stream that already finished', () => {
  it(
    'closes immediately when the source already ended',
    async () => {
      const source = new PassThrough();
      source.end('everything');
      source.resume();
      await once(source, 'end');
      expect(source.readableEnded).toBe(true);
      expect(readableState(source)).toEqual({ kind: 'ended' });

      // Subscribed only now, after every event has already fired.
      const web = readableFromNodeStream(source);

      expect(decode(await drain(web))).toBe('');
    },
    BUDGET,
  );

  it(
    'fails immediately when the source was already destroyed',
    async () => {
      const source = new PassThrough();
      source.destroy();
      await once(source, 'close');
      expect(source.readableEnded).toBe(false);

      const web = readableFromNodeStream(source);

      await expect(drain(web)).rejects.toThrow(
        'destroyed before it finished reading',
      );
    },
    BUDGET,
  );

  it(
    'fails immediately when the source already errored',
    async () => {
      const source = new PassThrough();
      source.destroy(new Error('EPIPE'));
      await once(source, 'close').catch(() => undefined);

      const web = readableFromNodeStream(source);

      await expect(drain(web)).rejects.toThrow('EPIPE');
    },
    BUDGET,
  );
});

describe('whenReadableFinished', () => {
  it(
    'fires on a microtask for a stream that is already over',
    async () => {
      const source = new PassThrough();
      source.destroy();
      await once(source, 'close');

      let fired = false;
      whenReadableFinished(source, () => {
        fired = true;
      });
      // Not synchronous: callers register this before the object they touch
      // has finished being built.
      expect(fired).toBe(false);
      await Promise.resolve();
      expect(fired).toBe(true);
    },
    BUDGET,
  );

  it(
    'fires once for a stream that ends later',
    async () => {
      const source = new PassThrough();
      let calls = 0;
      whenReadableFinished(source, () => {
        calls += 1;
      });

      source.end('bye');
      source.resume();
      await once(source, 'close');
      await new Promise((resolve) => setTimeout(resolve, 10));

      // `end` and `close` both fire on a clean finish; the callback must not.
      expect(calls).toBe(1);
    },
    BUDGET,
  );

  it(
    'fires on a stream destroyed after we subscribed, which emits only `close`',
    async () => {
      // The gap between the two tests above: one destroys *before* subscribing
      // and takes the read-the-flags path, the other ends cleanly and is heard
      // through `end`. Neither reaches the `close` listener, so deleting it
      // left the whole suite green — while `connectAcpAgentProcess`, whose only
      // use of this function is deciding when a dead child's stderr has been
      // fully captured, silently stopped being told and waited out `exitGraceMs`
      // instead. A killed child destroys its stderr; it does not end it.
      const source = new PassThrough();
      let fired = false;
      whenReadableFinished(source, () => {
        fired = true;
      });

      source.destroy();
      await once(source, 'close');
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(fired).toBe(true);
    },
    BUDGET,
  );
});

describe('writableToNodeStream', () => {
  it('writes chunks through and ends the node stream on close', async () => {
    const sink = new FakeNodeWritable();
    const node: NodeWritableLike = sink;
    const web = writableToNodeStream(node);

    const writer = web.getWriter();
    await writer.write(new TextEncoder().encode('hello'));
    await writer.close();

    expect(decode(sink.chunks)).toBe('hello');
    expect(sink.ended).toBe(true);
  });

  it(
    'delivers bytes to a real Node writable',
    async () => {
      const seen: Uint8Array[] = [];
      const sink = new Writable({
        write(chunk: Uint8Array, _encoding, callback) {
          seen.push(Uint8Array.from(chunk));
          callback();
        },
      });
      const writer = writableToNodeStream(sink).getWriter();

      await writer.write(new TextEncoder().encode('{"jsonrpc":"2.0"}\n'));
      await writer.close();

      expect(decode(seen)).toBe('{"jsonrpc":"2.0"}\n');
    },
    BUDGET,
  );
});

/**
 * HANG 3. `write` returns *backpressure*, not success — the failure arrives
 * through the completion callback (measured: writing to a dead child's stdin
 * calls back with `ERR_STREAM_DESTROYED` while `write` merely returns `false`).
 * Discarding both meant a broken stdin looked like a healthy one, and the
 * request that had just been written was never answered and never failed.
 */
describe('writableToNodeStream: a write that fails', () => {
  it(
    'rejects the write when the node stream reports an error',
    async () => {
      const sink = new Writable({
        write(_chunk, _encoding, callback) {
          callback(new Error('EPIPE: broken pipe'));
        },
      });
      const writer = writableToNodeStream(sink).getWriter();

      await expect(
        writer.write(new TextEncoder().encode('x')),
      ).rejects.toThrow('EPIPE');
    },
    BUDGET,
  );

  it(
    'rejects a write to a stream that was already destroyed',
    async () => {
      const sink = new PassThrough();
      sink.destroy();
      await once(sink, 'close');

      const writer = writableToNodeStream(sink).getWriter();

      await expect(
        writer.write(new TextEncoder().encode('x')),
      ).rejects.toThrow();
    },
    BUDGET,
  );

  it(
    'reports the death through onError even with no write in flight',
    async () => {
      // The case that hung: the request bytes went out cleanly, *then* stdin
      // broke. Nothing writes again, so nothing else can notice.
      const sink = new PassThrough();
      const failures: Error[] = [];
      const writer = writableToNodeStream(sink, {
        onError: (error) => failures.push(error),
      }).getWriter();

      await writer.write(new TextEncoder().encode('{"id":1}\n'));
      sink.destroy();
      await once(sink, 'close');
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(failures).toHaveLength(1);
      expect(failures[0]?.message).toContain('closed before it was ended');
    },
    BUDGET,
  );

  it(
    'reports a stream that was already dead when it was handed over',
    async () => {
      const sink = new PassThrough();
      sink.destroy();
      await once(sink, 'close');

      const failures: Error[] = [];
      writableToNodeStream(sink, { onError: (error) => failures.push(error) });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(failures).toHaveLength(1);
    },
    BUDGET,
  );

  it(
    'errors the WritableStream itself, so `closed` rejects with nothing in flight',
    async () => {
      // `onError` only reaches whoever passed it. `connectAcpAgent` does not,
      // and it is the entry point an SSH channel uses — it watches
      // `writer.closed` instead, which stays pending forever unless the sink's
      // own controller is errored. Recording the failure privately is not the
      // same as declaring the stream dead.
      const sink = new PassThrough();
      const writer = writableToNodeStream(sink).getWriter();

      await writer.write(new TextEncoder().encode('{"id":1}\n'));
      sink.destroy();
      await once(sink, 'close');

      await expect(writer.closed).rejects.toThrow(
        'closed before it was ended',
      );
    },
    BUDGET,
  );

  it(
    'errors a WritableStream built on a stream that was already dead',
    async () => {
      // `die()` runs *before* the WritableStream exists here, so there is no
      // controller yet to error. The failure has to be replayed into `start`.
      const sink = new PassThrough();
      sink.destroy();
      await once(sink, 'close');

      const writer = writableToNodeStream(sink).getWriter();

      await expect(writer.closed).rejects.toThrow();
    },
    BUDGET,
  );

  it(
    'does not call onError for the close we cause ourselves',
    async () => {
      const sink = new PassThrough();
      sink.resume();
      const failures: Error[] = [];
      const writer = writableToNodeStream(sink, {
        onError: (error) => failures.push(error),
      }).getWriter();

      await writer.write(new TextEncoder().encode('bye\n'));
      await writer.close();
      await once(sink, 'close');
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(failures).toEqual([]);
    },
    BUDGET,
  );
});

/**
 * HANG 4, and the one no `PassThrough` test could ever have caught.
 *
 * `net.Socket` defaults to `allowHalfOpen: false`. When the peer sends a FIN,
 * Node ends **our** writable half on our behalf and sets `writableEnded` to
 * `true` — on a stream this process never ended. Code that read that flag as
 * "this was our own orderly shutdown" therefore threw away every peer-initiated
 * death: `writer.closed` stayed pending forever and `onError` never fired.
 * Measured over real loopback sockets before the fix, three of the four death
 * shapes below produced **no signal at all**, and with the shipping `prompt`
 * timeout of `null` that is a spinner with no end.
 *
 * The control at the bottom is as load-bearing as the rest: a fix that reports
 * our *own* `close()` as a failure would pass every test above it.
 */
describe('writableToNodeStream: the real-socket death matrix', () => {
  const SOCKET_BUDGET = 10_000;

  /** Resolves to `'HUNG'` rather than waiting, so a hang is an assertion. */
  async function settleWithin<T>(
    promise: Promise<T>,
    ms: number,
  ): Promise<T | 'HUNG'> {
    return await Promise.race([
      promise,
      sleep(ms).then(() => 'HUNG' as const),
    ]);
  }

  it(
    'measures the trap itself: a peer FIN sets writableEnded on a socket we never ended',
    async () => {
      // Pinned as a measurement, not as an assumption. If a future Node ever
      // stops auto-ending our writable half, this is the test that says the
      // reason `endedByUs` exists has gone away.
      const { ours, peer } = await socketPair();
      expect(ours.writableEnded).toBe(false);

      peer.end();
      await once(ours, 'close');

      expect(ours.writableEnded).toBe(true);
      // And no error was emitted either — there is nothing else to notice it by.
      expect(ours.errored).toBeNull();
    },
    SOCKET_BUDGET,
  );

  it(
    'reports a peer FIN on both channels',
    async () => {
      const { ours, peer } = await socketPair();
      const watched = watchBothChannels(ours);
      await watched.writer.write(new TextEncoder().encode('{"id":1}\n'));

      peer.end();

      expect(await settleWithin(watched.closedOutcome(), 5_000)).toBe(
        'the far end closed the connection (the write half read EOF)',
      );
      expect(watched.onErrorMessage()).toBe(
        'the far end closed the connection (the write half read EOF)',
      );
    },
    SOCKET_BUDGET,
  );

  it(
    'reports a peer destroy on both channels',
    async () => {
      const { ours, peer } = await socketPair();
      const watched = watchBothChannels(ours);
      await watched.writer.write(new TextEncoder().encode('{"id":1}\n'));

      peer.destroy();

      // Whether the far end's teardown reaches us as a FIN or as a reset is the
      // platform's business (measured as a FIN on Windows / Node 24). That it
      // reaches us *at all* is this package's, so the assertion is on the
      // signal arriving rather than on which of the two it is.
      const outcome = await settleWithin(watched.closedOutcome(), 5_000);
      expect(outcome).not.toBe('HUNG');
      expect(outcome).not.toBe('resolved');
      expect(watched.onErrorMessage()).not.toBeNull();
    },
    SOCKET_BUDGET,
  );

  it(
    'reports a peer destroy that lands after its data drained',
    async () => {
      const { ours, peer } = await socketPair();
      // The `resume()` here is the test consuming the read half *itself*, which
      // is what this case is about: a socket already in flowing mode when the
      // peer goes away. The case where nobody has resumed it is the one below,
      // and it is a different test because it used to be a permanent hang.
      //
      // (An earlier version of this comment justified the `resume()` with "in
      // this package the read half is always being drained by `ndJsonStream`".
      // That is false for a split transport — `ndJsonStream` drains the *input
      // stream*, a different object from this socket — and it was the reasoning
      // that kept the bug below alive for three rounds.)
      ours.resume();
      const watched = watchBothChannels(ours);
      await watched.writer.write(new TextEncoder().encode('{"id":1}\n'));

      peer.write('bytes from the agent\n');
      await once(ours, 'data');
      peer.destroy();

      const outcome = await settleWithin(watched.closedOutcome(), 5_000);
      expect(outcome).not.toBe('HUNG');
      expect(outcome).not.toBe('resolved');
      expect(watched.onErrorMessage()).not.toBeNull();
    },
    SOCKET_BUDGET,
  );

  it(
    'reports a local destroy as the teardown it is, not as a peer close',
    async () => {
      const { ours } = await socketPair();
      const watched = watchBothChannels(ours);
      await watched.writer.write(new TextEncoder().encode('{"id":1}\n'));

      ours.destroy();

      // The one shape where `writableEnded` stays false, and the only one the
      // PassThrough fixtures above could reach. It is also the one shape where
      // naming a half is not guesswork: nothing came in, we tore it down.
      expect(await settleWithin(watched.closedOutcome(), 5_000)).toBe(
        'the write half closed before it was ended',
      );
      expect(watched.onErrorMessage()).toBe(
        'the write half closed before it was ended',
      );
    },
    SOCKET_BUDGET,
  );

  it(
    'reports a socket that never connected',
    async () => {
      // Port 1 on loopback refuses; the socket errors before it is ever
      // writable, so `die` runs with no controller yet to error.
      const dead = net.connect(1, '127.0.0.1');
      openSockets.push(dead);
      dead.on('error', () => undefined);
      const watched = watchBothChannels(dead);

      const outcome = await settleWithin(watched.closedOutcome(), 5_000);
      expect(outcome).not.toBe('HUNG');
      expect(String(outcome)).toContain('ECONNREFUSED');
    },
    SOCKET_BUDGET,
  );

  it(
    'CONTROL: our own close is not a death',
    async () => {
      // Every assertion above is satisfied by a wrapper that simply reports
      // every `close` as a failure. This is the test that stops it.
      const { ours } = await socketPair();
      const watched = watchBothChannels(ours);

      await watched.writer.write(new TextEncoder().encode('{"id":1}\n'));
      await watched.writer.close();
      await once(ours, 'close');
      await sleep(20);

      expect(await settleWithin(watched.closedOutcome(), 2_000)).toBe(
        'resolved',
      );
      expect(watched.onErrorMessage()).toBeNull();
    },
    SOCKET_BUDGET,
  );
});

/**
 * HANG 5. The SSH-channel shape, and the reason the transport seam exists.
 *
 * A **split** transport gives this package two objects: a readable that carries
 * the agent's stdout and a writable that carries its stdin. When that writable
 * is a duplex — an SSH channel, a `net.Socket` — it has a read side nobody in
 * this package consumes. Node emits `end` only once a readable's buffer has
 * been drained *and* EOF has arrived, and `close` only once both halves are
 * done, so a single unread inbound byte suppresses every terminal event on the
 * whole object. Measured on Windows / Node 24 with 21 bytes unread, 1.2 s after
 * the far end went away: `events: []`, `destroyed: false`,
 * `writableEnded: false`, `bytesRead: 21` — for a FIN *and* for a destroy. The
 * same cell with the read side resumed closes in 0–1 ms.
 *
 * Three previous rounds dismissed this as unreachable on the grounds that
 * "`ndJsonStream` always drains the input". It does — it drains the **input
 * stream**, which on a split transport is a different object from this one, and
 * nothing anywhere resumed the write half. With the shipping budgets
 * (`{default: null, prompt: null}`) the request then never settled at all.
 *
 * The `CONTROL` at the end is what stops the fix from being "resume everything
 * and hope": bytes that a consumer was waiting for must still reach it.
 */
describe('writableToNodeStream: a split transport with a dirty write half', () => {
  const SOCKET_BUDGET = 10_000;

  /** The 21 unread bytes from the measurement above. */
  const INBOUND = 'unconsumed-inbound!!\n';

  /**
   * A write half with inbound bytes sitting unread on it.
   *
   * `socketPair` leaves `ours` unresumed, which is the split-transport shape:
   * the ACP input is elsewhere, so nothing here ever reads this socket.
   */
  async function dirtyWriteHalf(): Promise<SocketPair> {
    const pair = await socketPair();
    pair.peer.write(INBOUND);
    // Long enough for the bytes to land in the receive buffer. Without the
    // wait the peer's FIN can overtake them and the socket dies normally,
    // which would make this whole suite pass for the wrong reason.
    await sleep(150);
    expect(pair.ours.bytesRead).toBe(INBOUND.length);
    return pair;
  }

  async function settleWithin<T>(
    promise: Promise<T>,
    ms: number,
  ): Promise<T | 'HUNG'> {
    return await Promise.race([promise, sleep(ms).then(() => 'HUNG' as const)]);
  }

  it(
    'measures the trap itself: undrained, a peer FIN produces no event at all',
    async () => {
      // Pinned as a measurement of Node, not as a wish. `drainReadSide: false`
      // is the shipping behaviour this round replaced; if a future Node ever
      // starts reporting the death anyway, this test says the fix below has
      // become belt-and-braces rather than load-bearing.
      const { ours, peer } = await dirtyWriteHalf();
      const watched = watchBothChannels(ours, { drainReadSide: false });
      await watched.writer.write(new TextEncoder().encode('{"id":1}\n'));

      peer.end();
      await sleep(600);

      expect(ours.destroyed).toBe(false);
      expect(ours.writableEnded).toBe(false);
      expect(ours.errored).toBeNull();
      expect(await settleWithin(watched.closedOutcome(), 400)).toBe('HUNG');
      expect(watched.onErrorMessage()).toBeNull();
    },
    SOCKET_BUDGET,
  );

  it(
    'reports a peer FIN on a write half that has unread inbound bytes',
    async () => {
      const { ours, peer } = await dirtyWriteHalf();
      const watched = watchBothChannels(ours);
      await watched.writer.write(new TextEncoder().encode('{"id":1}\n'));

      peer.end();

      // Named, not merely reported: on a split transport the read half is a
      // different object and may still be perfectly healthy, so "the stream
      // closed" would send the reader to the wrong socket.
      expect(await settleWithin(watched.closedOutcome(), 5_000)).toBe(
        'the far end closed the connection (the write half read EOF)',
      );
      expect(watched.onErrorMessage()).toBe(
        'the far end closed the connection (the write half read EOF)',
      );
    },
    SOCKET_BUDGET,
  );

  it(
    'reports a peer destroy on a write half that has unread inbound bytes',
    async () => {
      const { ours, peer } = await dirtyWriteHalf();
      const watched = watchBothChannels(ours);
      await watched.writer.write(new TextEncoder().encode('{"id":1}\n'));

      peer.destroy();

      // Whether the teardown reaches us as a FIN or as a reset is the
      // platform's business; that it reaches us at all is this package's.
      const outcome = await settleWithin(watched.closedOutcome(), 5_000);
      expect(outcome).not.toBe('HUNG');
      expect(outcome).not.toBe('resolved');
      expect(watched.onErrorMessage()).not.toBeNull();
    },
    SOCKET_BUDGET,
  );

  it(
    'CONTROL: draining does not steal bytes from a consumer that attached first',
    async () => {
      // The one thing the drain must never do is take somebody else's bytes
      // away. A `data` listener registered before the wrapper is built still
      // receives everything, including what was already buffered.
      //
      // ⚠️ Passing this is **not** sufficient. It only covers the ordering
      // where the consumer went first; the suite below covers the ones where it
      // does not, which is where the bytes were actually being lost.
      const { ours, peer } = await dirtyWriteHalf();
      const seen: string[] = [];
      ours.on('data', (chunk: Buffer) => seen.push(chunk.toString()));

      const watched = watchBothChannels(ours);
      await watched.writer.write(new TextEncoder().encode('{"id":1}\n'));
      peer.write('after\n');
      await sleep(150);

      expect(seen.join('')).toBe(`${INBOUND}after\n`);
    },
    SOCKET_BUDGET,
  );

  it(
    "CONTROL: a write-only stream's read side is left alone",
    async () => {
      // Modelled on the measured shape of a spawned child's `stdin` on Windows:
      // a `Socket` that carries a `resume` method but reports
      // `readable === false` and `readableEnded === true`, because its handle
      // was opened write-only. Resuming that asks Node to start reading a
      // handle there is nothing to read from, so the flag — not the presence of
      // the method — is what the drain gates on.
      let resumed = false;
      const stdinShaped: NodeWritableLike = {
        readable: false,
        readableEnded: true,
        resume: () => {
          resumed = true;
        },
        write: (_chunk, callback) => {
          callback?.(null);
          return true;
        },
        on: () => undefined,
      };

      writableToNodeStream(stdinShaped);

      expect(resumed).toBe(false);
    },
    BUDGET,
  );
});

/**
 * HANG 6. The drain that fixed HANG 5 by throwing the bytes away.
 *
 * A duplex used as **both** halves — `readableFromNodeStream(socket)` for input,
 * `writableToNodeStream(socket)` for output — is the SSH-channel shape the drain
 * was added to serve. The write half has to move that socket's read side or the
 * transport can never report its own death (HANG 5). The round that did so let
 * `resume()` discard what it moved, and `resume()` starts reading whether or not
 * anyone is there to catch it.
 *
 * Measured on Windows / Node 24 over a real loopback socket carrying `PRELOAD`
 * before either wrapper existed, against that discarding drain:
 *
 * | order | received |
 * |---|---|
 * | input, then output, synchronously | `PRELOAD` + `AFTER` |
 * | output, then input, synchronously | `PRELOAD` + `AFTER` |
 * | output, one microtask, then input | `PRELOAD` + `AFTER` |
 * | output, `await sleep(50)`, then input | **`AFTER` only** |
 *
 * Three of four passed on tick timing alone — which is why the previous round's
 * single CONTROL test (consumer first, synchronously) was green while a dropped
 * JSON-RPC response was shipping. On `session/prompt`, whose budget is `null`,
 * a dropped response is a spinner that never ends.
 *
 * Every ordering is therefore a case here, and the delayed one is the point.
 */
describe('writableToNodeStream: one duplex handed in as both halves', () => {
  const SOCKET_BUDGET = 10_000;
  const PRELOAD = 'PRELOAD\n';
  const AFTER = 'AFTER\n';

  /** A socket with `PRELOAD` already on the wire and nothing reading it. */
  async function preloaded(): Promise<SocketPair> {
    const pair = await socketPair();
    pair.peer.write(PRELOAD);
    // Long enough for the bytes to reach the receive buffer. Without the wait
    // the test proves nothing: there would be nothing buffered to lose.
    await sleep(150);
    expect(pair.ours.bytesRead).toBe(PRELOAD.length);
    return pair;
  }

  /** Reads `web` for `ms`, returning the text it delivered. */
  async function readFor(
    web: ReadableStream<Uint8Array>,
    ms: number,
  ): Promise<string> {
    const reader = web.getReader();
    let text = '';
    const deadline = Date.now() + ms;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const next = await Promise.race([
        reader.read(),
        sleep(left).then(() => 'TIMEUP' as const),
      ]);
      if (next === 'TIMEUP') break;
      if (next.done) break;
      if (next.value !== undefined) {
        text += new TextDecoder().decode(next.value);
      }
    }
    return text;
  }

  /**
   * Builds both wrappers over one socket in the given order, then checks that
   * everything sent arrived exactly once.
   *
   * Exact equality rather than `toContain`, deliberately: a handover that
   * replayed its buffer *and* let the live subscription see the same chunks
   * would satisfy "contains" while doubling every frame, which on an ndJSON
   * transport is its own protocol error.
   */
  async function bothHalves(
    build: (
      socket: net.Socket,
    ) => Promise<ReadableStream<Uint8Array>> | ReadableStream<Uint8Array>,
  ): Promise<void> {
    const { ours, peer } = await preloaded();
    const web = await build(ours);
    peer.write(AFTER);

    expect(await readFor(web, 400)).toBe(`${PRELOAD}${AFTER}`);
  }

  it(
    'delivers everything when the input wrapper is built first',
    async () => {
      await bothHalves((socket) => {
        const web = readableFromNodeStream(socket);
        writableToNodeStream(socket);
        return web;
      });
    },
    SOCKET_BUDGET,
  );

  it(
    'delivers everything when the output wrapper is built first',
    async () => {
      await bothHalves((socket) => {
        writableToNodeStream(socket);
        return readableFromNodeStream(socket);
      });
    },
    SOCKET_BUDGET,
  );

  it(
    'delivers everything across a microtask between the two',
    async () => {
      await bothHalves(async (socket) => {
        writableToNodeStream(socket);
        await Promise.resolve();
        return readableFromNodeStream(socket);
      });
    },
    SOCKET_BUDGET,
  );

  it(
    'REGRESSION: delivers everything across an await between the two',
    async () => {
      // The cell that shipped broken. `await sleep(50)` is not exotic — it is
      // any real work between constructing the halves: an SSH channel opening,
      // a config read, an `await` on the transport handshake.
      await bothHalves(async (socket) => {
        writableToNodeStream(socket);
        await sleep(50);
        return readableFromNodeStream(socket);
      });
    },
    SOCKET_BUDGET,
  );

  it(
    'REGRESSION: delivers everything across a long await between the two',
    async () => {
      await bothHalves(async (socket) => {
        writableToNodeStream(socket);
        await sleep(500);
        return readableFromNodeStream(socket);
      });
    },
    SOCKET_BUDGET,
  );

  it(
    'delivers everything when the output wrapper is built long afterwards',
    async () => {
      // The mirror image, so the fix cannot be "special-case one direction".
      await bothHalves(async (socket) => {
        const web = readableFromNodeStream(socket);
        await sleep(50);
        writableToNodeStream(socket);
        return web;
      });
    },
    SOCKET_BUDGET,
  );

  it(
    'still reports the death that the drain exists for, with bytes captured',
    async () => {
      // The whole point of moving the read side (HANG 5) has to survive the fix
      // for losing what it moved. Capturing into userland must not stop Node
      // from reaching EOF on the handle.
      const { ours, peer } = await preloaded();
      let reported: string | null = null;
      const stream = writableToNodeStream(ours, {
        onError: (error) => {
          reported ??= error.message;
        },
      });
      const writer = stream.getWriter();
      const closed = writer.closed.then(
        () => 'resolved',
        (error: unknown) => (error as Error).message,
      );
      await writer.write(new TextEncoder().encode('{"id":1}\n'));

      peer.end();

      const outcome = await Promise.race([
        closed,
        sleep(5_000).then(() => 'HUNG'),
      ]);
      expect(outcome).toBe(
        'the far end closed the connection (the write half read EOF)',
      );
      expect(reported).toBe(
        'the far end closed the connection (the write half read EOF)',
      );
    },
    SOCKET_BUDGET,
  );

  it(
    'fails a late consumer rather than handing it a hole',
    async () => {
      // Past the handover cap the bytes really are gone, and the choice is
      // between saying so and delivering a truncated ndJSON stream in which a
      // half-frame silently becomes a different frame. A dropped JSON-RPC
      // response is the failure mode this whole file exists to prevent, so it
      // is raised rather than papered over.
      const { ours, peer } = await socketPair();
      writableToNodeStream(ours);
      // Comfortably past the 1 MiB cap.
      peer.write(Buffer.alloc(3 * 1024 * 1024, 0x61));
      await sleep(600);

      const web = readableFromNodeStream(ours);
      const reader = web.getReader();
      let failure: string | null = null;
      // Bounded, so a regression reports "never failed" instead of eating the
      // whole test budget and reporting a timeout that names nothing.
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const next = await Promise.race([
          reader.read().catch((error: unknown) => {
            failure = (error as Error).message;
            return { done: true as const };
          }),
          sleep(Math.max(0, deadline - Date.now())).then(() => ({
            done: true as const,
          })),
        ]);
        if (next.done) break;
      }
      expect(failure).toContain('inbound bytes were dropped');
    },
    SOCKET_BUDGET,
  );

  /**
   * The claim has to *stop* the capture, and only a second consumer can tell.
   *
   * `readableFromNodeStream` sets `handover.claimed` so the drain's capture
   * listener stands down. Change that one assignment to `false` and every other
   * test in this file still passes — the first consumer has its own `data`
   * listener and receives every byte either way, so nothing it can observe
   * changes. What changes is invisible until somebody else looks: the capture
   * keeps buffering a second copy of a stream that is already being delivered,
   * and once that copy passes the cap it raises the overflow flag.
   *
   * The resulting failure is **fabricated**, which is worse than a missed one.
   * The test above proves a genuinely late consumer is failed rather than handed
   * a hole; these two prove the same machinery stays quiet on a healthy
   * connection, where not one byte was ever lost. Without them, a regression
   * there reports `DRAINED_BYTES_LOST` on a connection that is working
   * perfectly, and sends the next reader hunting for a data loss that never
   * happened.
   */
  it(
    'leaves a second consumer nothing to inherit once the first has claimed',
    async () => {
      const { ours, peer } = await socketPair();
      writableToNodeStream(ours);
      const first = readableFromNodeStream(ours);

      peer.write('LIVE\n');
      expect(await readFor(first, 300)).toBe('LIVE\n');

      // Everything sent so far went out live, so nothing is owed to anyone. A
      // capture still running would have kept its own copy and replayed it
      // here — and `LIVE\n` arriving a second time, on an ndJSON transport, is
      // a duplicated JSON-RPC frame rather than a harmless extra byte.
      //
      // This assertion needs no knowledge of the 1 MiB cap, which is why it is
      // the primary pin: it holds whatever that constant is changed to.
      const second = readableFromNodeStream(ours);
      peer.write(AFTER);

      expect(await readFor(second, 300)).toBe(AFTER);
    },
    SOCKET_BUDGET,
  );

  it(
    'does not invent DRAINED_BYTES_LOST after a healthy megabyte',
    async () => {
      // Comfortably past the 1 MiB cap, exactly as the deliberate-overflow test
      // above does — the difference is that here a consumer claimed *before*
      // the bytes flowed, so this is an ordinary busy connection rather than a
      // late arrival, and the overflow flag must never be raised at all.
      const TOTAL = 3 * 1024 * 1024;
      const { ours, peer } = await socketPair();
      writableToNodeStream(ours);
      const first = readableFromNodeStream(ours);

      let received = 0;
      const counting = (async () => {
        const reader = first.getReader();
        while (received < TOTAL) {
          const { value, done } = await reader.read();
          if (done) break;
          received += value?.length ?? 0;
        }
      })();

      peer.write(Buffer.alloc(TOTAL, 0x61));
      await Promise.race([counting, sleep(5_000)]);
      // The scenario has to be the healthy one it claims to be: if the socket
      // stalled instead, the assertions below would pass for the wrong reason.
      expect(received).toBe(TOTAL);

      const second = readableFromNodeStream(ours);
      peer.write(AFTER);
      const outcome = await readFor(second, 500).then(
        (text) => ({ failure: null as string | null, text }),
        (error: unknown) => ({ failure: (error as Error).message, text: '' }),
      );

      // Named rather than left as a bare rejection, so a regression here reads
      // as "a working connection was told it lost bytes" instead of as an
      // anonymous failure somewhere in the read path.
      expect(outcome.failure).toBeNull();
      expect(outcome.text).toBe(AFTER);
    },
    SOCKET_BUDGET,
  );
});

/**
 * The structural interfaces have to keep admitting Node's real classes, or the
 * "no `node:stream` import" promise in `src/` buys nothing.
 */
describe('the structural interfaces still admit real Node streams', () => {
  it('accepts a Readable and a Writable without a cast', () => {
    const readable: NodeReadableLike = Readable.from([]);
    const writable: NodeWritableLike = new PassThrough();
    expect(typeof readable.on).toBe('function');
    expect(typeof writable.write).toBe('function');
  });
});
