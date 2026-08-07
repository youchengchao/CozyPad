import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AcpAgentDisconnectedError,
  AcpRequestTimeoutError,
  PROTOCOL_VERSION,
  connectAcpAgentProcess,
  type AcpAgentHandle,
  type AcpClientHandlers,
  type AcpSessionEvent,
  type AcpStallEvent,
  type NodeChildProcessLike,
} from '../src/index';

/**
 * `connectAcpAgentProcess` is the entry point the desktop main process calls,
 * and the only place a real `ChildProcess` meets this package. These tests
 * spawn actual `node` children rather than fakes, because the two things being
 * checked here are exactly the things a fake would assume away: that Node's
 * `ChildProcess` really does satisfy `NodeChildProcessLike`, and that a child
 * which dies mid-request produces a rejection instead of a promise nobody ever
 * settles.
 *
 * There is exactly one deliberate exception, `SilentChild` below, and its
 * comment explains what was measured before reaching for a stub: the case it
 * covers cannot be produced by a spawned Node child on Windows at all.
 */

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/**
 * The budget for a test that spawns a real process.
 *
 * Starting Node is the one thing in this file that can be slow for reasons
 * that are not bugs — a cold start behind an antivirus scanner, a loaded CI
 * box. At vitest's default 5 s that looks identical to a hang: one run here
 * took 15.25 s and lost three tests, against a 320–450 ms normal, which is
 * three tests × the default timeout almost exactly. The budget below is large
 * enough that only a genuine hang can exhaust it, while the assertions that
 * are *about* hanging carry their own much smaller budgets (see
 * `transport death` in acpClient.test.ts) so a regression still fails fast.
 */
const CHILD_TIMEOUT = 30_000;

const running: ChildProcess[] = [];

/**
 * Spawns a child, registers it for teardown, and waits until it exists.
 *
 * The wait is a real readiness signal, not a sleep: Node emits `spawn` once the
 * OS has handed back a process, and `error` instead if it never will — which
 * `once` turns into a rejection. Waiting here keeps a slow start from being
 * charged to whatever protocol step happens to come next.
 */
async function launch(
  argv: readonly string[],
  stdio: readonly ['pipe' | 'ignore', 'pipe' | 'ignore', 'pipe' | 'ignore'],
): Promise<ChildProcess> {
  const child = spawn(process.execPath, [...argv], { stdio: [...stdio] });
  running.push(child);
  await once(child, 'spawn');
  return child;
}

afterEach(() => {
  for (const child of running.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});

interface Collected {
  handlers: AcpClientHandlers;
  events: AcpSessionEvent[];
}

function collect(): Collected {
  const events: AcpSessionEvent[] = [];
  return {
    events,
    handlers: {
      onSessionUpdate: (event) => {
        events.push(event);
      },
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    },
  };
}

/**
 * Awaits a request that must fail because the agent went away, and returns the
 * diagnostic it failed with. A request that *resolves* fails the test here —
 * silence is the bug, so it cannot be allowed to look like a pass.
 */
async function expectDisconnect(
  request: Promise<unknown>,
): Promise<AcpAgentDisconnectedError> {
  const outcome: unknown = await request.then(
    () => null,
    (error: unknown) => error,
  );
  if (outcome === null) {
    throw new Error('the request resolved, but the agent was supposed to die');
  }
  if (!(outcome instanceof AcpAgentDisconnectedError)) {
    throw new Error(`rejected with ${String(outcome)}, not a disconnect`);
  }
  return outcome;
}

describe('piped-stdio guard', () => {
  it(
    'refuses a process whose stdin was not piped',
    async () => {
      const child = await launch([fixture('echoAgent.mjs')], [
        'ignore',
        'pipe',
        'pipe',
      ]);

      expect(() =>
        connectAcpAgentProcess({ handlers: collect().handlers, child }),
      ).toThrow(
        'ACP agent process must be spawned with piped stdin and stdout',
      );
    },
    CHILD_TIMEOUT,
  );

  it(
    'refuses a process whose stdout was not piped',
    async () => {
      const child = await launch([fixture('echoAgent.mjs')], [
        'pipe',
        'ignore',
        'pipe',
      ]);

      expect(() =>
        connectAcpAgentProcess({ handlers: collect().handlers, child }),
      ).toThrow(
        'ACP agent process must be spawned with piped stdin and stdout',
      );
    },
    CHILD_TIMEOUT,
  );
});

describe('a live child process', () => {
  it('carries a whole session over real pipes', async () => {
    const child = await launch(
      [fixture('echoAgent.mjs')],
      ['pipe', 'pipe', 'pipe'],
    );
    const { handlers, events } = collect();
    const handle = connectAcpAgentProcess({ handlers, child });

    const initialized = await handle.initialize();
    expect(initialized.protocolVersion).toBe(PROTOCOL_VERSION);

    const { sessionId } = await handle.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    expect(sessionId).toBe('fixture-session');

    const turn = await handle.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'ping' }],
    });

    expect(turn.stopReason).toBe('end_turn');
    expect(events.map((event) => event.kind)).toEqual(['agent_message_chunk']);
    const [chunk] = events;
    expect(
      chunk?.kind === 'agent_message_chunk' &&
        chunk.update.content.type === 'text'
        ? chunk.update.content.text
        : null,
    ).toBe('pong');

    // Nothing failed the connection: the agent is still there.
    expect(child.exitCode).toBeNull();
  }, CHILD_TIMEOUT);
});

