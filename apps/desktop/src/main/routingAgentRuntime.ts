import type { TmuxSessionInfo, TmuxRuntime } from '@cozypad/tmux-runtime';
import type { LocalAgentRuntime } from './localAgentRuntime';

type Runtime = Pick<
  TmuxRuntime,
  | 'socketName'
  | 'listSessions'
  | 'newSession'
  | 'respawnPane'
  | 'sendText'
  | 'interrupt'
  | 'escape'
  | 'hasSession'
  | 'killSession'
>;

/**
 * Chooses between running agents through tmux on a remote host and running
 * them as plain processes on this machine.
 *
 * tmux earns its place remotely: it keeps the agent alive across a dropped
 * connection and lets a client re-attach. Locally the agent is a child of
 * CozyPad itself, so requiring an install for something the OS already does
 * would be a barrier with nothing behind it.
 *
 * Sessions carry where they live in their id, so a call that names one routes
 * itself; only creating a session needs the active host.
 */
export class RoutingAgentRuntime implements Runtime {
  private local = false;

  constructor(
    private readonly tmux: Runtime,
    private readonly localRuntime: LocalAgentRuntime,
  ) {}

  /** Called when the app connects, since a new session has no id to route by. */
  useLocal(local: boolean): void {
    this.local = local;
  }

  get socketName(): string {
    return this.local ? this.localRuntime.socketName : this.tmux.socketName;
  }

  /** Local session ids are namespaced so they route themselves. */
  private forTarget(target: string): Runtime {
    return target.startsWith('$local-') ? this.localRuntime : this.tmux;
  }

  private get active(): Runtime {
    return this.local ? this.localRuntime : this.tmux;
  }

  /** The console a local session already runs in; remote sessions attach. */
  terminalFor(sessionId: string): string | undefined {
    return sessionId.startsWith('$local-')
      ? this.localRuntime.terminalFor(sessionId)
      : undefined;
  }

  listSessions(): Promise<TmuxSessionInfo[]> {
    return this.active.listSessions();
  }

  newSession(options: {
    name: string;
    cwd: string;
    argv: string[];
  }): Promise<{ sessionId: string; paneId: string; createdEpoch: number }> {
    return this.active.newSession(options);
  }

  respawnPane(target: string, argv: string[]): Promise<void> {
    return this.forTarget(target).respawnPane(target, argv);
  }

  sendText(target: string, text: string, pressEnter?: boolean): Promise<void> {
    return this.forTarget(target).sendText(target, text, pressEnter);
  }

  interrupt(target: string): Promise<void> {
    return this.forTarget(target).interrupt(target);
  }

  escape(target: string): Promise<void> {
    return this.forTarget(target).escape(target);
  }

  hasSession(target: string): Promise<boolean> {
    return this.forTarget(target).hasSession(target);
  }

  killSession(target: string): Promise<void> {
    return this.forTarget(target).killSession(target);
  }
}
