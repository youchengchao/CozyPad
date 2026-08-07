import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type ClientCapabilities,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type LogoutRequest,
  type LogoutResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from '@agentclientprotocol/sdk';
import { createAcpClient, deriveClientCapabilities } from './client';
import type { AcpClientHandlers } from './handlers';
import {
  readableFromNodeStream,
  whenReadableFinished,
  writableToNodeStream,
  type NodeChildProcessLike,
  type NodeReadableLike,
} from './nodeStreams';

/**
 * Why a prompt turn ended.
 *
 * ACP declares these inline on `PromptResponse`, so consumers that want to
 * switch on the reason need this alias. Derived from the response rather than
 * from the SDK's `StopReason` export so the two can never disagree.
 */
export type AcpStopReason = PromptResponse['stopReason'];

/** Overrides for the `initialize` handshake. Both fields have defaults. */
export interface AcpInitializeOptions {
  /** Defaults to the protocol version this library was built against. */
  protocolVersion?: number;
  /**
   * Defaults to {@link deriveClientCapabilities} over the injected handlers.
   * Override only to advertise *less* than is wired up.
   */
  clientCapabilities?: ClientCapabilities;
  _meta?: Record<string, unknown>;
}

/**
 * The reason a connection stopped being able to answer.
 *
 * The facts are carried as fields, not only baked into the message, so a UI
 * can render "agy exited with code 1" next to what agy actually printed
 * instead of showing a generic "request failed".
 */
export class AcpAgentDisconnectedError extends Error {
  /** The child's exit code, or `null` if it was signalled or never started. */
  readonly exitCode: number | null;
  /** The signal that killed the child, or `null`. */
  readonly signal: string | null;
  /** The tail of the agent's stderr, `''` if it said nothing. */
  readonly stderr: string;

  constructor(
    message: string,
    details: {
      exitCode?: number | null;
      signal?: string | null;
      stderr?: string;
    } = {},
  ) {
    super(message);
    this.name = 'AcpAgentDisconnectedError';
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.stderr = details.stderr ?? '';
  }
}

/**
 * A request the agent never answered inside its budget.
 *
 * Distinct from {@link AcpAgentDisconnectedError} because the two mean
 * different things to a UI and to a retry: a disconnect says the agent is
 * *gone*, a timeout says it is (probably) still there and simply did not
 * reply. Only this one leaves the connection usable.
 */