/**
 * Every test here also exercises a race the fix introduced. Stdout ends
 * *before* `exit` arrives — measured 60/60 on Windows / Node 24, by 1.5–2.2 ms
 * — so the stream-level failure is always armed first and must lose. The
 * assertions on `exitCode` and stderr below are what prove it does.
 */
describe('a child that dies mid-request', () => {
  it('rejects the in-flight request with the exit code and the agent stderr', async () => {
    const child = await launch(
      [fixture('dyingAgent.mjs')],
      ['pipe', 'pipe', 'pipe'],
    );
    const handle = connectAcpAgentProcess({
      handlers: collect().handlers,
      child,
      label: 'agy',
    });

    const failure = await expectDisconnect(handle.initialize());

    expect(failure.exitCode).toBe(17);
    expect(failure.signal).toBeNull();
    expect(failure.message).toContain('agy exited with code 17');
    // The whole point: the message says why, in the agent's own words.
    expect(failure.message).toContain('could not reach the model backend');
    expect(failure.stderr).toContain('agy login');
  }, CHILD_TIMEOUT);

  it('still names the exit code when the agent dies without a word', async () => {
    const child = await launch(
      [fixture('dyingAgent.mjs'), '--silent'],
      ['pipe', 'pipe', 'pipe'],
    );
    const handle = connectAcpAgentProcess({
      handlers: collect().handlers,
      child,
      label: 'agy',
    });

    const failure = await expectDisconnect(handle.initialize());

    expect(failure.exitCode).toBe(17);
    expect(failure.stderr).toBe('');
    expect(failure.message).toContain('agy exited with code 17');
    expect(failure.message).toContain('wrote nothing to stderr');
  }, CHILD_TIMEOUT);

  it('rejects every later request too, instead of hanging again', async () => {
    const child = await launch(
      [fixture('echoAgent.mjs')],
      ['pipe', 'pipe', 'pipe'],
    );
    const { handlers } = collect();
    const handle: AcpAgentHandle = connectAcpAgentProcess({ handlers, child });

    await handle.initialize();
    const { sessionId } = await handle.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    child.kill();
    // `connectAcpAgentProcess` subscribed to `exit` first, so its listener has
    // already run by the time this one resolves.
    await once(child, 'exit');

    const failure = await expectDisconnect(
      handle.prompt({ sessionId, prompt: [{ type: 'text', text: 'ping' }] }),
    );
    expect(failure.signal).toBe('SIGTERM');
    expect(failure.message).toContain('was killed by SIGTERM');
  }, CHILD_TIMEOUT);
});

