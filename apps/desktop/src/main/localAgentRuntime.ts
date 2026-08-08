import { quoteShellArg } from '@cozypad/contracts';
import type { TerminalOpenRequest } from '@cozypad/contracts';
import type { TmuxSessionInfo } from '@cozypad/tmux-runtime';

/** The slice of the transport this runtime needs, kept small so it is testable. */
export interface LocalPtyHost {
  openTerminal(request: TerminalOpenRequest, command?: string): Promise<string>;
  writeTerminal(terminalId: string, data: Uint8Array): void;
  closeTerminal(terminalId: string): void;
  hasTerminal(terminalId: string): boolean;
}

interface LocalAgentSession {
  id: string;
  name: string;
  cwd: string;
  argv: string[];
  terminalId: string;
  createdEpoch: number;
}

const encoder = new TextEncoder();
/** Mirrors tmux's `sdh_` convention so session names stay recognisable. */
const SESSION_PREFIX = 'sdh_';

/**
 * Runs agent sessions on this machine without tmux.
 *
 * tmux exists on a remote host to keep the agent alive across disconnects and
 * to let a second client attach to it. Neither applies here: the agent's
 * process is a child of CozyPad itself, and its pseudo-console is the pane.
 * So a session is simply a running process, and "attaching" is subscribing to
 * the console it already owns.
 *
 * This deliberately requires nothing to be installed and opens no port — the
 * whole point of running locally is that no daemon, socket, or address is
 * involved.
 */
export class LocalAgentRuntime {
  readonly socketName = 'local';
  private readonly sessions = new Map<string, LocalAgentSession>();
  private nextId = 1;

  constructor(
    private readonly host: LocalPtyHost,
    private readonly size: { cols: number; rows: number } = { cols: 120, rows: 40 },
  ) {}

  private normalize(name: string): string {
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/gu, '_');
    return sanitized.startsWith(SESSION_PREFIX)
      ? sanitized
      : `${SESSION_PREFIX}${sanitized}`;
  }

  /** The console a session is already running in; there is nothing to attach. */
  terminalFor(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.terminalId;
  }

  listSessions(): Promise<TmuxSessionInfo[]> {
    return Promise.resolve(
      [...this.sessions.values()]
        .filter((session) => this.host.hasTerminal(session.terminalId))
        .map((session) => ({
          sessionId: session.id,
          name: session.name,
          createdEpoch: session.createdEpoch,
          attached: true,
        })),
    );
  }

  async newSession(options: {
    name: string;
    cwd: string;
    argv: string[];
  }): Promise<{ sessionId: string; paneId: string; createdEpoch: number }> {
    const name = this.normalize(options.name);
    // Only a *live* session can hold a name: a dead process's entry lingers in
    // the map until killed, and blocking on it would make a session that has
    // exited impossible to revive under its own id.
    if (
      [...this.sessions.values()].some(
        (session) =>
          session.name === name && this.host.hasTerminal(session.terminalId),
      )
    ) {
      throw new Error(`Session already exists: ${name}`);
    }
    const cwd = options.cwd.trim() === '' ? '~' : options.cwd.trim();
    const isCozyPadAgentLaunch =
      options.argv.length === 3 &&
      options.argv[0] !== undefined &&
      options.argv[1] === '-lc' &&
      options.argv[2] !== undefined &&
      options.argv[2].includes('launch-status');
    const command = isCozyPadAgentLaunch && options.argv[0] !== undefined
      ? `cd ${quoteShellArg(cwd)} || exit 1
exec ${quoteShellArg(options.argv[0])} -lc 'while :; do sleep 3600; done'`
      : `cd ${quoteShellArg(cwd)} || exit 1
exec ${options.argv.map((argument) => quoteShellArg(argument)).join(' ')}`;

    const terminalId = await this.host.openTerminal(
      { profileId: 'local-machine', cols: this.size.cols, rows: this.size.rows },
      command,
    );
    // `$N` mirrors tmux's identifier shape so ids stay distinguishable in logs.
    const id = `$local-${this.nextId++}`;
    this.sessions.set(id, {
      id,
      name,
      cwd,
      argv: options.argv,
      terminalId,
      createdEpoch: Math.floor(Date.now() / 1000),
    });
    // One process, one console: the pane and the session are the same thing.
    return { sessionId: id, paneId: id, createdEpoch: Math.floor(Date.now() / 1000) };
  }

  async respawnPane(target: string, argv: string[]): Promise<void> {
    const session = this.require(target);
    this.host.closeTerminal(session.terminalId);
    const isCozyPadAgentLaunch =
      argv.length === 3 &&
      argv[0] !== undefined &&
      argv[1] === '-lc' &&
      argv[2] !== undefined &&
      argv[2].includes('launch-status');
    const command = isCozyPadAgentLaunch && argv[0] !== undefined
      ? `cd ${quoteShellArg(session.cwd)} || exit 1
exec ${quoteShellArg(argv[0])} -lc 'while :; do sleep 3600; done'`
      : `cd ${quoteShellArg(session.cwd)} || exit 1
exec ${argv.map((argument) => quoteShellArg(argument)).join(' ')}`;
    session.terminalId = await this.host.openTerminal(
      { profileId: 'local-machine', cols: this.size.cols, rows: this.size.rows },
      command,
    );
    session.argv = argv;
  }

  private require(target: string): LocalAgentSession {
    const session = this.sessions.get(target);
    if (session === undefined) throw new Error(`Session not found: ${target}`);
    return session;
  }

  private write(target: string, data: string): void {
    const session = this.require(target);
    this.host.writeTerminal(session.terminalId, encoder.encode(data));
  }

  sendText(target: string, text: string, pressEnter = true): Promise<void> {
    this.write(target, pressEnter ? `${text}\r` : text);
    return Promise.resolve();
  }

  interrupt(target: string): Promise<void> {
    this.write(target, '\u0003');
    return Promise.resolve();
  }

  escape(target: string): Promise<void> {
    this.write(target, '\u001b');
    return Promise.resolve();
  }

  hasSession(target: string): Promise<boolean> {
    const session = this.sessions.get(target);
    return Promise.resolve(
      session !== undefined && this.host.hasTerminal(session.terminalId),
    );
  }

  killSession(target: string): Promise<void> {
    const session = this.sessions.get(target);
    if (session === undefined) return Promise.resolve();
    this.sessions.delete(target);
    this.host.closeTerminal(session.terminalId);
    return Promise.resolve();
  }
}
