/**
 * Agent sessions that run over ACP instead of a terminal.
 *
 * One spawned child per session, speaking JSON-RPC over its stdio. Everything
 * the screen-scraping path used to infer from a 120×40 grid — who is speaking,
 * whether a tool is running, what the options are — arrives here as a typed
 * message and goes straight into {@link reduceAcpEvent}.
 */
import type { ChatItem } from '@cozypad/contracts';
import type { AcpClientHandlers, AcpSessionEvent } from '@cozypad/acp-client';
import {
  launchSpecFor,
  spawnAcpAgent,
  toLocalPath,
  type AcpChild,
  type AcpLaunchSpec,
} from './acpProcess';
import {
  approvalItemFor,
  defaultClock,
  emptyAcpTimeline,
  reduceAcpEvent,
  settleAcpTimeline,
  type AcpTimelineClock,
  type AcpTimelineState,
} from './acpTimeline';

export interface AcpRuntimeCallbacks {
  /** Called whenever the timeline changed, already coalesced by the caller. */
  onTimeline(sessionId: string, items: readonly ChatItem[]): void;
  /** A permission request the user has to answer. Resolve with an optionId. */
  onPermission(sessionId: string, item: ChatItem): Promise<string | null>;
  onError(sessionId: string, message: string): void;
  /**
   * The agent's slash commands, whenever it announces them.
   *
   * Sent on `session/new` and again whenever they change — a mode switch
   * changes what is offered — so this replaces rather than merges.
   */
  onCommands?(
    sessionId: string,
    commands: readonly { name: string; description?: string }[],
  ): void;
}

/** A control request the agent is blocked on, waiting for the user. */
interface PendingControl {
  // No id here: the map is keyed by it, and carrying a second copy is how the
  // two drift apart.
  resolve(optionId: string | null): void;
}

interface Running {
  readonly child: AcpChild;
  /** The agent's own session id, which is not CozyPad's. */
  acpSessionId: string;
  state: AcpTimelineState;
  readonly clock: AcpTimelineClock;
  /**
   * Every control request currently awaiting an answer, keyed by the id the
   * timeline item carries.
   *
   * A map rather than one slot: an agent running tools in parallel opens more
   * than one permission request at a time, and answering "whichever is
   * pending" sends the user's decision to the wrong tool.
   */
  readonly pending: Map<string, PendingControl>;
}

/**
 * Owns the ACP children for every session in this process.
 *
 * Deliberately separate from `AgentCommunicationService`: that class is the
 * store, the identity model and the tmux path, and mixing a second runtime into
 * it is how the first one became untestable.
 */
/**
 * Turns a JSON-RPC failure into something worth reading.
 *
 * `RequestError: Internal error` is code -32603 and says nothing; the agent's
 * own message rides in `data`, and the ACP SDK keeps it there. This unwraps it
 * so a failed turn names its cause.
 */
function describeAgentError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const rpc = error as Error & { code?: unknown; data?: unknown };
  const parts = [error.message];
  if (typeof rpc.code === 'number') parts.push(`(code ${rpc.code})`);
  const data = rpc.data;
  if (typeof data === 'string' && data !== '') parts.push(data);
  else if (data !== undefined && data !== null) {
    try {
      parts.push(JSON.stringify(data));
    } catch {
      /* a data blob that will not serialise is not worth failing over */
    }
  }
  return parts.join(' — ');
}

export class AcpAgentRuntime {
  readonly #sessions = new Map<string, Running>();

  constructor(
    private readonly callbacks: AcpRuntimeCallbacks,
    /** Injected for tests; production uses a real spawn. */
    private readonly spawn: (
      spec: AcpLaunchSpec,
      handlers: AcpClientHandlers,
    ) => AcpChild = spawnAcpAgent,
  ) {}

  has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  itemsFor(sessionId: string): readonly ChatItem[] {
    return this.#sessions.get(sessionId)?.state.items ?? [];
  }