/**
 * A child that is alive, healthy, and finished talking.
 *
 * This is the gap `exit` and `error` cannot see. Neither event ever fires, so
 * wiring liveness to them alone leaves the turn pending until something
 * outside intervenes — measured at 19841 ms against a 20 s watchdog, ending
 * only because the harness killed the process.
 *
 * It is the one case in this file that a spawned child cannot stand in for,
 * and not for lack of trying: on Windows / Node 24, a child that closes its
 * stdout and keeps running produces **no EOF at the parent at all**.
 * `process.stdout.end()`, `.destroy()`, `process.stdout._handle.close()` and
 * `fs.closeSync(1)` were each given 2 s and none delivered `end`; the
 * "write then end" variant delivered the write and then nothing. Re-measured
 * this round over 8 s against `stdoutClosingAgent.mjs` with the same result —
 * see `shapes that produce no signal at all on Windows` at the bottom of this
 * file, which pins it as an assertion so a future Node cannot change it
 * quietly.
 *
 * ⚠️ **What this stub therefore proves is the wiring, not the platform**, and
 * an earlier version of this comment blurred the two. It said "libuv keeps the
 * pipe's write side open for the life of the process. A real agy or
 * claude-agent-acp binary is under no such constraint." Neither half is
 * supported by what was measured: `fs.closeSync(1)` closes the descriptor
 * outright with no libuv stream involved and still delivered nothing, which
 * points at the Windows pipe-handle model rather than at libuv, and nothing
 * about that is specific to a Node child. Treat the production reachability of
 * this path as **unverified on Windows**; what is verified is that a socket
 * transport reaches it (acpClient.test.ts drives real sockets to EOF) and that
 * the wiring below fires when the EOF does arrive. The user-facing consequence
 * on Windows is covered instead by the request budget and by
 * `AcpAgentHandle.status` — both asserted at the bottom of this file.
 *
 * The stream below is a real Node stream feeding the real
 * `readableFromNodeStream`; only the process around it is stubbed.
 */
class SilentChild implements NodeChildProcessLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  on(
    event: 'exit',
    listener: (code: number | null, signal: string | null) => void,
  ): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(): this {
    // Dropped on purpose. This child never dies, so it never notifies, and a
    // test that quietly invoked these listeners would be asserting the very
    // mechanism it is here to do without.
    return this;
  }
}

describe('a child that stops talking but stays alive', () => {
  it('rejects on the closed stdout, with no exit code to report', async () => {
    const child = new SilentChild();
    const handle = connectAcpAgentProcess({
      handlers: collect().handlers,
      child,
      label: 'agy',
      // No exit is coming, so there is nothing to wait for. The default grace
      // is what the dying-agent tests above exercise.
      exitGraceMs: 0,
    });

    const pending = handle.initialize();

    const stderrDelivered = once(child.stderr, 'data');
    child.stderr.write('agy: the model backend went away\n');
    await stderrDelivered;
    child.stdout.end();

    const failure = await expectDisconnect(pending);

    expect(failure.message).toContain(
      'agy closed its stdout but is still running',
    );
    expect(failure.exitCode).toBeNull();
    expect(failure.signal).toBeNull();
    // Whatever the agent managed to say is still quoted, exactly as it is when
    // the diagnostic comes from an exit code.
    expect(failure.stderr).toContain('the model backend went away');
  }, CHILD_TIMEOUT);
});

