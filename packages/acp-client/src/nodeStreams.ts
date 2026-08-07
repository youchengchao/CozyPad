/**
 * Bridges Node's stream objects to the WHATWG streams `ndJsonStream` expects.
 *
 * The shapes below are structural on purpose. `node:stream` is never imported,
 * so this package stays free of a Node dependency and can be exercised in a
 * plain test without a child process — while a real `ChildProcess` still
 * satisfies these interfaces.
 *
 * ## Why terminal state is read, not just subscribed to
 *
 * Every hang this module has produced came from the same mistake: subscribing
 * to events on a stream that had **already finished emitting them**. Node
 * fires `end`/`close` once; a listener attached afterwards hears nothing, ever.
 * Measured on Windows / Node 24 (`scratchpad/probe-streams.mjs`):
 *
 * | situation | `readableEnded` | `destroyed` | events after subscribing |
 * |---|---|---|---|
 * | child exited 25 ms before we subscribed | `true` | `true` | **none** |
 * | `PassThrough.destroy()` | `false` | `true` | `close` only |
 * | `net.Socket.destroy()` | `false` | `true` | `data`, `close` — no `end` |
 * | subscribing after a `destroy()` | `false` | `true` | **none** |
 *
 * So each wrapper below asks the stream what state it is in *first*, and only
 * then subscribes — and it subscribes to `close` as well as `end`, because a
 * destroyed stream emits only the former. Node guarantees `close` on destroy;
 * it guarantees `end` only on a read that runs to completion.
 *
 * ## Why the *write* half's read side is drained
 *
 * A duplex handed over as the output half — an SSH channel, a `net.Socket` —
 * has a read side this package does not otherwise use. Leaving it alone is not
 * neutral: Node emits `end` only once the readable buffer has been consumed
 * *and* EOF has arrived, and `close` only once both halves are done. So a
 * single unread inbound byte suppresses **every** terminal event on the whole
 * object. Measured on Windows / Node 24, a loopback socket used as a write half
 * with 21 bytes sitting unread, 1.2 s after the far end went away:
 *
 * | far end did | drained? | events | `destroyed` | `writableEnded` |
 * |---|---|---|---|---|
 * | `end()` (FIN) | no | **none** | `false` | `false` |
 * | `destroy()` | no | **none** | `false` | `false` |
 * | `end()` (FIN) | `resume()` | `end`,`finish`,`close` | `true` | `true` |
 * | `destroy()` | `resume()` | `end`,`finish`,`close` | `true` | `true` |
 *
 * With the drain the `close` lands in 0–1 ms; without it nothing ever lands.
 * {@link writableToNodeStream} therefore moves the read side by default —
 * see {@link WritableToNodeStreamOptions.drainReadSide}.
 *
 * `resume()` is what restarts the flow, **not** an ignored `on('data')`
 * listener: measured in the same run, attaching a `data` listener to an
 * explicitly paused stream does not restart it, and all four cells above stayed
 * at "none". Node documents that a `data` listener switches to flowing mode
 * *unless the stream was explicitly paused*, and a write half nobody reads is
 * exactly the stream somebody paused.
 *
 * ## Why the drained bytes are kept rather than discarded
 *
 * The previous round resumed the read side and let the bytes fall on the floor,
 * on the reasoning that a *split* transport's write half carries nothing anyone
 * wants. That reasoning does not survive the **duplex** case, where the same
 * object is handed to {@link readableFromNodeStream} as the input — and that is
 * the SSH-channel shape the drain was added to serve. Measured on Windows /
 * Node 24 over a real loopback socket carrying `PRELOAD` before either wrapper
 * was built, with a discarding `resume()`:
 *
 * | construction order | outcome |
 * |---|---|
 * | input, then output, synchronously | `PRELOAD` + `AFTER` |
 * | output, then input, synchronously | `PRELOAD` + `AFTER` |
 * | output, one microtask, then input | `PRELOAD` + `AFTER` |
 * | output, `await sleep(50)`, then input | **`AFTER` only — `PRELOAD` gone** |
 *
 * Three of the four survive on tick timing alone: `resume()` schedules its
 * first read, so a listener attached in the same tick still catches everything.
 * Put any real `await` between the two constructions and the buffered bytes are
 * read and dropped before the consumer exists. On an ACP transport a dropped
 * frame is a dropped JSON-RPC response, and `session/prompt` has no budget to
 * catch it, so that is a spinner with no end — the exact failure the drain was
 * introduced to remove, reintroduced through a different door.
 *
 * So the drain **captures**: it takes delivery of the read side into a bounded
 * handover buffer, and {@link readableFromNodeStream} claims whatever is
 * waiting there before it subscribes. Order and delay stop mattering, because
 * no arrangement of the two calls leaves the bytes with nobody holding them.
 * Past {@link HANDOVER_LIMIT} the buffer stops growing and a later consumer is
 * **errored** rather than handed a hole — see {@link DRAINED_BYTES_LOST}.
 */

