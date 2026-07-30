import { Client } from 'ssh2';
import type {
  ConnectionProfile,
  ConnectionState,
  TerminalOpenRequest,
} from '@cozypad/contracts';
import type { TransportEvents, TransportPort } from './TransportPort';

/** ssh2 實際型別的最小子集；測試以 fake 實作注入。 */
export interface Ssh2ShellStreamLike {
  on(event: 'data', listener: (chunk: Uint8Array) => void): this;
  on(event: 'close', listener: () => void): this;
  write(data: Uint8Array): void;
  setWindow(rows: number, cols: number, height: number, width: number): void;
  close(): void;
  stderr?: { on(event: 'data', listener: (chunk: Uint8Array) => void): unknown };
}

export interface Ssh2ExecStreamLike {
  on(event: 'data', listener: (chunk: Uint8Array) => void): this;
  on(event: 'close', listener: (code: number | null) => void): this;
  stderr?: { on(event: 'data', listener: (chunk: Uint8Array) => void): unknown };
}

export interface Ssh2ClientLike {
  on(event: 'ready', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  connect(config: Record<string, unknown>): void;
  shell(
    options: { term: string; cols: number; rows: number },
    callback: (error: Error | undefined, stream: Ssh2ShellStreamLike) => void,
  ): void;
  exec(
    command: string,
    callback: (error: Error | undefined, stream: Ssh2ExecStreamLike) => void,
  ): void;
  end(): void;
}

export interface Ssh2TransportOptions {
  getProfile?: (profileId: string) => ConnectionProfile | undefined;
  /** 密碼由 main process 持有，不經過 renderer（SPEC_V3 13）。 */
  getPassword?: (profileId: string) => Promise<string | null> | string | null;
  /** SSH host key 驗證（SPEC_V3 13）；回傳 false 中止連線。 */
  verifyHostKey?: (profile: ConnectionProfile, key: Uint8Array) => Promise<boolean>;
  clientFactory?: () => Ssh2ClientLike;
}

const READY_TIMEOUT_MS = 12_000;
const KEEPALIVE_INTERVAL_MS = 10_000;

export class Ssh2Transport implements TransportPort {
  private events: TransportEvents | null = null;
  private client: Ssh2ClientLike | null = null;
  private wasConnected = false;
  private readonly terminals = new Map<string, Ssh2ShellStreamLike>();
  private nextTerminalId = 1;
  private readonly clientFactory: () => Ssh2ClientLike;

  constructor(private readonly options: Ssh2TransportOptions = {}) {
    this.clientFactory =
      options.clientFactory ?? (() => new Client() as unknown as Ssh2ClientLike);
  }

  setEvents(events: TransportEvents): void {
    this.events = events;
  }

  async connect(profileId: string): Promise<void> {
    const profile = this.options.getProfile?.(profileId);
    if (!profile) throw new Error(`unknown profile: ${profileId}`);
    if (this.client) throw new Error('already connected; disconnect first');

    const password = (await this.options.getPassword?.(profileId)) ?? null;

    this.emitState(profileId, 'connecting');
    const client = this.clientFactory();
    this.client = client;
    this.wasConnected = false;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      client.on('ready', () => {
        settled = true;
        this.wasConnected = true;
        this.emitState(profileId, 'connected');
        resolve();
      });
      client.on('error', (error) => {
        this.emitState(profileId, 'error', error.message);
        if (!settled) {
          settled = true;
          this.client = null;
          reject(error);
        }
      });
      client.on('close', () => {
        this.closeAllTerminals();
        if (this.client === client) {
          this.client = null;
          if (this.wasConnected) this.emitState(profileId, 'disconnected');
          this.wasConnected = false;
        }
      });
      const verifyHostKey = this.options.verifyHostKey;
      client.connect({
        host: profile.host,
        port: profile.port,
        username: profile.username,
        ...(password === null ? {} : { password }),
        readyTimeout: READY_TIMEOUT_MS,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        ...(verifyHostKey === undefined
          ? {}
          : {
              hostVerifier: (key: Uint8Array, done: (valid: boolean) => void) => {
                verifyHostKey(profile, key).then(done, () => done(false));
              },
            }),
      });
    });
  }

  disconnect(): Promise<void> {
    this.client?.end();
    return Promise.resolve();
  }

  exec(command: string, timeoutMs = 15_000): Promise<string> {
    return this.execStream(command, () => undefined, timeoutMs);
  }

  execStream(
    command: string,
    onLine: (line: string) => void,
    timeoutMs = 15_000,
  ): Promise<string> {
    const client = this.client;
    if (!client) return Promise.reject(new Error('not connected'));
    return new Promise((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        const stdout: Uint8Array[] = [];
        const stderr: Uint8Array[] = [];
        let pending = '';
        const timer = setTimeout(
          () => reject(new Error(`remote command timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );

        const emitLines = (chunk: Uint8Array): void => {
          pending += Buffer.from(chunk).toString('utf8');
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) onLine(line);
        };

        stream.on('data', (chunk) => {
          stdout.push(chunk);
          emitLines(chunk);
        });
        stream.stderr?.on('data', (chunk) => stderr.push(chunk));
        stream.on('close', (code) => {
          clearTimeout(timer);
          if (pending !== '') onLine(pending);
          const out = Buffer.concat(stdout.map((chunk) => Buffer.from(chunk))).toString(
            'utf8',
          );
          if (out !== '' || code === 0 || code === null) {
            resolve(out);
            return;
          }
          const err = Buffer.concat(stderr.map((chunk) => Buffer.from(chunk))).toString(
            'utf8',
          );
          reject(new Error(err.trim() === '' ? `command exited with ${code}` : err.trim()));
        });
      });
    });
  }

  async openTerminal(request: TerminalOpenRequest): Promise<string> {
    const client = this.client;
    if (!client) throw new Error('not connected');
    const terminalId = `ssh-term-${this.nextTerminalId++}`;
    const stream = await new Promise<Ssh2ShellStreamLike>((resolve, reject) => {
      client.shell(
        { term: 'xterm-256color', cols: request.cols, rows: request.rows },
        (error, shellStream) => (error ? reject(error) : resolve(shellStream)),
      );
    });
    this.terminals.set(terminalId, stream);
    stream.on('data', (chunk) =>
      this.events?.onTerminalOutput(terminalId, new Uint8Array(chunk)),
    );
    stream.stderr?.on('data', (chunk) =>
      this.events?.onTerminalOutput(terminalId, new Uint8Array(chunk)),
    );
    stream.on('close', () => {
      if (this.terminals.delete(terminalId)) {
        this.events?.onTerminalClosed(terminalId, null);
      }
    });
    return terminalId;
  }

  writeTerminal(terminalId: string, data: Uint8Array): void {
    this.terminals.get(terminalId)?.write(data);
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): void {
    this.terminals.get(terminalId)?.setWindow(rows, cols, 0, 0);
  }

  closeTerminal(terminalId: string): void {
    this.terminals.get(terminalId)?.close();
  }

  dispose(): void {
    this.client?.end();
  }

  private closeAllTerminals(): void {
    for (const terminalId of [...this.terminals.keys()]) {
      this.terminals.delete(terminalId);
      this.events?.onTerminalClosed(terminalId, null, 'connection closed');
    }
  }

  private emitState(profileId: string, state: ConnectionState, error?: string): void {
    this.events?.onConnectionState({
      profileId,
      state,
      ...(error === undefined ? {} : { error }),
    });
  }
}