describe('a child that never starts', () => {
  it('rejects with the spawn failure rather than waiting for a reply', async () => {
    // No `exit` event is ever emitted for a failed spawn — only `error`.
    const child = spawn('cozypad-no-such-acp-agent', ['--acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    running.push(child);
    const handle = connectAcpAgentProcess({
      handlers: collect().handlers,
      child,
      label: 'cozypad-no-such-acp-agent',
    });

    const failure = await expectDisconnect(handle.initialize());

    expect(failure.message).toContain('cozypad-no-such-acp-agent failed:');
    expect(failure.message).toContain('ENOENT');
    expect(failure.exitCode).toBeNull();
  }, CHILD_TIMEOUT);
});

/**
 * HANG 1, and the one most likely to be hit in production.
 *
 * An agy that is not logged in prints to stderr and exits 17 in single-digit
 * milliseconds. If anything at all happens between `spawn` and this call — a
 * readiness await, a config read, another `await` in the caller — the process
 * is already gone, and Node emits **nothing further**: no `exit`, no `end`, no
 * `close`. Measured window: 0 ms was safe, >= 25 ms was always unreportable,
 * and `initialize()` then stayed pending for 8009 ms until a watchdog fired.
 *
 * The fix is to read `exitCode`/`signalCode` and the stream's terminal flags
 * instead of subscribing and hoping. The delay below is deliberately far past
 * the measured threshold.
 */
describe('a child that was already dead before we connected', () => {
  it(
    'reports the exit code it had already recorded',
    async () => {
      const child = await launch(
        [fixture('deadOnArrivalAgent.mjs')],
        ['pipe', 'pipe', 'pipe'],
      );
      // Long past the 25 ms threshold, and past `exit` too.
      await once(child, 'exit');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(child.exitCode).toBe(17);
      expect(child.stdout?.readableEnded).toBe(true);

      const handle = connectAcpAgentProcess({
        handlers: collect().handlers,
        child,
        label: 'agy',
      });

      const failure = await expectDisconnect(handle.initialize());

      expect(failure.exitCode).toBe(17);
      expect(failure.message).toContain('agy exited with code 17');
    },
    CHILD_TIMEOUT,
  );

  it(
    'says plainly that the stderr was missed rather than implying silence',
    async () => {
      const child = await launch(
        [fixture('deadOnArrivalAgent.mjs')],
        ['pipe', 'pipe', 'pipe'],
      );
      await once(child, 'exit');
      await new Promise((resolve) => setTimeout(resolve, 100));

      const handle = connectAcpAgentProcess({
        handlers: collect().handlers,
        child,
        label: 'agy',
      });

      const failure = await expectDisconnect(handle.initialize());

      // The agent *did* explain itself; nobody was listening. Reporting that as
      // "wrote nothing to stderr" would send the reader hunting for a silent
      // crash that never happened.
      expect(failure.stderr).toBe('');
      expect(failure.message).toContain(
        'had already finished before this connection was made',
      );
      expect(failure.message).not.toContain('wrote nothing to stderr');
    },
    CHILD_TIMEOUT,
  );

  it(
    'still catches the agent that dies between spawn and connect with no delay at all',
    async () => {
      // The zero-delay case takes the ordinary `exit` path, and must keep the
      // stderr it can still capture. Both paths, one fixture.
      const child = await launch(
        [fixture('deadOnArrivalAgent.mjs')],
        ['pipe', 'pipe', 'pipe'],
      );
      const handle = connectAcpAgentProcess({
        handlers: collect().handlers,
        child,
        label: 'agy',
      });

      const failure = await expectDisconnect(handle.initialize());

      expect(failure.exitCode).toBe(17);
      expect(failure.stderr).toContain('not logged in');
    },
    CHILD_TIMEOUT,
  );
});

/**
 * HANG 3. The request bytes leave, then stdin breaks, and stdout stays open and
 * innocent — no EOF, no exit, nothing for any death-shaped signal to notice.
 * Measured before the fix: 6007 ms and ended only by a watchdog.
 */
describe('a child whose stdin breaks under a healthy stdout', () => {
  it(
    'rejects the request that was already on the wire',
    async () => {
      const child = await launch(
        [fixture('muteAgent.mjs')],
        ['pipe', 'pipe', 'pipe'],
      );
      const handle = connectAcpAgentProcess({
        handlers: collect().handlers,
        child,
        label: 'agy',
        // No timeout, so the only thing that can end this test is the fix.
        timeouts: { default: null },
      });

      const pending = handle.initialize();
      // The bytes really left before stdin was broken.
      await vi.waitFor(() => {
        expect(child.stdin?.writableLength).toBe(0);
      });
      child.stdin?.destroy();

      const failure = await expectDisconnect(pending);

      expect(failure.message).toContain('cannot write to agy');
      // The diagnostic is the process-aware one, not the bare stream-level
      // reason: only this path can quote the agent, and there are two things
      // that can report a broken sink now that the stream errors itself.
      expect(failure.message).toContain('wrote nothing to stderr');
      // The agent is alive and well; only the pipe to it is gone.
      expect(child.exitCode).toBeNull();
    },
    CHILD_TIMEOUT,
  );

  it(
    'rejects a write to a stdin that was already broken',
    async () => {
      const child = await launch(
        [fixture('muteAgent.mjs')],
        ['pipe', 'pipe', 'pipe'],
      );
      child.stdin?.destroy();
      await once(child.stdin!, 'close');

      const handle = connectAcpAgentProcess({
        handlers: collect().handlers,
        child,
        label: 'agy',
        timeouts: { default: null },
      });

      const failure = await expectDisconnect(handle.initialize());
      expect(failure.message).toContain('cannot write to agy');
    },
    CHILD_TIMEOUT,
  );
});

/**
 * A child that is **already gone** when its stdin is found to be broken.
 *
 * Both facts are true at once here, and they produce two different diagnostics:
 * the stream knows only that it closed, while the process knows it exited 17
 * and knows what it printed on the way out. `onTransportWriteError` exists to
 * make the second one win, by deferring whenever `exitCode`/`signalCode` is
 * already set.
 *
 * The second stub in this file, for the same reason as {@link SilentChild}:
 * with a spawned child the two reporters are separated by microseconds and
 * whichever wins is a coin toss — measured by deleting the deferral entirely,
 * which left the suite fully green. A test that passes because of scheduling
 * luck is not guarding anything. Below, the child has *definitively* exited
 * before the connection is made, so the outcome is determined by the code
 * rather than by the clock.
 */
class ExitedChildWithBrokenStdin implements NodeChildProcessLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exitCode = 17;
  readonly signalCode = null;

  on(
    event: 'exit',
    listener: (code: number | null, signal: string | null) => void,
  ): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(): this {
    // The process exited before this object was handed over. `exit` fired long
    // ago, if it fired at all, and Node will not repeat it — which is the whole
    // reason `exitCode` is read rather than awaited.
    return this;
  }
}

describe('a child that exited before its stdin was found to be broken', () => {
  it(
    'reports the exit code, not the broken pipe that noticed it first',
    async () => {
      const child = new ExitedChildWithBrokenStdin();
      // A dead child's stdin is destroyed along with it. This is what makes the
      // write half fail, and it fails on a microtask — immediately.
      child.stdin.destroy();
      await once(child.stdin, 'close');

      const handle = connectAcpAgentProcess({
        handlers: collect().handlers,
        child,
        label: 'agy',
        timeouts: { default: null },
      });

      const pending = handle.initialize();

      // Stderr is still in flight, and is released only *after* the write half
      // has already failed. That ordering is the whole test. Measured with the
      // deferral removed: ending stderr first lets the exit path win the
      // microtask race anyway and the mutant survives, so a fixture that
      // pre-drains stderr proves nothing. With bytes still to come — the
      // reason the exit path waits for stderr at all — the broken pipe is
      // genuinely first, and only the deferral makes it lose.
      setTimeout(() => {
        child.stderr.end('agy: not logged in, run `agy login`\n');
        child.stderr.resume();
      }, 30);

      const failure = await expectDisconnect(pending);

      expect(failure.message).toContain('agy exited with code 17');
      expect(failure.exitCode).toBe(17);
      // The stream-level account is strictly worse and must lose: it names no
      // agent, no exit code, and nothing the agent said. This exact string is
      // what the mutant produces.
      expect(failure.message).not.toContain('cannot write to agy');
      expect(failure.message).not.toContain('closed before it was ended');
      // And the deferral is what keeps the agent's own last words attached.
      expect(failure.stderr).toContain('not logged in');
    },
    CHILD_TIMEOUT,
  );

  it(
    'still reports a broken stdin as such while the child is alive',
    async () => {
      // The other side of the same branch. Deferring unconditionally would be
      // just as wrong: with no exit coming, nothing else would ever answer.
      const child = new SilentChild();
      child.stdin.destroy();
      await once(child.stdin, 'close');

      const handle = connectAcpAgentProcess({
        handlers: collect().handlers,
        child,
        label: 'agy',
        timeouts: { default: null },
      });

      const failure = await expectDisconnect(handle.initialize());

      expect(failure.message).toContain('cannot write to agy');
      expect(failure.exitCode).toBeNull();
    },
    CHILD_TIMEOUT,
  );
});

/**
 * The agent that is alive, connected, and mute. No stream ends and no process
 * exits, so nothing in this file's other machinery can help — the timeout is
 * the only thing between this and a spinner that never stops.
 */
describe('a child that answers nothing', () => {
  it(
    'gives up on the request after its budget',
    async () => {
      const child = await launch(
        [fixture('muteAgent.mjs')],
        ['pipe', 'pipe', 'pipe'],
      );
      const handle = connectAcpAgentProcess({
        handlers: collect().handlers,
        child,
        label: 'agy',
        timeouts: { default: 150 },
      });

      const failure: unknown = await handle.initialize().then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(AcpRequestTimeoutError);
      expect((failure as AcpRequestTimeoutError).method).toBe('initialize');
      // Still alive. A timeout is not a death, and must not be reported as one.
      expect(child.exitCode).toBeNull();
    },
    CHILD_TIMEOUT,
  );
});

/**
 * ⚠️ THE TWO WINDOWS BLIND SPOTS, pinned as measurements.
 *
 * Neither of the shapes below can be turned into a disconnect on Windows, and
 * the tests here exist to say so out loud rather than to prove a fix. They are
 * written as measurements of the platform: if a future Node starts reporting
 * either one, these fail, and the comments on `connectAcpAgentProcess` that
 * currently say "undetectable" have to be rewritten.
 *
 * What *is* asserted as behaviour is the second half — that neither shape
 * leaves the user with nothing to look at. That is the whole reason
 * `AcpAgentHandle.status` and `onStall` exist.
 */
describe('shapes that produce no signal at all on Windows', () => {
  it(
    'MEASUREMENT: a live child closing its stdout emits no end, close or error',
    async () => {
      const child = await launch(
        [fixture('stdoutClosingAgent.mjs')],
        ['pipe', 'pipe', 'pipe'],
      );
      const stdout = child.stdout;
      if (stdout === null) throw new Error('spawned without a piped stdout');

      const seen: string[] = [];
      for (const event of ['end', 'close', 'error'] as const) {
        stdout.on(event, () => seen.push(event));
      }
      // A real readiness signal: the fixture writes this *after* closing
      // stdout, so the close has definitely already happened.
      await vi.waitFor(
        async () => {
          const [chunk] = (await once(child.stderr!, 'data')) as [Buffer];
          expect(chunk.toString()).toContain('stdout closed');
        },
        { timeout: 5_000, interval: 10 },
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      // The measurement. `process.stdout.end()` in the child, a full second
      // ago, and the parent's stream is none the wiser.
      expect(seen).toEqual([]);
      expect(stdout.readableEnded).toBe(false);
      expect(stdout.destroyed).toBe(false);
      expect(child.exitCode).toBeNull();
    },
    CHILD_TIMEOUT,
  );

  it(
    'falls back to the request budget when the stdout close is invisible',
    async () => {
      // What the user actually gets in that case. Not a disconnect — this
      // library will not claim a death it cannot see — but a bounded, named
      // failure rather than a spinner.
      const child = await launch(
        [fixture('stdoutClosingAgent.mjs')],
        ['pipe', 'pipe', 'pipe'],
      );
      const handle = connectAcpAgentProcess({
        handlers: collect().handlers,
        child,
        label: 'agy',
        timeouts: { default: 200 },
      });

      const failure: unknown = await handle.initialize().then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(AcpRequestTimeoutError);
      expect(child.exitCode).toBeNull();
    },
    CHILD_TIMEOUT,
  );

  it(
    'MEASUREMENT: a child that stops reading stdin produces no error, and the write never completes',
    async () => {
      const child = await launch(
        [fixture('deafAgent.mjs')],
        ['pipe', 'pipe', 'pipe'],
      );
      const stdin = child.stdin;
      if (stdin === null) throw new Error('spawned without a piped stdin');

      const settled: string[] = [];
      const failures: string[] = [];
      stdin.on('error', (error: Error) => failures.push(error.message));
      // Big enough to outrun any pipe buffer. The measured shape is that the
      // callback simply never arrives.
      stdin.write(Buffer.alloc(2 * 1024 * 1024, 0x62), () =>
        settled.push('big'),
      );
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      expect(settled).toEqual([]);
      expect(failures).toEqual([]);
      expect(stdin.destroyed).toBe(false);
      expect(stdin.errored).toBeNull();
      expect(child.exitCode).toBeNull();
    },
    CHILD_TIMEOUT,
  );

  it(
    'reports an unaccepted write on an unbounded prompt, which nothing else can',
    async () => {
      // The forever-spinner, exactly: `session/prompt` ships with a `null`
      // budget on purpose, the child is alive so no death-shaped signal fires,
      // and the request will therefore never settle. The contract is not that
      // it settles — it is that the wait is *described* while it happens.
      const child = await launch(
        [fixture('deafAgent.mjs')],
        ['pipe', 'pipe', 'pipe'],
      );
      const stalls: AcpStallEvent[] = [];
      const handle = connectAcpAgentProcess({
        handlers: collect().handlers,
        child,
        label: 'agy',
        timeouts: { default: null, prompt: null },
        stallAfterMs: 150,
        onStall: (event) => stalls.push(event),
      });

      // Large enough that the write cannot be absorbed by a pipe buffer, which
      // is what makes `write-not-accepted` the reported reason rather than the
      // weaker `awaiting-reply`.
      //
      // The rejection is swallowed rather than awaited: this request never
      // settles on its own, and the teardown below is what finally fails it.
      // Left unhandled it surfaces as a process-level unhandled rejection and
      // fails an unrelated test.
      const turn = handle.prompt({
        sessionId: 'sess-1',
        prompt: [{ type: 'text', text: 'x'.repeat(4 * 1024 * 1024) }],
      });
      turn.catch(() => undefined);

      // The *first* tick lands one `stallAfterMs` after the request was issued
      // and the write begins microseconds later, so `writePendingMs` is a hair
      // under the threshold and the first report is the weaker
      // `awaiting-reply`. Measured, not assumed — hence waiting for the
      // stronger reason rather than asserting it on `stalls[0]`.
      await vi.waitFor(
        () => {
          expect(
            stalls.some((event) => event.reason === 'write-not-accepted'),
          ).toBe(true);
        },
        { timeout: 8_000, interval: 25 },
      );

      const first = stalls[0]!;
      expect(first.method).toBe('session/prompt');
      expect(first.label).toBe('agy');
      expect(first.stalled).toBe(true);
      // Every report, from the first one on, knows the bytes are still stuck in
      // the transport — which is the fact no other signal in this file has.
      expect(first.writePendingMs).not.toBeNull();
      const blamed = stalls.find(
        (event) => event.reason === 'write-not-accepted',
      )!;
      expect(blamed.writePendingMs).toBeGreaterThanOrEqual(150);

      // And the same facts are readable without any subscription, which is what
      // makes them available on the default configuration.
      const status = handle.status();
      expect(status.alive).toBe(true);
      expect(status.outstanding).toHaveLength(1);
      expect(status.outstanding[0]?.method).toBe('session/prompt');
      expect(status.outstanding[0]?.writePendingMs).not.toBeNull();
      // Nothing ever arrived from this agent, which is different from "it went
      // quiet" and is reported as such.
      expect(status.silentMs).toBeNull();

      // Still alive, still not failed. A stall is a report, not a verdict.
      expect(child.exitCode).toBeNull();
      handle.fail(new Error('test over'));
    },
    CHILD_TIMEOUT,
  );

  it(
    'MEASUREMENT: what a deaf child accepts is set by the pipe buffer, not by which write it is',
    async () => {
      // Three rounds of comments in this package have asserted that the *first*
      // small write to a deaf child completes and later ones do not — "the
      // first 200-byte write called back in 2 ms, the next two never called
      // back at all". It is not true, and the shape of the falsehood matters:
      // it makes a deaf agent sound detectable after two requests, when in fact
      // it absorbs several hundred. This test is here so the claim cannot come
      // back a fifth time.
      const child = await launch(
        [fixture('deafAgent.mjs')],
        ['pipe', 'pipe', 'pipe'],
      );
      const stdin = child.stdin;
      if (stdin === null) throw new Error('spawned without a piped stdin');
      stdin.on('error', () => undefined);

      const small: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        stdin.write(Buffer.alloc(200, 0x61), () => small.push(i));
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      // Every one of them, not just the first.
      expect(small.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
      expect(stdin.writableLength).toBe(0);
      expect(stdin.errored).toBeNull();
      expect(child.exitCode).toBeNull();

      // And the real rule, bracketed rather than pinned to the exact edge:
      // ~64 KiB goes through, an order of magnitude more does not.
      const fits = await launch(
        [fixture('deafAgent.mjs')],
        ['pipe', 'pipe', 'pipe'],
      );
      fits.stdin?.on('error', () => undefined);
      let fitted = false;
      fits.stdin?.write(Buffer.alloc(65_536, 0x61), () => (fitted = true));

      const overflows = await launch(
        [fixture('deafAgent.mjs')],
        ['pipe', 'pipe', 'pipe'],
      );
      overflows.stdin?.on('error', () => undefined);
      let overflowed = false;
      overflows.stdin?.write(
        Buffer.alloc(131_072, 0x61),
        () => (overflowed = true),
      );

      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(fitted).toBe(true);
      expect(overflowed).toBe(false);
    },
    CHILD_TIMEOUT,
  );
});

/**
 * The limit of what `status()` can tell a UI, pinned as a test.
 *
 * `connect.ts` used to promise that "a UI that renders those cannot leave the
 * user with a spinner that explains nothing". It can, and the desktop turn UI
 * must not be built on the opposite belief, so the disproof lives here rather
 * than only in a comment that the next round can quietly reword.
 *
 * The two children below are the same fixture with one different argument.
 */
describe('a wedged agent and a slow one are the same picture', () => {
  /** Everything a turn UI could read about an in-flight prompt. */
  interface Shape {
    reason: string;
    writePendingNull: boolean;
    stalled: boolean;
    outstanding: number;
  }

  async function promptAndSample(
    replyAfterMs: number | null,
  ): Promise<{ shape: Shape; settled: Promise<string>; handle: AcpAgentHandle }> {
    const child = await launch(
      [
        fixture('pacedAgent.mjs'),
        ...(replyAfterMs === null ? [] : [String(replyAfterMs)]),
      ],
      ['pipe', 'pipe', 'pipe'],
    );
    child.stdin?.on('error', () => undefined);
    const handle = connectAcpAgentProcess({
      handlers: collect().handlers,
      child,
      label: 'agy',
      stallAfterMs: 300,
    });
    await handle.initialize();
    await handle.newSession({ cwd: process.cwd(), mcpServers: [] });

    const settled = handle
      .prompt({ sessionId: 'paced-session', prompt: [{ type: 'text', text: 'hi' }] })
      .then(
        () => 'resolved',
        (error: unknown) => `rejected: ${(error as Error).message}`,
      );
    settled.catch(() => undefined);

    // Well past `stallAfterMs`, well short of the slow agent's reply.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const status = handle.status();
    const request = status.outstanding.find(
      (entry) => entry.method === 'session/prompt',
    );
    if (request === undefined) throw new Error('the prompt already settled');
    return {
      shape: {
        reason: request.reason,
        writePendingNull: request.writePendingMs === null,
        stalled: request.stalled,
        outstanding: status.outstanding.length,
      },
      settled,
      handle,
    };
  }

  it(
    'MEASUREMENT: status() cannot tell them apart while the turn is running',
    async () => {
      const wedged = await promptAndSample(null);
      const slow = await promptAndSample(3_000);

      // The disproof. Not "similar" — identical, field for field.
      expect(wedged.shape).toEqual(slow.shape);
      // And specifically: the field that was sold as the discriminator is null
      // for both, because a ~40-byte prompt never fills a 64 KiB pipe.
      expect(wedged.shape.writePendingNull).toBe(true);
      expect(slow.shape.writePendingNull).toBe(true);
      expect(wedged.shape.reason).toBe('awaiting-reply');

      // The only thing that ever separates them is the reply itself arriving —
      // which is the event the UI was waiting for in the first place, so it
      // cannot serve as advance warning of anything.
      expect(
        await Promise.race([
          slow.settled,
          new Promise((resolve) => setTimeout(() => resolve('HUNG'), 5_000)),
        ]),
      ).toBe('resolved');
      expect(
        await Promise.race([
          wedged.settled,
          new Promise((resolve) => setTimeout(() => resolve('HUNG'), 500)),
        ]),
      ).toBe('HUNG');

      wedged.handle.fail(new Error('test over'));
    },
    CHILD_TIMEOUT,
  );
});