/** The part of a Node `Readable` this module uses. */
export interface NodeReadableLike {
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  /**
   * Required, not optional. `close` is the *only* notice a destroyed stream
   * gives — a socket torn down locally, which is the normal end of the SSH
   * transport this package is meant to serve, emits `close` and never `end`.
   */
  on(event: 'close', listener: () => void): unknown;

  /**
   * Node's own terminal-state flags. Optional so a hand-rolled test double is
   * not forced to model all of them; absent is read as "not in that state",
   * which degrades to the subscribe-only behaviour rather than to a hang, and
   * a real `Readable` always supplies them.
   */
  readonly readableEnded?: boolean;
  readonly destroyed?: boolean;
  readonly closed?: boolean;
  readonly errored?: Error | null;
}

/** The part of a Node `Writable` this module uses. */
export interface NodeWritableLike {
  /**
   * The **callback** form. `write`'s return value is backpressure, not success:
   * a failed write reports through this callback (measured: writing to a dead
   * child's stdin calls back with `ERR_STREAM_DESTROYED`) or through `error`,
   * and a wrapper that ignores both turns a broken pipe into a request that is
   * never answered and never explained.
   */
  write(chunk: Uint8Array, callback?: (error?: Error | null) => void): unknown;
  end?(): unknown;
  /** Required for the same reason as on {@link NodeReadableLike}. */
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  /**
   * The read side's chunks, subscribed to only when this writable is really a
   * duplex — see the `readable` flag below.
   *
   * Listed here because the drain **takes delivery** of those chunks rather
   * than letting `resume()` discard them; a bare `resume()` loses whatever was
   * already buffered if a consumer attaches even one macrotask later (measured
   * — see the module comment).
   */
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown;

  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
  readonly errored?: Error | null;

  /* --- the read side, present only when the writable is really a duplex --- */

  /**
   * Optional because a plain `Writable` has none of what follows, and the
   * distinction is load-bearing rather than cosmetic: it is how this module
   * tells "an agent's stdin" from "one direction of a socket".
   *
   * Measured on Windows / Node 24: a spawned child's `stdin` reports
   * `readable === false` and `readableEnded === true` even though it is a
   * `Socket` that *does* carry a `resume` method. A `net.Socket` used as one
   * half of a split transport reports `readable === true`. That flag, not the
   * presence of `resume`, is what {@link writableToNodeStream} gates the drain
   * on — see the module comment.
   */
  readonly readable?: boolean;
  /** Whether the read side has already delivered EOF. */
  readonly readableEnded?: boolean;
  /**
   * Restarts the flow on the read side.
   *
   * Moving the bytes is the point: a stalled read side hides the death of the
   * whole socket. Where they *go* is the part an earlier round got wrong — it
   * let `resume()` discard them, on the reasoning that a split transport's
   * input is a different object so nobody wants these. On a duplex handed to
   * {@link readableFromNodeStream} as well, that is exactly backwards and cost
   * a measured `PRELOAD`. The drain now takes delivery instead; see the module
   * comment.
   */
  resume?(): unknown;
}

/**
 * The part of a Node `ChildProcess` this package uses.
 *
 * `on` is not optional. Ending stdout already fails the connection on its own,
 * but only the process knows *why* it stopped — the exit code, the signal —
 * and that is the difference between "agy exited with code 17" and "the stream
 * closed". Requiring the events in the type stops a caller from handing over a
 * half-process that can never explain its own death.
 *
 * `exitCode` and `signalCode` matter for the same reason the stream flags do:
 * a process that exited *before* anyone subscribed will never emit `exit`, so
 * the status has to be read rather than waited for.
 */