export class AcpRequestTimeoutError extends Error {
  /** The ACP method that went unanswered, e.g. `'initialize'`. */
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(
      `${method} was not answered within ${String(timeoutMs)}ms. ` +
        'The ACP agent is still connected but did not reply.',
    );
    this.name = 'AcpRequestTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * How long each request waits for an answer. `null` means "wait forever".
 *
 * **This is the deliberate answer to "a live agent that never replies".** ACP
 * has no heartbeat: an agent that is thinking and an agent that is wedged emit
 * exactly the same thing, which is nothing. docs/ACP-MIGRATION.md measured agy
 * spending 83% of an 8-second turn silent, so "it has gone quiet" cannot be the
 * signal — it is the normal case.
 *
 * The split below follows from that, and is not a compromise:
 *
 * - Everything except a prompt is a **bounded, local** operation — a handshake,
 *   a session record, a mode switch. An agent that cannot answer `initialize`
 *   in 30 seconds is broken, and saying so beats a spinner. Hence a default.
 * - `session/prompt` is **unbounded by nature**. A turn is however long the
 *   model and its tools take; a cap would eventually abort real work, and
 *   silently, since a cancelled turn and a slow one look alike. Hence `null`,
 *   and the caller's tool for a turn that has gone on too long is
 *   {@link AcpAgentHandle.cancel}, which the agent acknowledges — a decision,
 *   not a guess.
 *
 *   What `null` costs, stated plainly: a wedged agent never resolves and never
 *   explains itself, and two shapes reach exactly that state with no
 *   death-shaped signal at all on Windows (see {@link connectAcpAgentProcess}).
 *   {@link AcpAgentHandle.status} and {@link ConnectAcpAgentOptions.onStall}
 *   make that wait **visible and cancellable**; they do not make it
 *   **diagnosable**, and an earlier version of this paragraph claiming they
 *   "discharge" the risk was overselling them. A wedged agent and a slow one
 *   report identical status — measured, see {@link AcpConnectionStatus}. The
 *   caller's real tool is {@link AcpAgentHandle.cancel} in the user's hands.
 * - `authenticate` is the third case, and the one the first bullet got wrong.
 *   It is a **human** operation, not an agent one: the reply arrives when
 *   someone has finished logging in, which is neither bounded nor local. It
 *   gets its own budget — see {@link DEFAULT_AUTHENTICATE_TIMEOUT_MS}.
 *
 * Set `prompt` to a number if a particular deployment disagrees. Set `default`
 * to `null` to opt out entirely and own liveness yourself.
 */
export interface AcpRequestTimeouts {
  /**
   * Every request other than `session/prompt` and `authenticate`. Defaults to
   * 30_000.
   */
  readonly default?: number | null;
  /** `session/prompt`. Defaults to `null` — see above. */
  readonly prompt?: number | null;
  /**
   * `authenticate`. Defaults to {@link DEFAULT_AUTHENTICATE_TIMEOUT_MS}.
   */
  readonly authenticate?: number | null;
}

/** See {@link AcpRequestTimeouts}. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Why a request has been outstanding with nothing to show for it.
 *
 * - `'awaiting-reply'` — the bytes were accepted by the transport and the agent
 *   has not answered. Consistent with an agent that is simply working. ACP has
 *   no heartbeat, so this is **not** evidence of anything being wrong. It is
 *   also, in practice, the only value a UI will ever see: see below.
 * - `'write-not-accepted'` — the request has not even been handed over: a write
 *   to the agent is still outstanding. On a child process that means the OS
 *   pipe buffer is full because the agent stopped reading its stdin.
 *
 * ## ⚠️ `'write-not-accepted'` is far rarer than it sounds
 *
 * An earlier version of this comment called it "on Windows the only evidence
 * there is". It is evidence when it appears, but it is gated on the **OS pipe
 * buffer**, not on the agent's health, and a request has to be enormous — or
 * the connection already very far gone — to reach it. Measured on Windows /
 * Node 24 against a live child that never reads its stdin:
 *
 * | written to a deaf child's stdin | write completed? |
 * |---|---|
 * | 200 B, ×3 and ×5 consecutively | yes, every one, in 0–1 ms |
 * | 65 536 B in one write | yes, in 0 ms |
 * | 73 728 B in one write | **no** — still pending after 2.5 s |
 * | 200 B × 327 (65 400 B total) | yes; the 328th stalled |
 * | 150 B × 436 (65 400 B total) | yes; the 437th stalled |
 *
 * The pipe holds ~64 KiB however it is filled, and a typical ACP request is
 * ~150 bytes. So a deaf agent absorbs several hundred requests before
 * {@link AcpRequestStatus.writePendingMs} becomes non-null even once — and a
 * turn issues one. Treat this value as "something is definitely wrong" when it
 * shows up, never as "the absence of it means things are fine".
 */
export type AcpStallReason = 'awaiting-reply' | 'write-not-accepted';

/** A request that has been outstanding long enough to be worth showing. */
export interface AcpRequestStatus {
  /** The ACP method, e.g. `'session/prompt'`. */
  readonly method: string;
  /** How long since the request was issued. */
  readonly elapsedMs: number;
  /**
   * How long since a byte last arrived from the agent, or since this request
   * started if none has arrived since. Never `null`, so a UI can render it
   * without a special case.
   */
  readonly silentMs: number;
  /**
   * How long the oldest unaccepted write to the agent has been outstanding, or
   * `null` when the transport has taken everything offered to it.
   *
   * **Almost always `null`, including when the agent is wedged.** It reports
   * the OS pipe buffer, which swallows ~64 KiB — hundreds of ACP requests —
   * before it stops accepting. See {@link AcpStallReason} for the measurements
   * and for what this may and may not be read as.
   */
  readonly writePendingMs: number | null;
  /** See {@link AcpStallReason}. */
  readonly reason: AcpStallReason;
  /** Whether `silentMs` has passed the connection's `stallAfterMs`. */
  readonly stalled: boolean;
}

/**
 * What {@link AcpAgentHandle.status} reports.
 *
 * Pull-based on purpose. A UI showing a running turn has to render elapsed time
 * anyway, which means it already has a ticker; giving it something to read on
 * each tick costs nothing and needs no subscription, no configuration, and no
 * timer of ours. {@link ConnectAcpAgentOptions.onStall} is the push counterpart
 * for callers that would rather be told.
 *
 * ## ⚠️ What this CANNOT tell you, and what to build instead
 *
 * **Nothing here separates "the agent is thinking" from "the agent is wedged".**
 * Earlier rounds of this file promised that it did — "a UI that renders those
 * cannot leave the user with a spinner that explains nothing". That sentence was
 * false and has been removed; a desktop turn UI must not be built on it.
 *
 * Measured on Windows / Node 24, through {@link connectAcpAgentProcess} against
 * two real children that both completed the handshake and were then sent one
 * `session/prompt` — one wedged (reads the request, never answers) and one
 * merely slow: **silent throughout**, then one reply at 6 s.
 *
 * **⚠️ This table was measured with a short, non-default `stallAfterMs`.** The
 * shipping default is {@link DEFAULT_STALL_AFTER_MS} — 30 s — so *none* of the
 * `stalled: true` cells below happen out of the box. Measured again at the
 * default, 1 / 3 / 5 / 8 / 12 s all report `stalled: false` and
 * {@link ConnectAcpAgentOptions.onStall} never fires at all. An earlier version
 * of this table omitted that, and it is a costly omission to read past: someone
 * deciding "the library says it goes stalled at 3 seconds, so I will warn the
 * user then" ships a UI that says nothing for thirty.
 *
 * | t | wedged | healthy-but-slow, non-streaming |
 * |---|---|---|
 * | 1 s | `silentMs` 1011, `writePendingMs` null, `awaiting-reply`, `stalled` false | `silentMs` 1011, `writePendingMs` null, `awaiting-reply`, `stalled` false |
 * | 3 s | `silentMs` 3021, `writePendingMs` null, `awaiting-reply`, `stalled` true | `silentMs` 3021, `writePendingMs` null, `awaiting-reply`, `stalled` true |
 * | 5 s | `silentMs` 5032, `writePendingMs` null, `awaiting-reply`, `stalled` true | `silentMs` 5030, `writePendingMs` null, `awaiting-reply`, `stalled` true |
 * | 8 s | unchanged, still outstanding | settled, `stopReason: end_turn` |
 *
 * Every field agrees to the millisecond until the healthy one answers, and with
 * a short `stallAfterMs` configured, `onStall` fires for both with the same
 * `reason`. `writePendingMs` does not rescue this — see {@link AcpStallReason}
 * for why it stays `null` through hundreds of requests.
 *
 * ### The second column is a **non-streaming** agent, and that is load-bearing
 *
 * An earlier version of this comment generalised the table into a claim that
 * nothing but the arriving reply ever tells the two apart. That is true of the
 * agent measured above — it emits nothing at all until it answers — and false
 * of a **streaming** agent, which is what all three shipping agents are.
 * (Paraphrased rather than quoted on purpose: the retired sentences are
 * asserted absent by `the measured tables in connect.ts cannot rot silently`,
 * and a verbatim quotation here would be indistinguishable from a relapse.)
 *
 * Once an agent starts streaming, `silentMs` separates the two continuously and
 * by a wide margin: a streaming turn holds it near the inter-chunk gap (~1 s)
 * while a wedged or deaf one climbs without bound (12 014 ms measured at the
 * same instant). So `silentMs` is not useless — it is the one field that *does*
 * discriminate, **once tokens are flowing**.
 *
 * The catch, and the reason none of this becomes "silence means dead": agy's
 * stream starts very late. docs/ACP-MIGRATION.md measured a healthy 8 062 ms
 * turn whose first token reached the client at **+6 684 ms** — 83 % of the turn
 * in total silence. For that whole prefix a healthy agy is byte-for-byte
 * indistinguishable from a wedged one, and it is longer than any threshold a UI
 * would want to warn at. A low `silentMs` is therefore evidence of life; a high
 * one is **not** evidence of death.
 *
 * This is a property of ACP, not a gap in this library: version 1.3.0 defines
 * 262 types and no ping, heartbeat, or keepalive of any kind, so a client has
 * no way to ask a busy agent whether it is still there.
 *
 * So the honest contract for a turn UI is:
 *
 * - **show elapsed time** (`AcpRequestStatus.elapsedMs`, and `silentMs` if the
 *   distinction helps the user);
 * - **offer a cancel affordance** ({@link AcpAgentHandle.cancel}), because the
 *   decision to stop waiting is the user's and there is no fact that could make
 *   it for them;
 * - **never treat silence as failure** — do not auto-cancel, do not show an
 *   error, do not mark the turn dead. `stalled` and `onStall` mean "quiet for a
 *   while", nothing more, and agy was measured spending 83% of a healthy 8 s
 *   turn silent.
 *
 * What *is* trustworthy here is {@link AcpConnectionStatus.alive} and
 * {@link AcpConnectionStatus.failure}: when those turn, the agent really is
 * gone and the reason is specific. Silence is not in that category.
 */
export interface AcpConnectionStatus {
  /** `false` once the connection has been declared dead. */
  readonly alive: boolean;
  /** Why it is dead, or `null` while it is alive. */
  readonly failure: Error | null;
  /**
   * How long since a byte last arrived from the agent, or `null` if none ever
   * has. `null` is meaningfully different from a large number: it distinguishes
   * an agent that has gone quiet from one that never said anything at all —
   * which is worth showing, because the second usually means the handshake
   * never completed.
   *
   * Read it as evidence of life, never as evidence of death. Against a
   * **streaming** agent — which all three shipping agents are — a low value
   * really does mean the agent is working, because a wedged one cannot produce
   * it. A high value means only "quiet": agy was measured silent for the first
   * 6 684 ms of a perfectly healthy 8 062 ms turn, which is indistinguishable
   * from wedged for as long as it lasts. Against a non-streaming agent it
   * carries nothing at all until the reply lands. See the table above.
   */
  readonly silentMs: number | null;
  /** Every request still waiting, oldest first. */
  readonly outstanding: readonly AcpRequestStatus[];
}

/** What {@link ConnectAcpAgentOptions.onStall} is handed. */
export interface AcpStallEvent extends AcpRequestStatus {
  /** How the agent is named in diagnostics. */
  readonly label: string;
}

/**
 * How long a request may go without a byte from the agent before
 * {@link ConnectAcpAgentOptions.onStall} fires, and before
 * {@link AcpRequestStatus.stalled} flips.
 *
 * Thirty seconds, and it is a **notification** threshold rather than a failure
 * one: nothing is cancelled and no request is rejected when it passes.
 * docs/ACP-MIGRATION.md measured agy spending 83% of an 8-second turn silent,
 * so a shorter window would cry wolf on every healthy turn, and a longer one
 * leaves the user staring at a spinner. Crossing it repeats every
 * `stallAfterMs` with a growing `silentMs`, so "quiet for 30s" becomes "quiet
 * for 3 minutes" without the caller keeping its own clock.
 */
export const DEFAULT_STALL_AFTER_MS = 30_000;

/**
 * What the transport has been seen doing, independent of any one request.
 *
 * Both halves feed it: {@link watchTransportEnd} stamps every inbound chunk,
 * {@link watchTransportWrites} opens and closes a record per outbound write.
 * Keeping it here rather than inside {@link RequestLiveness} is what lets a
 * *write* that never completes be told apart from an *answer* that never comes
 * — the distinction {@link AcpStallReason} is about.
 */
class TransportActivity {
  #lastInboundAt: number | null = null;
  readonly #openWrites = new Set<{ readonly at: number }>();

  /** Stamped for every chunk that arrives from the agent. */
  noteInbound(): void {
    this.#lastInboundAt = Date.now();
  }

  /** `null` until the agent has sent something. */
  get lastInboundAt(): number | null {
    return this.#lastInboundAt;
  }

