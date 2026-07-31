import { Client } from 'ssh2';
import type {
  ConnectionProfile,
  ConnectionState,
  TerminalOpenRequest,
} from '@cozypad/contracts';
import type { TransportEvents, TransportPort } from './TransportPort';
import type { ProfileCredential } from '../profileStore';

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
  /** Secrets are resolved in the main process and never returned to the renderer. */
  getCredential?: (
    profileId: string,
  ) => Promise<ProfileCredential | null> | ProfileCredential | null;
  /** SSH host key 驗證（SPEC_V3 13）；回傳 false 中止連線。 */
  verifyHostKey?: (profile: ConnectionProfile, key: Uint8Array) => Promise<boolean>;
  clientFactory?: () => Ssh2ClientLike;
}

const READY_TIMEOUT_MS = 12_000;
const KEEPALIVE_INTERVAL_MS = 10_000;

export const SSH_ALGORITHMS = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group15-sha512',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group17-sha512',
    'diffie-hellman-group18-sha512',
  ],
  cipher: [
    'aes128-gcm@openssh.com',
    'aes256-gcm@openssh.com',
    'aes128-ctr',
    'aes192-ctr',
    'aes256-ctr',
  ],
  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256',
  ],
  hmac: [
    'hmac-sha2-256-etm@openssh.com',
    'hmac-sha2-512-etm@openssh.com',
    'hmac-sha2-256',
    'hmac-sha2-512',
  ],
} as const;

export class Ssh2Transport implements TransportPort {
  private events: TransportEvents | null = null;
  private client: Ssh2ClientLike | null = null;
  private activeProfileId: string | null = null;
  private connecting = false;
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
    if (
      this.client !== null &&
      this.wasConnected &&
      this.activeProfileId === profileId
    ) {
      // A renderer reload loses its local state while the main-process SSH
      // session remains alive. Re-emit the snapshot instead of rejecting.
      this.emitState(profileId, 'connected');
      return;
    }
    if (this.client !== null || this.connecting) {
      throw new Error('already connected; disconnect first');
    }

    this.connecting = true;
    try {
      const authMethod = profile.authMethod ?? 'password';
      const credential = (await this.options.getCredential?.(profileId)) ?? null;
      if (credential === null || credential.authMethod !== authMethod) {
        throw new Error(
          authMethod === 'privateKey'
            ? 'SSH private key is required'
            : 'SSH password is required',
        );
      }

      this.emitState(profileId, 'connecting');
      const client = this.clientFactory();
      this.client = client;
      this.activeProfileId = profileId;
      this.wasConnected = false;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const fail = (error: Error): void => {
          if (this.client !== client) return;
          const shouldReject = !settled;
          settled = true;
          this.closeAllTerminals();
          this.client = null;
          this.activeProfileId = null;
          this.wasConnected = false;
          this.emitState(profileId, 'error', error.message);
          try {
            client.end();
          } catch {
            // The active reference is already cleared, so retry remains safe.
          }
          if (shouldReject) reject(error);
        };

        client.on('ready', () => {
          if (settled || this.client !== client) return;
          settled = true;
          this.wasConnected = true;
          this.emitState(profileId, 'connected');
          resolve();
        });
        client.on('error', (error) => fail(error));
        client.on('close', () => {
          if (this.client !== client) return;
          this.closeAllTerminals();
          this.client = null;
          this.activeProfileId = null;
          const wasConnected = this.wasConnected;
          this.wasConnected = false;
          if (wasConnected) {
            this.emitState(profileId, 'disconnected');
          } else if (!settled) {
            settled = true;
            const error = new Error('connection closed before ready');
            this.emitState(profileId, 'error', error.message);
            reject(error);
          }
        });
        const verifyHostKey = this.options.verifyHostKey;
        try {
          client.connect({
            host: profile.host,
            port: profile.port,
            username: profile.username,
            ...(credential.authMethod === 'password'
              ? { password: credential.password }
              : {
                  privateKey: credential.privateKey,
                  ...(credential.passphrase === undefined
                    ? {}
                    : { passphrase: credential.passphrase }),
                }),
            readyTimeout: READY_TIMEOUT_MS,
            keepaliveInterval: KEEPALIVE_INTERVAL_MS,
            algorithms: SSH_ALGORITHMS,
            ...(verifyHostKey === undefined
              ? {}
              : {
                  hostVerifier: (key: Uint8Array, done: (valid: boolean) => void) => {
                    verifyHostKey(profile, key).then(done, () => done(false));
                  },
                }),
          });
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } finally {
      this.connecting = false;
    }
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