export interface NodeChildProcessLike {
  stdin: NodeWritableLike | null;
  stdout: NodeReadableLike | null;
  /** Read only to quote the agent's last words in a death diagnostic. */
  stderr?: NodeReadableLike | null;
  /** Non-null once the process has exited. `exit` will not fire again. */
  readonly exitCode?: number | null;
  /** Non-null once the process was killed by a signal. */
  readonly signalCode?: string | null;
  on(
    event: 'exit',
    /** `signal` is Node's `NodeJS.Signals`, widened so this stays Node-free. */
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** What a stream that stopped before ending is reported as. */
const DESTROYED_BEFORE_END =
  'the stream was destroyed before it finished reading';

/**
 * How many drained bytes are held for a consumer that has not attached yet.
 *
 * One mebibyte, and the size is a compromise between two failure modes rather
 * than a tuning knob. Too small and a duplex whose peer front-loads a burst
 * loses part of it while the caller is still building the other wrapper; too
 * large and a genuine *split* transport — whose write-half read side nobody
 * will ever claim — pins that much memory for the life of the connection. A
 * mebibyte is ~7 000 typical ACP frames, far more than any construction window,
 * and a bounded cost when the bytes turn out to be garbage after all.
 */
const HANDOVER_LIMIT = 1024 * 1024;

/**
 * What a consumer that attached too late to get everything is failed with.
 *
 * The alternative was handing over the bytes that *did* fit and saying nothing,
 * which on an ndJSON transport means a truncated frame silently becoming a
 * different frame. A loud failure is recoverable; a quiet hole in a JSON-RPC
 * stream is the forever-spinner this module keeps being asked to remove.
 */
const DRAINED_BYTES_LOST =
  'inbound bytes were dropped: the write half read more than ' +
  `${String(HANDOVER_LIMIT)} bytes before anything claimed them`;

/**
 * Bytes a drain took off a duplex before a consumer for them existed.
 *
 * Keyed by the stream object, because the two halves of a duplex transport are
 * built by two independent calls — {@link writableToNodeStream} and
 * {@link readableFromNodeStream} — that are handed the *same* object and
 * otherwise know nothing about each other. This is the only thing joining them,
 * and it is what makes their order and spacing irrelevant.
 */
interface ReadSideHandover {
  /** Captured and not yet handed over, oldest first. */
  readonly chunks: Uint8Array[];
  /** Total length of {@link ReadSideHandover.chunks}. */
  bytes: number;
  /** Whether anything was dropped for exceeding {@link HANDOVER_LIMIT}. */
  overflowed: boolean;
  /**
   * Whether a consumer has taken over delivery.
   *
   * Once set, the capture listener stands down: the consumer's own `data`
   * listener is on the same stream and receives every later chunk directly, so
   * continuing to buffer would duplicate the bytes and leak.
   */
  claimed: boolean;
  /**
   * Whether a capture listener is already attached.
   *
   * Wrapping one duplex as a writable twice is a caller error, but a silently
   * *doubled* one: two listeners would buffer each chunk twice and a later
   * consumer would be handed every frame twice over. One listener per stream,
   * however many wrappers ask for it.
   */
  capturing: boolean;
}

/** Weak so a finished transport is not kept alive by its own leftovers. */
const handovers = new WeakMap<object, ReadSideHandover>();

function handoverFor(stream: object): ReadSideHandover {
  const existing = handovers.get(stream);
  if (existing !== undefined) return existing;
  const created: ReadSideHandover = {
    chunks: [],
    bytes: 0,
    overflowed: false,
    claimed: false,
    capturing: false,
  };
  handovers.set(stream, created);
  return created;
}

/**
 * What a write half torn down under us is reported as.
 *
 * "The write half", not "the stream": on a split transport the read half is a
 * different object that may still be perfectly healthy, and a diagnostic that
 * says "the stream" sends the reader looking at the wrong one.
 */
const WRITE_HALF_TORN_DOWN = 'the write half closed before it was ended';

/**
 * What a write half whose own read side hit EOF is reported as.
 *
 * This is the far end hanging up, observed from the *inbound* direction of the
 * write channel — and it is only observable at all because the read side is
 * drained (see the module comment). Distinct from
 * {@link WRITE_HALF_TORN_DOWN} because it is not the same event and that
 * wording would be a lie here: the write half *was* ended, just not by us.
 */
const WRITE_HALF_PEER_EOF =
  'the far end closed the connection (the write half read EOF)';

/**
 * What a write half Node ended on our behalf, with no EOF seen, is reported as.
 *
 * The residual case, kept honest rather than folded into the one above: every
 * socket shape measured takes the EOF branch once the read side is drained, so
 * reaching this one means `writableEnded` flipped without the read side saying
 * why. Saying so is more useful than guessing which of the other two it was.
 */
const WRITE_HALF_ENDED_FOR_US =
  'the far end closed the connection (the write half was ended for us)';

/**
 * Whether a readable can still deliver anything, and if not, why.
 *
 * `'ended'` means every byte arrived; `'broken'` means the stream stopped
 * without saying so, and pretending otherwise would claim data was received
 * that may never have been.
 */
export type ReadableState =
  | { readonly kind: 'live' }
  | { readonly kind: 'ended' }
  | { readonly kind: 'broken'; readonly error: Error };

/** Reads a Node readable's terminal state without waiting for an event. */
export function readableState(stream: NodeReadableLike): ReadableState {
  const errored = stream.errored;
  if (errored !== null && errored !== undefined) {
    return { kind: 'broken', error: errored };
  }
  // Checked before `destroyed`: a stream that ended is *also* destroyed
  // afterwards (measured: both `true` on a child that exited), and the clean
  // ending is the truth about the bytes.
  if (stream.readableEnded === true) return { kind: 'ended' };
  if (stream.destroyed === true || stream.closed === true) {
    return { kind: 'broken', error: new Error(DESTROYED_BEFORE_END) };
  }
  return { kind: 'live' };
}

/** Whether a readable has reached any terminal state at all. */
export function readableIsFinished(stream: NodeReadableLike): boolean {
  return readableState(stream).kind !== 'live';
}

/**
 * Calls `done` once the readable can produce nothing further — immediately (on
 * a microtask) if it is already there.
 *
 * `done` runs at most once, and never synchronously, so a caller can register
 * it before the object it wants to touch has finished being constructed.
 */
export function whenReadableFinished(
  stream: NodeReadableLike,
  done: () => void,
): void {
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    done();
  };
  if (readableIsFinished(stream)) {
    queueMicrotask(fire);
    return;
  }
  stream.on('end', fire);
  stream.on('close', fire);
  stream.on('error', fire);
}

/**
 * Wraps a Node readable (an agent's stdout) as a byte `ReadableStream`.
 *
 * A stream that both ends and errors — or errors twice — must not be closed
 * twice, so the terminal state is latched. That terminal state is load-bearing
 * beyond this function: `connectAcpAgent` watches for it and fails the
 * connection, which is what stops an agent that closes stdout without exiting
 * from leaving a request pending forever.
 *
 * ## Claiming what a drain already took
 *
 * When `stream` is a duplex that was *also* handed to
 * {@link writableToNodeStream}, that call has been moving this read side since
 * before this one existed — otherwise the socket could never report its own
 * death (see the module comment). Whatever it captured is replayed here, ahead
 * of everything live, so the caller may build the two wrappers in either order
 * and with any delay between them. Without this, an `await` between the two
 * constructions lost every byte already on the wire; measured, and the table is
 * in the module comment.
 */
export function readableFromNodeStream(
  stream: NodeReadableLike,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // Claimed here rather than inside `start` only so the intent reads in order;
  // `start` runs synchronously during the construction below, and Node cannot
  // deliver a `data` event in between, so the two are the same instant.
  const handover = handoverFor(stream);
  const inherited = handover.chunks.splice(0);
  const lostBytes = handover.overflowed;
  handover.bytes = 0;
  handover.overflowed = false;
  // Stands the capture listener down. From here the subscription below is the
  // one taking delivery, and a still-capturing drain would double every chunk.
  handover.claimed = true;
  // Declared out here so `cancel` can latch it too. A consumer that gives up
  // leaves the controller closed, and a `close`/`error` afterwards throws
  // `ERR_INVALID_STATE` — which surfaces as an uncaught exception, from a Node
  // event handler, with no way to attribute it. Node keeps emitting `end` on a
  // stream long after the web stream reading it was cancelled, so this is the
  // ordinary path, not a corner.
  let finished = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const close = (): void => {
        if (finished) return;
        finished = true;
        controller.close();
      };
      const fail = (error: Error): void => {
        if (finished) return;
        finished = true;
        controller.error(error);
      };

      // Ahead of the terminal-state check below, because these bytes arrived
      // *before* whatever that check is about to report. A stream that has
      // since ended still owes its consumer what it already said.
      for (const chunk of inherited) controller.enqueue(chunk);
      if (lostBytes) {
        fail(new Error(DRAINED_BYTES_LOST));
        return;
      }

      // Asked, not awaited. A process that died before this call — the agy
      // that is not logged in, which prints to stderr and exits 17 within
      // milliseconds — has already emitted everything it will ever emit.
      const state = readableState(stream);
      if (state.kind === 'ended') {
        close();
        return;
      }
      if (state.kind === 'broken') {
        fail(state.error);
        return;
      }

      stream.on('data', (chunk) => {
        if (finished) return;
        controller.enqueue(
          typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
        );
      });
      stream.on('end', close);
      stream.on('error', fail);
      stream.on('close', () => {
        if (finished) return;
        // `close` follows `end` on a clean read and is latched away above. On
        // its own it means `destroy()`, and then bytes may have been dropped —
        // reporting that as a clean EOF would tell the connection the agent
        // finished speaking when it was cut off.
        if (stream.readableEnded === true) close();
        else fail(new Error(DESTROYED_BEFORE_END));
      });
    },
    cancel() {
      // The consumer is done. Nothing may touch the controller after this.
      finished = true;
    },
  });
}