  beginWrite(): { readonly at: number } {
    const record = { at: Date.now() };
    this.#openWrites.add(record);
    return record;
  }

  endWrite(record: { readonly at: number }): void {
    this.#openWrites.delete(record);
  }

  /** When the oldest write still waiting to be accepted was issued. */
  oldestOpenWriteAt(): number | null {
    let oldest: number | null = null;
    for (const record of this.#openWrites) {
      if (oldest === null || record.at < oldest) oldest = record.at;
    }
    return oldest;
  }
}

/** A request that has been sent and not yet settled. */
interface InFlightRequest {
  readonly method: string;
  readonly startedAt: number;
  readonly abandon: (reason: Error) => void;
  /** The stall re-check, armed only when a caller passed an `onStall`. */
  stallTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * How long `authenticate` waits. Ten minutes, not thirty seconds.
 *
 * `authenticate` is not a request the agent answers on its own: an ACP auth
 * method of type `terminal` runs the agent's binary for the user to log in
 * interactively, and `codex-acp` advertises a ChatGPT login that goes through a
 * browser. The reply comes back when a **person** has finished typing a
 * password and clicking through a consent screen. Under the 30 s default that
 * request is cut off long before the user has done anything wrong, and the
 * failure they see blames the agent.
 *
 * Not `null`, though, which is what `session/prompt` gets: a prompt turn has
 * {@link AcpAgentHandle.cancel} as its way out, and `authenticate` has none.
 * A budget is the only thing standing between an abandoned login and a spinner
 * with no end, so it is long rather than absent.
 */
export const DEFAULT_AUTHENTICATE_TIMEOUT_MS = 600_000;

interface ResolvedTimeouts {
  readonly default: number | null;
  readonly prompt: number | null;
  readonly authenticate: number | null;
}

function resolveTimeouts(timeouts?: AcpRequestTimeouts): ResolvedTimeouts {
  return {
    default: timeouts?.default === undefined
      ? DEFAULT_REQUEST_TIMEOUT_MS
      : timeouts.default,
    prompt: timeouts?.prompt === undefined ? null : timeouts.prompt,
    authenticate:
      timeouts?.authenticate === undefined
        ? DEFAULT_AUTHENTICATE_TIMEOUT_MS
        : timeouts.authenticate,
  };
}

/**
 * Fails a connection's requests when its transport dies, or when the agent
 * simply never answers.
 *
 * ## What each library does on its own, measured
 *
 * `@zed-industries/agent-client-protocol@0.4.5` settled a request **only** on a
 * matching JSON-RPC response. A pending request survived both a closed and an
 * errored input stream, because its ndJSON reader stopped at EOF and told
 * nobody. An awaited call hung forever; and since a pending promise pins
 * neither a timer nor a handle, the host's event loop then drained and the
 * process exited 0 with the turn unresolved and nothing printed.
 *
 * `@agentclientprotocol/sdk@1.3.0` fixed that upstream: when the stream ends it
 * fails everything in flight with `new Error("ACP connection closed")`. Good —
 * and it creates the opposite problem. That message arrives *first*, about 2 ms
 * before the child's `exit`, and it says nothing. Letting it through would
 * replace "agy exited with code 17" and the agent's own stderr with five
 * anonymous words, which is most of the diagnostic value this package exists to
 * add. So a rejection that lands while a better reason is known to be coming
 * **waits for it** — see {@link RequestLiveness.expectReason}.
 *
 * Four things reach {@link RequestLiveness.fail} or the per-request timer, and
 * all four are wired: {@link watchTransportEnd} interposes on the input stream
 * so *any* transport fails when its bytes stop, {@link watchTransportWrites}
 * does the same for the output stream so a broken stdin cannot hide behind a
 * healthy stdout, {@link AcpAgentHandle.fail} lets a transport owner supply a
 * better reason out of band — a child's exit code, an SSH channel's close
 * status — and the timeout covers an agent that is alive and simply mute.
 *
 * A fifth thing settles nothing and is not meant to: this class also *reports*.
 * `session/prompt` has no timeout by default, and two failure shapes produce no
 * death-shaped signal at all on Windows, so for those there is nothing to reach
 * `fail` with and no budget to expire. What is left is describing the wait
 * honestly — {@link RequestLiveness.status} and the `onStall` timer — and that
 * is deliberately kept separate from the four above, because a report that
 * quietly became a rejection would abort turns that were merely slow.
 */
class RequestLiveness {
  #failure: Error | null = null;
  /** A transport end was reported and its real reason is still on its way. */
  #reasonPending = false;
  readonly #inFlight = new Set<InFlightRequest>();
  readonly #waiting = new Set<() => void>();
  readonly #reasonGraceMs: number;
  readonly #activity: TransportActivity;
  readonly #stallAfterMs: number;
  readonly #onStall: ((event: AcpStallEvent) => void) | undefined;
  readonly #label: string;

  constructor(options: {
    reasonGraceMs: number;
    activity: TransportActivity;
    stallAfterMs: number;
    onStall: ((event: AcpStallEvent) => void) | undefined;
    label: string;
  }) {
    this.#reasonGraceMs = options.reasonGraceMs;
    this.#activity = options.activity;
    this.#stallAfterMs = options.stallAfterMs;
    this.#onStall = options.onStall;
    this.#label = options.label;
  }