  /**
   * Starts an agent for a session and opens an ACP session on it.
   *
   * `session/new` is where an agent reports what it can do and which models it
   * offers, so the caller gets that back rather than having to ask again.
   */
  async start(
    sessionId: string,
    rawCwd: string,
    agentKind = 'agy',
    // Translated once, here, so the spawn and the agent agree. Getting this
    // wrong is quiet rather than loud: the child would start in the right place
    // while `--add-dir /c/Users/name` told agy to look somewhere that does not
    // exist on Windows, and it would answer confidently about nothing.
    cwd: string = toLocalPath(rawCwd),
    spec: AcpLaunchSpec = launchSpecFor(agentKind, cwd),
  ): Promise<{ acpSessionId: string; configOptions: unknown }> {
    this.stop(sessionId);

    const clock = defaultClock();
    const handlers: AcpClientHandlers = {
      onSessionUpdate: (event: AcpSessionEvent) => {
        const running = this.#sessions.get(sessionId);
        if (running === undefined) return;
        running.state = reduceAcpEvent(running.state, event, running.clock);
        this.callbacks.onTimeline(sessionId, running.state.items);
      },
      requestPermission: async (request) => {
        const running = this.#sessions.get(sessionId);
        if (running === undefined) return { outcome: { outcome: 'cancelled' } };
        // The card carries every option the agent offered, not a yes/no —
        // claude sends `Always Allow / Allow / Reject`, and in plan mode three
        // options that are not about permission at all.
        const item = approvalItemFor(request as never, running.clock);
        running.state = { ...running.state, items: [...running.state.items, item] };
        this.callbacks.onTimeline(sessionId, running.state.items);

        // Blocks until the user answers. ACP models permission as a request,
        // so the agent is genuinely waiting on this return value — which is
        // also why an unanswered one has to expire rather than hang forever.
        const optionId = await new Promise<string | null>((resolve) => {
          running.pending.set(item.id, {
            resolve: (answer: string | null) => {
              resolve(answer);
            },
          });
          void this.callbacks.onPermission(sessionId, item).then(
            (answer) => {
              if (running.pending.delete(item.id)) resolve(answer);
            },
            () => {
              if (running.pending.delete(item.id)) resolve(null);
            },
          );
        });
        const after = this.#sessions.get(sessionId);
        if (after !== undefined) {
          after.state = {
            ...after.state,
            items: after.state.items.map((existing) =>
              existing.id === item.id && existing.kind === 'approval'
                ? {
                    ...existing,
                    resolution: optionId === null ? 'denied' : 'allowed',
                    ...(optionId === null ? {} : { selectedOptionId: optionId }),
                  }
                : existing,
            ),
          };
          this.callbacks.onTimeline(sessionId, after.state.items);
        }
        return optionId === null
          ? { outcome: { outcome: 'cancelled' } }
          : { outcome: { outcome: 'selected', optionId } };
      },
    };

    const child = this.spawn(spec, handlers);
    const running: Running = {
      child,
      acpSessionId: '',
      state: emptyAcpTimeline(),
      clock,
      pending: new Map(),
    };
    this.#sessions.set(sessionId, running);

    try {
      await child.handle.initialize();
      const opened = await child.handle.newSession({ cwd, mcpServers: [] });
      running.acpSessionId = opened.sessionId;
      return {
        acpSessionId: opened.sessionId,
        configOptions: (opened as unknown as Record<string, unknown>)['configOptions'] ?? [],
      };
    } catch (error) {
      this.stop(sessionId);
      throw error;
    }
  }

  /**
   * Sends one turn and waits for it.
   *
   * `session/prompt` has no timeout by design — a turn takes as long as it
   * takes. The caller is responsible for showing elapsed time and offering
   * cancel; this method just resolves when the agent is done.
   */
  async prompt(sessionId: string, text: string): Promise<string> {
    const running = this.#requireSession(sessionId);
    // CozyPad appends the user's message itself, which is why the reducer
    // discards the agent's replay of it. Both halves of that rule live here.
    running.state = {
      ...running.state,
      items: [
        ...running.state.items,
        {
          kind: 'message',
          id: running.clock.nextId('user'),
          timestamp: running.clock.now(),
          role: 'user',
          text,
        },
      ],
    };
    this.callbacks.onTimeline(sessionId, running.state.items);

    try {
      const response = await running.child.handle.prompt({
        sessionId: running.acpSessionId,
        prompt: [{ type: 'text', text }],
      });
      running.state = settleAcpTimeline(running.state);
      this.callbacks.onTimeline(sessionId, running.state.items);
      return response.stopReason;
    } catch (error) {
      running.state = settleAcpTimeline(running.state);
      this.callbacks.onTimeline(sessionId, running.state.items);
      // JSON-RPC reports an agent-side failure as "Internal error" and puts
      // what actually happened in `data`. Surfacing only the former gives the
      // user a sentence with no information in it — which is exactly what a
      // failed send looked like.
      const detail = describeAgentError(error);
      this.callbacks.onError(sessionId, detail);
      throw new Error(detail, { cause: error });
    }
  }

  /** Asks the agent to stop the current turn. The prompt then resolves. */
  async cancel(sessionId: string): Promise<void> {
    const running = this.#sessions.get(sessionId);
    if (running === undefined || running.acpSessionId === '') return;
    await running.child.handle.cancel({ sessionId: running.acpSessionId });
  }

  /** Pins a model, or any other config option the agent advertised. */
  async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    const running = this.#requireSession(sessionId);
    await running.child.handle.setSessionConfigOption({
      sessionId: running.acpSessionId,
      configId,
      value,
    });
  }

  /**
   * Answers whatever control request the agent is blocked on.
   *
   * `null` declines. Called by the service when the user picks an option, and
   * a no-op when nothing is pending — a late click after a turn ended must not
   * throw.
   */
  resolveControl(
    sessionId: string,
    requestId: string,
    optionId: string | null = null,
  ): void {
    const running = this.#sessions.get(sessionId);
    const pending = running?.pending.get(requestId);
    if (running === undefined || pending === undefined) return;
    running.pending.delete(requestId);
    pending.resolve(optionId);
  }

  /** Seeds a restored transcript so history survives a restart. */
  seed(sessionId: string, items: readonly ChatItem[]): void {
    const running = this.#sessions.get(sessionId);
    if (running === undefined) return;
    running.state = { ...running.state, items: [...items] };
  }

  stop(sessionId: string): void {
    const running = this.#sessions.get(sessionId);
    if (running === undefined) return;
    // Decline anything still open. An unanswered request would otherwise keep
    // a promise — and whatever awaits it — alive after the agent is gone.
    for (const [, pending] of running.pending) pending.resolve(null);
    running.pending.clear();
    running.child.kill();
    this.#sessions.delete(sessionId);
  }

  stopAll(): void {
    for (const sessionId of [...this.#sessions.keys()]) this.stop(sessionId);
  }

  #requireSession(sessionId: string): Running {
    const running = this.#sessions.get(sessionId);
    if (running === undefined) throw new Error(`no ACP agent running for session ${sessionId}`);
    return running;
  }
}