/** Reads a Node writable's terminal state without waiting for an event. */
function writableFailure(stream: NodeWritableLike): Error | null {
  const errored = stream.errored;
  if (errored !== null && errored !== undefined) return errored;
  if (stream.destroyed === true) return new Error(WRITE_HALF_TORN_DOWN);
  return null;
}

/**
 * Which half died, from the flags the stream carries at `close` time.
 *
 * Read at `close`, not subscribed to: an `end` on the read side is *not* on its
 * own a reason to declare the transport dead. A socket opened with
 * `allowHalfOpen: true` can still be written to after its peer hangs up, and
 * killing the connection there would abort a send that would have succeeded.
 * With the default `allowHalfOpen: false` the EOF ends the write half anyway,
 * and then this runs — with `readableEnded` already `true`, which is how the
 * far end gets named instead of guessed at.
 */
function writeHalfCloseReason(stream: NodeWritableLike): string {
  if (stream.readableEnded === true) return WRITE_HALF_PEER_EOF;
  if (stream.writableEnded === true) return WRITE_HALF_ENDED_FOR_US;
  return WRITE_HALF_TORN_DOWN;
}

/**
 * Restarts the flow on the write half's read side, so the socket can die —
 * keeping what arrives, in case the same object is somebody's input.
 *
 * See the module comment for both measurements. Two guards, both deliberate:
 *
 * - No `resume` at all means a plain `Writable` — an agent's stdin as modelled
 *   by a test, a `new Writable({write})` sink. There is no read side to stall.
 * - `readable !== true` means the read side is already finished or was never
 *   started. A spawned child's `stdin` is the case that matters (measured:
 *   `readable === false`, `readableEnded === true`, yet `resume` exists); it is
 *   left alone because resuming it would ask Node to start reading a handle
 *   that was opened write-only.
 *
 * The capture listener goes on **before** `resume()`, which is this module's
 * standing rule about ordering: subscribing after starting the flow is how the
 * bytes got lost in the first place.
 */