  /**
   * What a UI can show right now, computed on demand.
   *
   * No timer backs this, which is the point: it is available on the default
   * configuration, with no options set and no callback registered, and it is
   * the answer to "`prompt` has no timeout, so what does the user see?".
   */
  status(): AcpConnectionStatus {
    const now = Date.now();
    const lastInbound = this.#activity.lastInboundAt;
    return {
      alive: this.#failure === null,
      failure: this.#failure,
      silentMs: lastInbound === null ? null : now - lastInbound,
      outstanding: [...this.#inFlight]
        .map((request) => this.#statusOf(request, now))
        .sort((a, b) => b.elapsedMs - a.elapsedMs),
    };
  }

  /** One request's status. `now` is passed in so a snapshot is consistent. */
  #statusOf(request: InFlightRequest, now: number): AcpRequestStatus {
    const lastInbound = this.#activity.lastInboundAt;
    // Silence is measured from this request's own start when nothing has
    // arrived since it was sent. Otherwise a connection that had been quiet for
    // an hour would report a brand-new request as instantly stalled.
    const quietSince = Math.max(request.startedAt, lastInbound ?? 0);
    const oldestWriteAt = this.#activity.oldestOpenWriteAt();
    const writePendingMs =
      oldestWriteAt === null ? null : now - oldestWriteAt;
    return {
      method: request.method,
      elapsedMs: now - request.startedAt,
      silentMs: now - quietSince,
      writePendingMs,
      // An unaccepted write outranks a missing reply: the request never
      // reached the agent, so "it has not answered" would be misleading.
      reason:
        writePendingMs !== null && writePendingMs >= this.#stallAfterMs
          ? 'write-not-accepted'
          : 'awaiting-reply',
      stalled: now - quietSince >= this.#stallAfterMs,
    };
  }

  /**
   * Arms the repeating stall check for one request.
   *
   * A no-op without an `onStall`, so the default configuration adds no timer —
   * which matters beyond cost: a live timer holds the host's event loop open,
   * and an unbounded `session/prompt` would then keep a process alive purely to
   * report on itself.
   */
  #armStall(request: InFlightRequest): void {
    const onStall = this.#onStall;
    if (onStall === undefined) return;
    const tick = (): void => {
      request.stallTimer = null;
      if (!this.#inFlight.has(request)) return;
      const status = this.#statusOf(request, Date.now());
      if (status.stalled) {
        onStall({ ...status, label: this.#label });
        request.stallTimer = setTimeout(tick, this.#stallAfterMs);
        return;
      }
      // A byte arrived while we waited. Re-arm for what is left of the window
      // rather than for a fresh one, so the report is never later than asked
      // for. `silentMs < stallAfterMs` here by definition, so this is > 0.
      request.stallTimer = setTimeout(
        tick,
        this.#stallAfterMs - status.silentMs,
      );
    };
    request.stallTimer = setTimeout(tick, this.#stallAfterMs);
  }

  /**
   * Announces that the transport has ended and a specific reason is coming.
   *
   * Until it arrives (or {@link RequestLiveness.reasonGraceMs} elapses), a
   * rejection raised by the protocol library is held back rather than
   * delivered, because the reason on its way knows the exit code.
   */
  expectReason(): void {
    if (this.#failure === null) this.#reasonPending = true;
  }

  /** The most specific reason available for `fallback`'s rejection. */
  async #bestReason(fallback: Error): Promise<Error> {
    if (this.#failure !== null) return this.#failure;
    if (!this.#reasonPending) return fallback;
    await new Promise<void>((resolve) => {
      let done = false;
      const wake = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.#waiting.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, this.#reasonGraceMs);
      this.#waiting.add(wake);
    });
    return this.#failure ?? fallback;
  }

  /**
   * Runs `send`, rejecting early if the transport dies before it answers, or if
   * `timeoutMs` elapses first.
   */
  guard<T>(
    method: string,
    timeoutMs: number | null,
    send: () => Promise<T>,
  ): Promise<T> {
    const failure = this.#failure;
    if (failure !== null) return Promise.reject(failure);

    const inFlight = this.#inFlight;
    return new Promise<T>((resolve, reject) => {
      const request: InFlightRequest = {
        method,
        startedAt: Date.now(),
        abandon: (reason: Error): void => {
          reject(reason);
        },
        stallTimer: null,
      };
      inFlight.add(request);
      this.#armStall(request);

      // A live timer also keeps the host's event loop alive, which is the
      // second half of the bug: without one, an unanswered request let the
      // process exit 0 with nothing printed.
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              inFlight.delete(request);
              if (request.stallTimer !== null) clearTimeout(request.stallTimer);
              reject(new AcpRequestTimeoutError(method, timeoutMs));
            }, timeoutMs);

      const forget = (): void => {
        inFlight.delete(request);
        if (request.stallTimer !== null) clearTimeout(request.stallTimer);
        if (timer !== null) clearTimeout(timer);
      };
      send().then(
        (value) => {
          forget();
          resolve(value);
        },
        (error: unknown) => {
          forget();
          void this.#bestReason(asError(error)).then(reject, reject);
        },
      );
    });
  }

  /**
   * Declares the transport dead.
   *
   * Everything in flight rejects with `reason`, and so does everything sent
   * afterwards: a dead agent will not answer the next request either, and
   * hanging again would lose the one diagnostic that explains all of it. Only
   * the first failure is kept, for the same reason.
   */
  fail(reason: Error): void {
    if (this.#failure !== null) return;
    this.#failure = reason;
    this.#reasonPending = false;
    const abandoned = [...this.#inFlight];
    this.#inFlight.clear();
    for (const request of abandoned) {
      if (request.stallTimer !== null) clearTimeout(request.stallTimer);
      request.abandon(reason);
    }
    const waiting = [...this.#waiting];
    this.#waiting.clear();
    for (const wake of waiting) wake();
  }
}

/**
 * A connected agent.
 *
 * The methods are ACP's agent-side methods, in ACP's own names. `connection`
 * is the underlying object, exposed for the corners of the protocol (`nes/*`,
 * `providers/*`, `mcp/*`, extension methods) that no CozyPad screen reaches
 * yet.
 *
 * ⚠️ **Calls made straight on `connection` bypass both the liveness described
 * on {@link AcpAgentHandle.fail} and the timeouts**, so they hang forever if
 * the agent dies or goes quiet. That is the reason every method a UI control
 * is wired to gets a wrapper here, however thin — an unwrapped call behind a
 * button is a button that can hang, and `session/set_config_option` (the model
 * picker on both shipping agents) was one.
 */
export interface AcpAgentHandle {
  readonly connection: ClientSideConnection;
  /**
   * Declares the connection dead: every in-flight request rejects with
   * `reason`, and every later call rejects with it too. Only the first caller
   * wins, so the reason that arrives first is the one the user sees.
   *
   * This is **not** the only safety net, and a transport that forgets to call
   * it no longer hangs: {@link connectAcpAgent} fails the connection by itself
   * as soon as the input stream closes or errors, a write to the output stream
   * fails, or the output stream errors with nothing in flight — provided that
   * last one really does error, which is a condition on the sink and not a
   * property of every `WritableStream`.
   *
   * A timeout is the net under a sink that dies *silently* — but not under
   * every request: `session/prompt` ships with no budget at all (see
   * {@link AcpRequestTimeouts}), so on that one call a silent sink is covered
   * by {@link AcpAgentHandle.status} and nothing else. An earlier version of
   * this paragraph said "every request carries a timeout besides", which was
   * never true of the one request users spend their time in.
   *
   * `fail` is for the deaths a byte stream cannot describe — a child's exit
   * code and stderr,
   * an SSH channel's close reason — and for a far end that dies without the
   * courtesy of closing the stream at all. Call it and the vaguer stream-level
   * reason loses the race, which is the intent.
   */
  fail(reason: Error): void;
  /**
   * A snapshot of everything still waiting, and how long the agent has been
   * quiet. Cheap, synchronous, and available with no configuration.
   *
   * **This is what pairs with `session/prompt`'s unbounded budget** — as a way
   * to render the wait, not to explain it. A turn is allowed to take as long as
   * it takes (see {@link AcpRequestTimeouts}), so nothing will ever reject on
   * the user's behalf; and neither this snapshot nor anything else in ACP can
   * tell a long turn from a wedged agent, because the protocol has no
   * heartbeat. What it hands over is elapsed time, silence, and whether the
   * bytes were accepted — enough to show the user what is happening and let
   * them {@link AcpAgentHandle.cancel}, which is the only place that decision
   * can honestly sit.
   *
   * ⚠️ Read {@link AcpConnectionStatus} before building a turn UI on this. It
   * carries the measured table showing a wedged agent and a healthy slow one
   * producing identical values, and the three rules that follow from it.
   */
  status(): AcpConnectionStatus;
  initialize(options?: AcpInitializeOptions): Promise<InitializeResponse>;
  /**
   * `authenticate`, with its own much longer budget — see
   * {@link DEFAULT_AUTHENTICATE_TIMEOUT_MS}.
   *
   * The method to call is one of the `authMethods` the agent listed in its
   * `InitializeResponse`, and it lists none unless the client advertised it
   * can carry them out. That advertisement is
   * {@link AcpClientHandlers.auth}; without it this method has nothing to be
   * called with.
   */
  authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse>;
  /** `logout`. Drops the credentials `authenticate` established. */
  logout(params: LogoutRequest): Promise<LogoutResponse>;
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
  /**
   * `session/list`. Absent from `@zed-industries/agent-client-protocol@0.4.5`
   * entirely; the Sessions screen in docs/ACP-MIGRATION.md needs it.
   */
  listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse>;
  /**
   * `session/resume` — continue a session **without** replaying its history,
   * unlike `session/load`. Only available if the agent advertises
   * `sessionCapabilities.resume`.
   */
  resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse>;
  /**
   * `session/fork` — branch a session so the original history is left alone.
   * Only available if the agent advertises `sessionCapabilities.fork`.
   *
   * Marked `unstable_` on the SDK's own connection object; the name is stable
   * here because the wire method (`session/fork`) is what a caller reasons
   * about.
   */
  forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse>;
  /**
   * `session/close` — cancel any ongoing work and release the session's
   * resources. Only available if the agent advertises
   * `sessionCapabilities.close`.
   */
  closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse>;
  /**
   * `session/delete` — remove a session returned by `session/list`. Only
   * available if the agent advertises `sessionCapabilities.delete`.
   */
  deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse>;
  setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse>;
  /**
   * `session/set_config_option` — **how both shipping agents select a model**,
   * plus codex's `reasoning_effort`.
   *
   * The response carries the full set of options again rather than just the
   * one that changed, because setting one can alter the values available on
   * another; render what comes back instead of patching what was sent.
   */
  setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse>;
  prompt(params: PromptRequest): Promise<PromptResponse>;
  cancel(params: CancelNotification): Promise<void>;
}

/** The sentence every disconnect diagnostic ends with. */
const CONNECTION_DEAD =
  'The ACP connection is dead and this request cannot be answered.';

/** How an unnamed agent is referred to in diagnostics. */
const DEFAULT_LABEL = 'ACP agent';

/** Whatever a stream rejected with, as an `Error`. */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Passes `source` through unchanged while reporting the moment it ends.
 *
 * This is the piece that makes a stream-only transport able to die. Interposing
 * a reader is the only way to observe it: `ndJsonStream` takes the input's sole
 * reader for itself, and a `ReadableStream` has no "closed" event to subscribe
 * to from outside.
 *
 * `onEnd` fires at most once — with the stream's error, or `null` for a clean
 * EOF. Every chunk is forwarded before that, so watching costs no bytes.
 *
 * `onBytes` fires for every chunk, and is the only place the connection learns
 * that the agent is still alive. ACP has no heartbeat and no idle frame, so
 * "bytes arrived" is the entire liveness signal available — which is why it is
 * reported as *activity* rather than treated as *health*. See
 * {@link AcpStallReason}.
 */
function watchTransportEnd(
  source: ReadableStream<Uint8Array>,
  onEnd: (cause: Error | null) => void,
  onBytes: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let reported = false;
  const report = (cause: Error | null): void => {
    if (reported) return;
    reported = true;
    onEnd(cause);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        report(asError(error));
        // Rethrown, so the consumer still sees the failure the source raised
        // rather than a stream that merely went quiet.
        throw error;
      }
      if (chunk.done) {
        controller.close();
        report(null);
        return;
      }
      onBytes();
      controller.enqueue(chunk.value);
    },
    cancel(reason: unknown) {
      // Our own side giving up. No further message can arrive either way, so
      // it counts as an end; leaving it unreported would hang anything still
      // waiting for a reply.
      report(null);
      return reader.cancel(reason);
    },
  });
}

/**
 * Passes writes through unchanged while reporting the first one that fails.
 *
 * The output half needs watching for the same reason the input half does, and
 * it is the half that was missing. A request is written and *then* awaited, so
 * a stdin that breaks takes the answer with it while stdout stays open and
 * innocent — no EOF, no exit, nothing to notice.
 *
 * An earlier round of this comment illustrated that with "a write-side EPIPE
 * with a healthy stdout hung for 6007 ms". **That measurement did not
 * reproduce**: on Windows / Node 24, a child that stops reading its stdin
 * produces no `EPIPE` and no error of any kind. The write is simply buffered,
 * and how much is buffered before anyone notices is set by the **OS pipe
 * buffer** — not, as the round after that claimed, by which write it is.
 * Measured against a live child that never reads its stdin: three and then five
 * consecutive 200-byte writes **all** called back, in 0–1 ms, leaving
 * `writableLength` at 0; a single 65 536-byte write also called back in 0 ms; a
 * single 73 728-byte write never did. Filling the pipe in small pieces gives the
 * same number — the 328th 200-byte write and the 437th 150-byte write both
 * stalled, each at 65 400 bytes written. Only past ~64 KiB does anything hang:
 * a 2 MB write never called back, `writableLength` sat at 2 097 152, and
 * `errored`, `destroyed` and `close` stayed `null`/`false`/unfired for the full
 * 8 s. (The previous "the first called back in 2 ms, the next two never did"
 * has now been contradicted by every re-run; so has the `writableLength` of
 * 2 097 552, which was that claim's own 400 stray bytes added on.)
 *
 * The shape this function catches is a stdin that *dies* (a destroyed pipe, a
 * socket the far end reset); a stdin that merely stops being read is invisible
 * here for the first ~64 KiB, which on ~150-byte requests is the whole of any
 * realistic session. See {@link AcpStallReason}.
 *
 * `writer.closed` is watched as well, and it is the **only** thing that covers
 * a sink dying with no write in flight. What that is worth depends on the
 * transport, and the earlier claim that it covers "the SSH-channel shape" was
 * measured and found to be the wrong way round:
 *
 * - On a **duplex** transport — one `net.Socket` carrying both directions —
 *   the same death also ends the read half, and {@link watchTransportEnd}
 *   fails the request from there. Measured over a real loopback socket across
 *   four death shapes: 74–108 ms end to end, with this net removed entirely.
 * - On a **split** transport — a channel demultiplexed into a readable and a
 *   writable that die independently — the read half stays open and this is the
 *   only signal there is. Measured with it disabled: the request never settled
 *   at all.
 *
 * So this covers split transports, and an SSH channel only insofar as it is
 * split. That places **two** requirements on the caller rather than on this
 * function, and the second one is the newer discovery:
 *
 * 1. A sink that notices its own death and merely records it, without erroring
 *    its controller, leaves `closed` pending forever and this net dead.
 *    `writableToNodeStream` errors its controller for exactly that reason; a
 *    sink written elsewhere must do the same.
 * 2. A sink built over a **duplex** must move that duplex's read side, or the
 *    death this net is waiting for is never emitted in the first place — one
 *    unread inbound byte suppresses every terminal event on the object, FIN
 *    and reset alike. That is the SSH-channel shape specifically, and the
 *    reason the split case existed at all. `writableToNodeStream` does it by
 *    default, and captures the bytes rather than discarding them so the same
 *    duplex can still be the `input`; see
 *    `WritableToNodeStreamOptions.drainReadSide` in ./nodeStreams for the
 *    measured table.
 */
function watchTransportWrites(
  sink: WritableStream<Uint8Array>,
  onError: (error: Error) => void,
  activity: TransportActivity,
): WritableStream<Uint8Array> {
  const writer = sink.getWriter();
  let reported = false;
  const report = (error: Error): void => {
    if (reported) return;
    reported = true;
    onError(error);
  };
  // Rejects the moment the sink errors, write in flight or not. The `catch` is
  // mandatory: an unobserved rejection here would surface as a process-level
  // unhandled rejection instead of a diagnostic.
  writer.closed.catch((error: unknown) => {
    report(asError(error));
  });

  return new WritableStream<Uint8Array>({
    async write(chunk) {
      // Opened before the write and closed in a `finally`, so a write that
      // never settles — the measured shape of an agent that stopped reading
      // its stdin — stays visible for as long as it is stuck. This is the only
      // observable that shape produces on Windows.
      const record = activity.beginWrite();
      try {
        await writer.write(chunk);
      } catch (error) {
        report(asError(error));
        throw error;
      } finally {
        activity.endWrite(record);
      }
    },
    async close() {
      try {
        await writer.close();
      } catch (error) {
        // Closing a sink that already failed is not news; the failure was
        // reported when it happened. Swallowed so an orderly shutdown does not
        // raise a second, later error on top of the real one.
        report(asError(error));
      }
    },
    async abort(reason: unknown) {
      await writer.abort(reason);
    },
  });
}

/** The default reason a connection is declared dead by its own stream. */
function describeTransportEnd(label: string, cause: Error | null): Error {
  const what =
    cause === null
      ? `${label} closed the connection`
      : `${label} connection failed: ${cause.message}`;
  return new AcpAgentDisconnectedError(`${what}. ${CONNECTION_DEAD}`);
}

/** The default reason a connection is declared dead by its output stream. */
function describeWriteFailure(label: string, cause: Error): Error {
  return new AcpAgentDisconnectedError(
    `cannot write to ${label}: ${cause.message}. ${CONNECTION_DEAD}`,
  );
}

export interface ConnectAcpAgentOptions {
  handlers: AcpClientHandlers;
  /** Bytes coming *from* the agent — its stdout. */
  input: ReadableStream<Uint8Array>;
  /** Bytes going *to* the agent — its stdin. */
  output: WritableStream<Uint8Array>;
  /**
   * How the agent is named in diagnostics — `'agy'`, `'claude-agent-acp'`.
   * Defaults to `'ACP agent'`.
   */
  label?: string;
  /** Per-request budgets. See {@link AcpRequestTimeouts} for the defaults. */
  timeouts?: AcpRequestTimeouts;
  /**
   * Silence threshold for {@link ConnectAcpAgentOptions.onStall} and for
   * {@link AcpRequestStatus.stalled}. Defaults to
   * {@link DEFAULT_STALL_AFTER_MS}. Not a timeout: nothing fails when it
   * passes.
   */
  stallAfterMs?: number;
  /**
   * Called when a request crosses `stallAfterMs` without a byte from the agent,
   * and every `stallAfterMs` after that until it settles.
   *
   * The push counterpart of {@link AcpAgentHandle.status}, for a caller that
   * has no ticker of its own. Registering it arms a timer per in-flight
   * request; leaving it off costs nothing and loses nothing, because `status`
   * reports the same facts on demand.
   *
   * It is a **report, not a verdict**. Nothing is cancelled and no request is
   * rejected; an agent that has been quiet for a minute may well be working.
   * Measured: it fires with the same `reason` and the same numbers for a wedged
   * agent and for a healthy **non-streaming** one taking 6 s, so a handler that
   * treats it as a failure will abort working turns. (Against a streaming agent
   * it does not fire at all while tokens flow — the bytes reset the window.)
   * See {@link AcpConnectionStatus}.
   */
  onStall?: (event: AcpStallEvent) => void;
  /**
   * How long a rejection waits for the reason `onTransportEnd` deferred.
   *
   * Only relevant when `onTransportEnd` returns `null`. The protocol library
   * fails in-flight requests the instant the stream ends, with a generic "ACP
   * connection closed"; the specific reason — an exit code, a signal, the
   * agent's stderr — lands a beat later. This is how long the generic one is
   * held back so the specific one can overtake it. Defaults to
   * {@link DEFAULT_EXIT_GRACE_MS}; if nothing arrives in time the generic
   * rejection is delivered rather than held any longer.
   */
  transportEndGraceMs?: number;
  /**
   * Called once when `input` reaches its terminal state: closed cleanly
   * (`cause` is `null`) or errored (`cause` is what it errored with).
   *
   * Return the error to fail the connection with. Returning `null` **defers**
   * the failure and makes you responsible for calling
   * {@link AcpAgentHandle.fail}; nothing else will, and anything in flight
   * waits until you do (or until its timeout fires).
   * {@link connectAcpAgentProcess} defers on purpose, because a child's exit
   * code lands a beat after its stdout closes and says far more than the
   * stream can.
   */
  onTransportEnd?: (cause: Error | null) => Error | null;
  /**
   * Called once when `output` fails: a write was rejected, or the sink became
   * errored with nothing in flight.
   *
   * Same contract as {@link ConnectAcpAgentOptions.onTransportEnd} — return the
   * error to fail the connection with, or `null` to **defer** and take
   * responsibility for calling {@link AcpAgentHandle.fail} yourself.
   *
   * This exists because there are now two things that can notice a broken
   * output stream and only one of them knows anything: the stream says "the
   * stream closed before it was ended", while a process transport can say which
   * agent it was, whether it had already exited, and what it printed on the way
   * out. Without a hook the stream-level reporter wins the race and the better
   * account is lost — measured, once the sink began erroring itself.
   */
  onTransportWriteError?: (cause: Error) => Error | null;
}

/**
 * Connects to an ACP agent over a pair of byte streams.
 *
 * Reading starts immediately, so handlers must be ready before this returns.
 * Nothing is sent until the first call on the handle; `initialize` is the
 * caller's to make.
 *
 * The connection fails itself when `input` closes or errors, when a write to
 * `output` fails, and when `output` becomes errored with nothing in flight.
 * That third case is what a **split** transport lives on — one whose readable
 * and writable halves die independently. A duplex transport is already covered
 * by the first case and does not need it (measured: 74–108 ms with the third
 * case removed); a split one has nothing else at all (measured: never settled).
 *
 * ⚠️ **That third case is a contract with the caller, not a guarantee.** It is
 * detected through `writer.closed`, so it works only for an `output` that
 * errors its own `WritableStream` when its underlying sink dies, *and* only if
 * the sink's underlying object is in a state where Node will report the death
 * at all — a duplex with unread bytes on its read side reports nothing, ever.
 * {@link writableToNodeStream} handles both: it errors its controller, and it
 * moves the read side. A sink that swallows the death, merely remembers it, or
 * leaves a duplex's read side stalled, leaves a request pending until its
 * timeout — and `session/prompt` has none.
 * {@link AcpAgentHandle.fail} remains for reasons the streams cannot express,
 * and beats the stream-level one to it when both fire.
 *
 * ## Handing the same duplex in as both halves
 *
 * Supported, in either order and with any delay between building the two:
 * `input: readableFromNodeStream(socket), output: writableToNodeStream(socket)`
 * is a `net.Socket` or SSH channel used as one transport. The write half has to
 * move that socket's read side for the death detection above to work at all,
 * which used to mean it *discarded* whatever was already on the wire whenever
 * the input wrapper was built a tick or more later — a dropped JSON-RPC frame,
 * and with `session/prompt` unbounded, a spinner with no end. It now captures
 * and hands over instead; see `WritableToNodeStreamOptions.drainReadSide` in
 * ./nodeStreams for the measured four-way table.
 *
 * ⚠️ **Some deaths cannot be detected on this platform at all.** A live child
 * that closes its stdout, and a live child that stops reading its stdin, are
 * both invisible on Windows — measured, see {@link connectAcpAgentProcess}.
 * Those are not failures this function can report; they are waits it can
 * *describe*, through {@link AcpAgentHandle.status} and
 * {@link ConnectAcpAgentOptions.onStall}.
 */
export function connectAcpAgent(
  options: ConnectAcpAgentOptions,
): AcpAgentHandle {
  const { handlers, input, output } = options;
  const label = options.label ?? DEFAULT_LABEL;
  const onTransportEnd = options.onTransportEnd;
  const onTransportWriteError = options.onTransportWriteError;
  const timeouts = resolveTimeouts(options.timeouts);
  const activity = new TransportActivity();
  const liveness = new RequestLiveness({
    reasonGraceMs: options.transportEndGraceMs ?? DEFAULT_EXIT_GRACE_MS,
    activity,
    stallAfterMs: options.stallAfterMs ?? DEFAULT_STALL_AFTER_MS,
    onStall: options.onStall,
    label,
  });

  const watchedInput = watchTransportEnd(
    input,
    (cause) => {
      const reason =
        onTransportEnd === undefined
          ? describeTransportEnd(label, cause)
          : onTransportEnd(cause);
      if (reason === null) {
        // Deferred. Anything the library rejects in the meantime holds until
        // the real reason lands, so the exit code is not lost to a race of
        // ~2 ms.
        liveness.expectReason();
        return;
      }
      liveness.fail(reason);
    },
    () => {
      activity.noteInbound();
    },
  );

  const watchedOutput = watchTransportWrites(
    output,
    (cause) => {
      const reason =
        onTransportWriteError === undefined
          ? describeWriteFailure(label, cause)
          : onTransportWriteError(cause);
      if (reason === null) {
        liveness.expectReason();
        return;
      }
      liveness.fail(reason);
    },
    activity,
  );

  const connection = new ClientSideConnection(
    () => createAcpClient(handlers),
    ndJsonStream(watchedOutput, watchedInput),
  );

  const guard = <T>(
    method: string,
    timeoutMs: number | null,
    send: () => Promise<T>,
  ): Promise<T> => liveness.guard(method, timeoutMs, send);

  return {
    connection,
    fail: (reason) => {
      liveness.fail(reason);
    },
    status: () => liveness.status(),
    initialize: (initOptions) =>
      guard('initialize', timeouts.default, () =>
        connection.initialize({
          protocolVersion: initOptions?.protocolVersion ?? PROTOCOL_VERSION,
          clientCapabilities:
            initOptions?.clientCapabilities ??
            deriveClientCapabilities(handlers),
          ...(initOptions?._meta === undefined
            ? {}
            : { _meta: initOptions._meta }),
        }),
      ),
    authenticate: (params) =>
      guard('authenticate', timeouts.authenticate, () =>
        connection.authenticate(params),
      ),
    logout: (params) =>
      guard('logout', timeouts.default, () => connection.logout(params)),
    newSession: (params) =>
      guard('session/new', timeouts.default, () =>
        connection.newSession(params),
      ),
    loadSession: (params) =>
      guard('session/load', timeouts.default, () =>
        connection.loadSession(params),
      ),
    listSessions: (params) =>
      guard('session/list', timeouts.default, () =>
        connection.listSessions(params),
      ),
    resumeSession: (params) =>
      guard('session/resume', timeouts.default, () =>
        connection.resumeSession(params),
      ),
    forkSession: (params) =>
      guard('session/fork', timeouts.default, () =>
        connection.unstable_forkSession(params),
      ),
    closeSession: (params) =>
      guard('session/close', timeouts.default, () =>
        connection.closeSession(params),
      ),
    deleteSession: (params) =>
      guard('session/delete', timeouts.default, () =>
        connection.deleteSession(params),
      ),
    setSessionMode: (params) =>
      guard('session/set_mode', timeouts.default, () =>
        connection.setSessionMode(params),
      ),
    setSessionConfigOption: (params) =>
      guard('session/set_config_option', timeouts.default, () =>
        connection.setSessionConfigOption(params),
      ),
    prompt: (params) =>
      guard('session/prompt', timeouts.prompt, () => connection.prompt(params)),
    // Guarded like the rest. `cancel` is a notification, so it would otherwise
    // "succeed" by writing into a pipe nobody is reading — reporting a cleanup
    // that never happened is the same silent lie in a smaller costume.
    cancel: (params) =>
      guard('session/cancel', timeouts.default, () => connection.cancel(params)),
  };
}

/** How many characters of the agent's stderr are kept for a diagnostic. */
const STDERR_TAIL_LIMIT = 2000;

/**
 * What was learned by listening to a stream that may already have finished.
 *
 * `missed` is the honest half. Measured on Windows / Node 24: a child that
 * exits 25 ms before anyone subscribes has already emitted and discarded its
 * stderr — `readableEnded` is `true` and no `data` event will ever fire. The
 * tail is then empty not because the agent said nothing but because nobody was
 * listening, and a diagnostic that reports those two the same way sends the
 * reader hunting for a silent crash that never happened.
 */
interface StderrCapture {
  tail(): string;
  missed(): boolean;
}

/**
 * Drains a stream, keeping its last {@link STDERR_TAIL_LIMIT} characters.
 *
 * Draining is not optional even when nobody reads the result: an unread pipe
 * fills its OS buffer and then blocks the agent mid-write, which looks exactly
 * like a hang.
 */
function captureTail(stream: NodeReadableLike): StderrCapture {
  const decoder = new TextDecoder();
  let tail = '';
  let sawData = false;
  // Read before subscribing, for the reason on {@link StderrCapture}.
  const alreadyOver = readableWasOver(stream);
  stream.on('data', (chunk) => {
    sawData = true;
    tail +=
      typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk, { stream: true });
    if (tail.length > STDERR_TAIL_LIMIT) {
      tail = tail.slice(tail.length - STDERR_TAIL_LIMIT);
    }
  });
  return {
    tail: () => tail,
    missed: () => alreadyOver && !sawData,
  };
}

/** Whether a readable had already finished before we looked at it. */
function readableWasOver(stream: NodeReadableLike): boolean {
  return (
    stream.readableEnded === true ||
    stream.destroyed === true ||
    stream.closed === true ||
    (stream.errored !== null && stream.errored !== undefined)
  );
}

/** "agy exited with code 1" / "agy was killed by SIGTERM" / "agy exited". */
function describeExit(
  label: string,
  code: number | null,
  signal: string | null,
): string {
  if (signal !== null) return `${label} was killed by ${signal}`;
  if (code !== null) return `${label} exited with code ${String(code)}`;
  return `${label} exited`;
}

/** Quotes the agent's last words, or says plainly why there are none. */
function quoteStderr(label: string, capture: StderrCapture): string {
  const trimmed = capture.tail().trim();
  if (trimmed !== '') return `\n--- ${label} stderr (tail) ---\n${trimmed}`;
  if (capture.missed()) {
    return (
      ` ${label} had already finished before this connection was made, so its` +
      ' stderr could not be captured; connect immediately after spawning to' +
      ' keep it.'
    );
  }
  return ` ${label} wrote nothing to stderr.`;
}

/**
 * How long a dead stdout waits for the child's `exit` before the connection is
 * failed on the stream's word alone.
 *
 * Measured on Windows / Node 24, 60 spawns of a child that exits: stdout `end`
 * arrived **first every single time**, with `child.exitCode` still `null`, and
 * `exit` followed 1.5–2.2 ms later (max 2.188 ms). So failing the moment stdout
 * ends would *always* throw away the exit code and the agent's stderr. The
 * default below is ~900× the largest observed gap.
 *
 * Getting this wrong cannot bring the hang back: the request fails either way,
 * and the only cost is a less specific reason.
 */
const DEFAULT_EXIT_GRACE_MS = 2000;

export interface ConnectAcpAgentProcessOptions {
  handlers: AcpClientHandlers;
  /** A spawned agent process. Must have been given piped stdin and stdout. */
  child: NodeChildProcessLike;
  /**
   * How the process is named in diagnostics — `'agy'`, `'claude-agent-acp'`.
   * Defaults to `'ACP agent'`.
   */
  label?: string;
  /** Per-request budgets. See {@link AcpRequestTimeouts}. */
  timeouts?: AcpRequestTimeouts;
  /** See {@link ConnectAcpAgentOptions.stallAfterMs}. */
  stallAfterMs?: number;
  /**
   * See {@link ConnectAcpAgentOptions.onStall}.
   *
   * Worth wiring for a child process specifically, because two of the shapes a
   * child can fail in produce **no other signal at all on Windows** — see the
   * measured list on {@link connectAcpAgentProcess}.
   */
  onStall?: (event: AcpStallEvent) => void;
  /**
   * Grace period between stdout ending and the connection being failed without
   * an exit status. Defaults to {@link DEFAULT_EXIT_GRACE_MS}; see there for
   * the measurement behind the number. Lower it to fail faster at the cost of
   * a vaguer diagnostic.
   */
  exitGraceMs?: number;
}

/**
 * Connects to an ACP agent running as a child process.
 *
 * The process must be spawned with `stdio: ['pipe', 'pipe', ...]`. On Windows,
 * spawn it *without* `shell: true`: the shell concatenates argv into a single
 * unescaped string, which silently mangles any argument containing spaces.
 *
 * Five different things can mean "the agent is gone", and all five are wired:
 *
 * - **already exited** — the case that used to hang hardest. A child that died
 *   before this call emits *nothing*: no `exit`, no `end`, no `close`
 *   (measured — a 25 ms delay between spawn and connect was already enough).
 *   An agy that is not logged in prints to stderr and exits 17 within
 *   milliseconds, so this is the single most likely real-world failure, and it
 *   is read from `exitCode`/`signalCode` rather than waited for.
 * - **`exit`** — the richest, carrying the code or signal plus the tail of
 *   stderr, so the caller reads "agy exited with code 17" and the agent's own
 *   last words rather than a generic failure.
 * - **`error`** — a spawn that never happened emits *only* this; there is no
 *   `exit` to fall back on.
 * - **stdout ending or breaking** — wired, and see the Windows caveat below for
 *   what that is actually worth.
 * - **stdin breaking** — a write failure, or a stdin that dies with nothing in
 *   flight, under a stdout that stays open and innocent. No other signal
 *   covers either. A stdin that stops being *read* is a different shape and is
 *   not covered here; see below.
 *
 * The exit-shaped diagnostics are strictly better and are given
 * {@link DEFAULT_EXIT_GRACE_MS} to arrive, because stdout always ends first
 * (measured) by about 2 ms. Whichever lands first wins; the rest are ignored.
 *
 * ## ⚠️ Two shapes that are undetectable on Windows
 *
 * Both were measured on Windows 10 / Node 24 against real spawned children, and
 * both are stated here rather than papered over, because the previous round of
 * this comment claimed the first one was covered and it is not.
 *
 * **1. A live child that closes its stdout.** `process.stdout.end()` and
 * `fs.closeSync(1)` were both tried. The parent's `child.stdout` emitted **no
 * `end`, no `close`, no `error` for a full 8 seconds**, with
 * `readableEnded === false` and `destroyed === false` throughout, while the
 * child stayed alive. The `onTransportEnd` path below is therefore dead code on
 * Windows for this shape: it fires when the child *exits* (which closes the
 * pipe from the OS side) and on platforms that report the half-close, not when
 * a running agent hangs up its own stdout. The only in-repo coverage that
 * "passes" for this case is a `PassThrough`-based `SilentChild` stub in
 * `tests/connectProcess.test.ts`, which reproduces the *wiring* and not the
 * platform — `PassThrough.end()` emits `end` immediately, a real pipe does not.
 *
 * **2. A live child that stops reading its stdin.** No error, no `close`, no
 * `EPIPE`, no flag: writes are simply buffered, and the OS pipe absorbs ~64 KiB
 * of them before even that is observable. Measured against a child that never
 * reads: 200-byte writes all called back in 0–1 ms however many were issued, up
 * to 65 400 bytes in total; a single 65 536-byte write called back, a
 * 73 728-byte one did not; a 2 MB write never called back, `writableLength`
 * stuck at 2 097 152, `errored` `null`, `destroyed` `false`, for 8 s. Since an
 * ACP request is ~150 bytes, several hundred of them fit before this shape
 * produces its first observable — see {@link AcpStallReason}.
 *
 * Neither can be turned into a disconnect, so neither is faked. What they are
 * turned into is **visible waiting**: `initialize` and every other bounded call
 * still reject on {@link DEFAULT_REQUEST_TIMEOUT_MS}, and `session/prompt`,
 * whose budget is deliberately `null`, is reported on by
 * {@link AcpAgentHandle.status} and {@link ConnectAcpAgentOptions.onStall}.
 *
 * ⚠️ **That reporting shows the wait; it does not diagnose it.** An earlier
 * version of this paragraph promised that "a UI that renders those cannot leave
 * the user with a spinner that explains nothing", and cited `writePendingMs` as
 * the observable that made shape 2 distinguishable. Both were false: a wedged
 * child and a healthy child taking 6 s produce identical status at every sample
 * (measured, table in {@link AcpConnectionStatus}), and `writePendingMs` stays
 * `null` through hundreds of ACP-sized requests. ACP has no heartbeat, so the
 * honest promise is smaller and it is this: **the UI must show elapsed time and
 * a cancel affordance, and must never treat silence as failure.**
 */
export function connectAcpAgentProcess(
  options: ConnectAcpAgentProcessOptions,
): AcpAgentHandle {
  const { child } = options;
  const { stdin, stdout, stderr } = child;
  if (stdin === null || stdout === null) {
    throw new Error(
      'ACP agent process must be spawned with piped stdin and stdout',
    );
  }
  const label = options.label ?? DEFAULT_LABEL;
  const exitGraceMs = options.exitGraceMs ?? DEFAULT_EXIT_GRACE_MS;

  // Attached before the connection so a crash during the handshake is still
  // quotable. Best effort: on a hard kill the child may die with nothing
  // flushed, and then the exit status is all the diagnostic there is.
  const stderrTail: StderrCapture =
    stderr === null || stderr === undefined
      ? { tail: () => '', missed: () => false }
      : captureTail(stderr);

  let grace: ReturnType<typeof setTimeout> | null = null;
  // Set once a definitive reason has been produced. It stops the stdout grace
  // timer from being armed *after* the fact, which would otherwise hold the
  // host's event loop open for two more seconds to deliver a reason that has
  // already lost — the ordinary case when the child was dead before we
  // connected, since the stream reports EOF only once someone reads it.
  let settledOnAReason = false;
  const stopWaitingForExit = (): void => {
    settledOnAReason = true;
    if (grace === null) return;
    clearTimeout(grace);
    grace = null;
  };

  const failWithExit = (code: number | null, signal: string | null): void => {
    stopWaitingForExit();
    handle.fail(
      new AcpAgentDisconnectedError(
        `${describeExit(label, code, signal)}. ${CONNECTION_DEAD}` +
          `${quoteStderr(label, stderrTail)}`,
        { exitCode: code, signal, stderr: stderrTail.tail() },
      ),
    );
  };

  const handle = connectAcpAgent({
    handlers: options.handlers,
    input: readableFromNodeStream(stdout),
    // No `onError` here on purpose. `writableToNodeStream` errors the stream
    // itself, so the death already reaches `connectAcpAgent`; taking the
    // callback as well would mean two reporters for one event, racing to
    // describe it, and the stream-level one always says less.
    output: writableToNodeStream(stdin),
    label,
    timeouts: options.timeouts,
    ...(options.stallAfterMs === undefined
      ? {}
      : { stallAfterMs: options.stallAfterMs }),
    ...(options.onStall === undefined ? {} : { onStall: options.onStall }),
    // A broken stdin with a live stdout produces no other signal at all — but
    // a dead child's stdin is destroyed along with it, so this also fires for
    // every exit, and "cannot write to agy" is a much worse account of that
    // than "agy exited with code 17". When the process is already gone the
    // exit path owns the diagnostic; it is always armed, either by
    // `child.on('exit')` or by the already-exited check below, so deferring to
    // it cannot lose the failure.
    onTransportWriteError: (error) => {
      if (
        (child.exitCode ?? null) !== null ||
        (child.signalCode ?? null) !== null
      ) {
        return null;
      }
      stopWaitingForExit();
      return new AcpAgentDisconnectedError(
        `cannot write to ${label}: ${error.message}. ${CONNECTION_DEAD}` +
          `${quoteStderr(label, stderrTail)}`,
        { stderr: stderrTail.tail() },
      );
    },
    // The window in which the exit code may still overtake the protocol
    // library's generic "ACP connection closed". Same number as the grace
    // below, because they are waiting for the same event.
    transportEndGraceMs: exitGraceMs,
    // Deferred rather than answered on the spot: a child that is dying is
    // about to say so with an exit code.
    onTransportEnd: (cause) => {
      if (settledOnAReason) return null;
      grace = setTimeout(() => {
        grace = null;
        const what =
          cause === null
            ? // Reached when the pipe really does deliver EOF, which on
              // Windows means the child *exited* — a live child that closes
              // its own stdout delivers nothing (measured; see the warning on
              // this function). The exit path normally wins the race and this
              // wording is what is left when it does not.
              `${label} closed its stdout but is still running`
            : `${label} stdout failed: ${cause.message}`;
        handle.fail(
          new AcpAgentDisconnectedError(
            `${what}. ${CONNECTION_DEAD}${quoteStderr(label, stderrTail)}`,
            { stderr: stderrTail.tail() },
          ),
        );
      }, exitGraceMs);
      return null;
    },
  });

  child.on('exit', (code, signal) => {
    failWithExit(code, signal);
  });

  // Node emits `error` when the process could not be spawned, could not be
  // killed, or could not be written to. A failed spawn emits *only* this —
  // there is no `exit` to fall back on — so it has to fail the connection too.
  child.on('error', (error) => {
    stopWaitingForExit();
    handle.fail(
      new AcpAgentDisconnectedError(
        `${label} failed: ${error.message}. ${CONNECTION_DEAD}` +
          `${quoteStderr(label, stderrTail)}`,
        { stderr: stderrTail.tail() },
      ),
    );
  });

  // The child may already be dead. `exit` fires once and is long gone, so the
  // status is read instead — but not answered instantly: stderr can still have
  // bytes in flight, and its tail is the only thing that explains *why* the
  // agent quit. `whenReadableFinished` fires on a microtask when stderr is
  // already over (the common case), so this costs nothing when there is
  // nothing to wait for.
  const exitCode = child.exitCode ?? null;
  const signalCode = child.signalCode ?? null;
  if (exitCode !== null || signalCode !== null) {
    let answered = false;
    const answer = (): void => {
      if (answered) return;
      answered = true;
      failWithExit(exitCode, signalCode);
    };
    const cap = setTimeout(answer, exitGraceMs);
    const settle = (): void => {
      clearTimeout(cap);
      answer();
    };
    if (stderr === null || stderr === undefined) settle();
    else whenReadableFinished(stderr, settle);
  }

  return handle;
}