function drainWriteHalfReadSide(stream: NodeWritableLike): void {
  if (typeof stream.resume !== 'function') return;
  if (stream.readable !== true) return;

  const handover = handoverFor(stream);
  // Only when nobody is taking delivery already. A consumer that got here
  // first has its own `data` listener on this stream and needs no help; all
  // this call still owes the socket is the `resume()` below, and on a stream
  // a consumer already put in flowing mode even that is a no-op.
  if (!handover.claimed && !handover.capturing) {
    handover.capturing = true;
    const encoder = new TextEncoder();
    stream.on('data', (chunk) => {
      if (handover.claimed) return;
      const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
      // Past the cap the bytes are dropped, but the *fact* is not: a consumer
      // that shows up later is failed rather than handed a truncated stream.
      if (handover.bytes + bytes.length > HANDOVER_LIMIT) {
        handover.overflowed = true;
        return;
      }
      handover.chunks.push(bytes);
      handover.bytes += bytes.length;
    });
  }
  stream.resume();
}

export interface WritableToNodeStreamOptions {
  /**
   * Called at most once, asynchronously, when the Node stream dies.
   *
   * A convenience for a caller that holds this object directly. It is **not**
   * the only way the death travels — the `WritableStream` returned below is
   * errored as well, so `writer.closed` rejects and a caller that never passed
   * an `onError` still learns. Both fire; whichever the caller watches is the
   * one that matters.
   */
  readonly onError?: (error: Error) => void;
  /**
   * Whether to move the read side when `stream` is really a duplex. Defaults
   * to `true`, which is what makes a split transport able to report its own
   * death at all — see the module comment for the measured table.
   *
   * The bytes are **kept, not discarded**, so leaving this on is safe even when
   * `stream` is a duplex whose read side something else is meant to consume:
   * {@link readableFromNodeStream} on the same object claims whatever was
   * captured, in order, ahead of anything live. Construction order and any
   * delay between the two calls are both irrelevant — which is the correction
   * this round. An earlier version of this paragraph said "attaching first is
   * enough and needs no flag"; that was measured only in the two synchronous
   * orderings, and `await`ing anything between the two constructions lost every
   * byte already on the wire. The module comment has the four-way table.
   *
   * The one limit is {@link HANDOVER_LIMIT}: past it the capture stops growing,
   * and a consumer that attaches afterwards is failed with
   * {@link DRAINED_BYTES_LOST} rather than handed a stream with a hole in it.
   *
   * `false` restores the shipping behaviour exactly, including its blind spot:
   * one unread inbound byte and a peer FIN or destroy produces no event, no
   * flag change, and no failure — ever. There is no longer a byte-safety reason
   * to reach for it.
   */
  readonly drainReadSide?: boolean;
}

/**
 * Wraps a Node writable (an agent's stdin) as a byte `WritableStream`.
 *
 * Every write goes through the completion callback, so a broken pipe rejects
 * the write instead of being dropped. Backpressure falls out of the same
 * change: the returned promise settles when Node has accepted the chunk.
 *
 * ## Why the stream is errored and not merely flagged
 *
 * A rejected `write` reaches only whoever writes next, and nothing writes next
 * when a request has been sent and the client is waiting for the answer —
 * which is exactly when a broken stdin matters. Recording the failure in a
 * variable has the same blind spot: nobody reads it either.
 *
 * So `die` errors the `WritableStream`'s own controller. That is what makes
 * `writer.closed` reject, and `writer.closed` is the only channel
 * `connectAcpAgent` has — it passes no `onError`. Without it, an output sink
 * that died with nothing in flight hung until a watchdog fired.
 *
 * That net matters for a **split** transport — one whose readable half is a
 * different object, an SSH channel demultiplexed into two streams — and only
 * there. On a duplex `net.Socket` the same death also ends the read half, and
 * `connectAcpAgent` fails the request from that side regardless of what this
 * function does. Measured over a real loopback socket, from `connect` to the
 * request rejecting: 74–108 ms for all four duplex death shapes, against a
 * split transport where three of the four never settled at all.
 *
 * The controller is reached through `start`, which is also where a stream that
 * was **already dead when it was handed over** gets caught up: `die` runs
 * before the `WritableStream` exists in that case, so there is no controller
 * yet to error.
 *
 * ## Why the read side is moved before any of that can work
 *
 * All of the above is downstream of an event arriving, and on a split transport
 * no event arrives at all unless the write half's own read side is being moved.
 * The previous round of this file dismissed the case with "in this package the
 * read half is always being drained by `ndJsonStream`" — which is true of the
 * **input stream** and says nothing about this object. `ndJsonStream` drains
 * the readable it was handed; on a split transport that is a different socket,
 * and nothing anywhere resumed this one. One unread inbound byte then
 * suppressed every terminal event on it, and with the shipping `prompt` budget
 * of `null` a peer FIN was a spinner with no end. The module comment has the
 * measured table; {@link WritableToNodeStreamOptions.drainReadSide} is the
 * switch, and it defaults to on.
 *
 * The round after that got the *destination* wrong instead: it let `resume()`
 * discard what it moved, which is correct for a split transport and silently
 * destructive for a duplex handed to {@link readableFromNodeStream} as well —
 * the SSH-channel shape this was all for. An `await` between the two
 * constructions dropped every byte already on the wire. The drain now captures
 * into a handover buffer that {@link readableFromNodeStream} claims, so no
 * ordering and no delay can lose data; the four-way table is in the module
 * comment.
 *
 * ## Why `writableEnded` cannot mean "we ended it"
 *
 * `net.Socket` defaults to `allowHalfOpen: false`, so a FIN from the peer makes
 * Node end **our** writable half for us. Measured on Windows / Node 24 over a
 * real loopback socket, watching a stream this side never ended:
 *
 * | how the socket died | events on our socket | `writableEnded` | `errored` |
 * |---|---|---|---|
 * | we called `destroy()` | `close` | `false` | `null` |
 * | peer called `destroy()` | `end`,`finish`,`close` | **`true`** | `null` |
 * | peer called `end()` | `end`,`finish`,`close` | **`true`** | `null` |
 * | peer `destroy()` after drain | `end`,`finish`,`close` | **`true`** | `null` |
 * | *we* called `end()` | `finish`,`end`,`close` | `true` | `null` |
 *
 * Three of the four deaths are indistinguishable from an orderly shutdown by
 * every flag Node exposes — no `error` is emitted in any of them, and the only
 * thing separating the last row from the three above it is the order of
 * `finish` and `end`, which is far too fine a thread to hang a diagnostic on.
 * So the distinction is *recorded* instead: `endedByUs` is set by the only code
 * that can legitimately end this stream, which is this wrapper's own
 * `close`/`abort`. Reading the flag instead cost the three peer-initiated
 * shapes their entire signal — `writer.closed` stayed pending forever and
 * `onError` never fired — and with the shipping `prompt` timeout of `null`, one
 * peer FIN on a split transport was a spinner with no end.
 */
export function writableToNodeStream(
  stream: NodeWritableLike,
  options: WritableToNodeStreamOptions = {},
): WritableStream<Uint8Array> {
  const onError = options.onError;
  let failure: Error | null = null;
  let controller: WritableStreamDefaultController | null = null;
  /** Set only by {@link endOurselves}. See the note on `writableEnded` above. */
  let endedByUs = false;
  const pending = new Set<(error: Error) => void>();

  // `error()` is a no-op once the stream has left the `writable` state, so a
  // death that lands after an orderly `close()` cannot raise anything.
  const errorStream = (error: Error): void => {
    controller?.error(error);
  };

  const die = (error: Error): void => {
    if (failure !== null) return;
    failure = error;
    const abandoned = [...pending];
    pending.clear();
    for (const abandon of abandoned) abandon(error);
    errorStream(error);
    if (onError !== undefined) queueMicrotask(() => onError(error));
  };

  /**
   * Ends the Node stream, remembering that *we* were the ones who did it.
   *
   * The flag is set only when there is an `end` to call, so a writable without
   * one — which this wrapper therefore never ends — keeps reporting its close
   * as the failure it is.
   */
  const endOurselves = (): void => {
    if (stream.end === undefined) return;
    endedByUs = true;
    stream.end();
  };

  const already = writableFailure(stream);
  if (already !== null) {
    die(already);
  } else {
    stream.on('error', die);
    stream.on('close', () => {
      // The orderly shutdown is the one this wrapper performed itself, and
      // that is the *only* thing `endedByUs` is true for. Every other close
      // means bytes can no longer be delivered, including the three shapes
      // where Node has already flipped `writableEnded` on our behalf — a peer
      // FIN, a peer destroy, a peer destroy after drain. Reading that flag
      // here instead of this one discarded all three (see above).
      if (endedByUs) return;
      // Which half, not just "the stream": on a split transport the read half
      // is a different object and may be fine. See `writeHalfCloseReason`.
      die(new Error(writeHalfCloseReason(stream)));
    });
    // Last, so the `error` and `close` it unblocks have somewhere to land.
    // Subscribing after starting the flow would be this module's original
    // mistake in a new place, and the cost of getting it right is one line of
    // ordering. (`drainWriteHalfReadSide` applies the same rule internally to
    // its own capture listener.)
    if (options.drainReadSide !== false) drainWriteHalfReadSide(stream);
  }

  return new WritableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      // The stream was dead before this object existed, so `die` had no
      // controller to error and this is the first chance to say so.
      const known = failure;
      if (known !== null) errorStream(known);
    },
    write(chunk) {
      const known = failure;
      if (known !== null) return Promise.reject(known);
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const abandon = (error: Error): void => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        pending.add(abandon);
        stream.write(chunk, (error) => {
          if (settled) return;
          settled = true;
          pending.delete(abandon);
          if (error === null || error === undefined) resolve();
          else reject(error);
        });
      });
    },
    close() {
      endOurselves();
    },
    abort() {
      endOurselves();
    },
  });
}
